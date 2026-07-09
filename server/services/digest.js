import cron from 'node-cron';
import {
    snapshotCache, pepwaveCache, dailyEnergy, trailerJobSiteMap, dbAvailable,
} from '../state.js';
import { getPool, getUsers, getUpcomingMaintenance } from '../db.js';
import { computeAlerts } from './alerts.js';
import { sendDigestEmail, isEmailConfigured } from '../email.js';
import { todayStr, hasVrmData } from '../lib/util.js';

// --- Enhanced Digest ---
export async function buildDigestData() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    // Get HQ job sites and deployed trailers
    const hqJobSiteIds = new Set();
    let deployedTrailerCount = 0;
    const trailerJobSites = new Map();

    if (dbAvailable) {
        try {
            const hqResult = await db.query(`SELECT id FROM job_sites WHERE is_headquarters = true`);
            hqResult.rows.forEach(row => hqJobSiteIds.add(row.id));

            const deployedResult = await db.query(`
                SELECT COUNT(DISTINCT ta.site_id)
                FROM trailer_assignments ta
                LEFT JOIN job_sites js ON ta.job_site_id = js.id
                WHERE ta.job_site_id IS NOT NULL
                AND (js.is_headquarters IS NULL OR js.is_headquarters = false)
            `);
            deployedTrailerCount = parseInt(deployedResult.rows[0].count) || 0;

            const assignResult = await db.query(`SELECT site_id, job_site_id FROM trailer_assignments WHERE job_site_id IS NOT NULL`);
            assignResult.rows.forEach(row => trailerJobSites.set(row.site_id, row.job_site_id));
        } catch (err) {
            console.error('  Failed to fetch job site data:', err.message);
        }
    }

    // Count IC2-only trailers (have Pepwave but no VRM data)
    let ic2OnlyCount = 0;
    for (const [deviceName, pw] of pepwaveCache) {
        if (!snapshotCache.has(pw.site_id || deviceName)) {
            const jobSiteId = trailerJobSites.get(pw.site_id);
            if (!jobSiteId || !hqJobSiteIds.has(jobSiteId)) {
                ic2OnlyCount++;
            }
        }
    }

    const vrmTrailerCount = deployedTrailerCount - ic2OnlyCount;

    // === YESTERDAY'S COMPLETE METRICS ===
    let yesterdayData = {
        avg_eod_soc: 0,
        total_yield_kwh: 0,
        total_data_gb: 0,
        trailers_with_data: 0
    };

    if (dbAvailable) {
        try {
            // Yesterday's EOD SOC and yield from daily_energy_summary
            const energyResult = await db.query(`
                SELECT
                    AVG(soc_start_of_day) as avg_soc,
                    SUM(yield_wh) / 1000.0 as total_yield_kwh,
                    COUNT(*) as trailer_count
                FROM daily_energy_summary
                WHERE date = $1
            `, [yesterdayStr]);

            if (energyResult.rows[0]) {
                yesterdayData.avg_eod_soc = parseFloat(energyResult.rows[0].avg_soc) || 0;
                yesterdayData.total_yield_kwh = parseFloat(energyResult.rows[0].total_yield_kwh) || 0;
                yesterdayData.trailers_with_data = parseInt(energyResult.rows[0].trailer_count) || 0;
            }

            // Yesterday's network data usage
            const networkResult = await db.query(`
                SELECT SUM(usage_mb) / 1024.0 as total_gb
                FROM pepwave_snapshots
                WHERE timestamp >= extract(epoch from date $1) * 1000
                AND timestamp < extract(epoch from (date $1 + interval '1 day')) * 1000
            `, [yesterdayStr]);

            if (networkResult.rows[0]) {
                yesterdayData.total_data_gb = parseFloat(networkResult.rows[0].total_gb) || 0;
            }
        } catch (err) {
            console.error('  Failed to fetch yesterday data:', err.message);
        }
    }

    // === CURRENT STATUS (for actionable items) ===
    const currentTrailers = [];
    const currentLowSoc = [];
    const currentCritical = [];
    const currentWatch = [];

    for (const [siteId, snapshot] of snapshotCache) {
        const jobSiteId = trailerJobSites.get(siteId);
        if (jobSiteId && hqJobSiteIds.has(jobSiteId)) continue;
        if (!hasVrmData(snapshot)) continue;

        currentTrailers.push({
            site_id: siteId,
            site_name: snapshot.site_name,
            battery_soc: snapshot.battery_soc,
            solar_yield_today: snapshot.solar_yield_today,
            alarm_reason: snapshot.alarm_reason,
            error_code: snapshot.error_code
        });

        // Critical items (dispatch now)
        if (snapshot.battery_soc != null && snapshot.battery_soc < 20) {
            currentCritical.push({
                type: 'low_soc',
                trailer: snapshot.site_name,
                soc: snapshot.battery_soc,
                severity: 'critical'
            });
        }
        if (snapshot.alarm_reason || snapshot.error_code) {
            currentCritical.push({
                type: 'alarm',
                trailer: snapshot.site_name,
                message: snapshot.alarm_reason || snapshot.error_code,
                severity: 'critical'
            });
        }

        // Watch items
        if (snapshot.battery_soc != null && snapshot.battery_soc >= 20 && snapshot.battery_soc < 40) {
            currentWatch.push({
                type: 'low_soc',
                trailer: snapshot.site_name,
                soc: snapshot.battery_soc
            });
        }

        if (snapshot.battery_soc != null && snapshot.battery_soc < 50) {
            currentLowSoc.push({
                site_name: snapshot.site_name,
                battery_soc: snapshot.battery_soc
            });
        }
    }

    const currentOnlineCount = currentTrailers.filter(t => t.battery_soc != null).length;
    const currentAvgSoc = currentOnlineCount > 0
        ? currentTrailers.reduce((s, t) => s + (t.battery_soc || 0), 0) / currentOnlineCount : 0;

    // Add energy deficit alerts to watch list
    // Note: streak_days only counts REAL deficits (throttled deficits excluded by computeAlerts)
    const alerts = computeAlerts();
    alerts.filter(a => a.streak_days >= 5).forEach(a => {
        currentWatch.push({
            type: 'energy_deficit',
            trailer: a.site_name,
            streak_days: a.streak_days,
            severity: a.severity,
            has_throttled: a.deficit_days.some(d => d.throttled),  // NEW: transparency
        });
    });

    currentLowSoc.sort((a, b) => a.battery_soc - b.battery_soc);

    // === TOP/BOTTOM PERFORMERS (Yesterday) ===
    const performers = [];
    if (dbAvailable) {
        try {
            const perfResult = await db.query(`
                SELECT
                    site_name,
                    yield_wh / 1000.0 as yield_kwh,
                    expected_yield_wh / 1000.0 as expected_kwh,
                    CASE
                        WHEN expected_yield_wh > 0 THEN (yield_wh::float / expected_yield_wh * 100)
                        ELSE 0
                    END as percent
                FROM daily_energy_summary
                WHERE date = $1
                AND expected_yield_wh > 0
                ORDER BY percent DESC
            `, [yesterdayStr]);

            performers.push(...perfResult.rows.map(r => ({
                site_name: r.site_name,
                yield_kwh: parseFloat(r.yield_kwh) || 0,
                expected_kwh: parseFloat(r.expected_kwh) || 0,
                percent: parseFloat(r.percent) || 0
            })));
        } catch (err) {
            console.error('  Failed to fetch performance data:', err.message);
        }
    }

    const topPerformers = performers.filter(p => p.percent >= 100).slice(0, 3);
    const underperformers = performers.filter(p => p.percent < 70).slice(0, 3);

    // === NETWORK SUMMARY (Yesterday) ===
    let networkSummary = {
        avg_signal_dbm: 0,
        total_data_gb: yesterdayData.total_data_gb,
        high_usage: [],
        poor_signal: []
    };

    if (dbAvailable) {
        try {
            const netResult = await db.query(`
                SELECT
                    AVG(rsrp) as avg_signal,
                    device_name,
                    SUM(usage_mb) / 1024.0 as total_gb
                FROM pepwave_snapshots
                WHERE timestamp >= extract(epoch from date $1) * 1000
                AND timestamp < extract(epoch from (date $1 + interval '1 day')) * 1000
                GROUP BY device_name
                HAVING SUM(usage_mb) > 500
                ORDER BY total_gb DESC
                LIMIT 5
            `, [yesterdayStr]);

            networkSummary.high_usage = netResult.rows.map(r => ({
                device: r.device_name,
                usage_gb: parseFloat(r.total_gb) || 0
            }));

            const signalResult = await db.query(`
                SELECT AVG(rsrp) as avg_signal
                FROM pepwave_snapshots
                WHERE timestamp >= extract(epoch from date $1) * 1000
                AND timestamp < extract(epoch from (date $1 + interval '1 day')) * 1000
            `, [yesterdayStr]);

            if (signalResult.rows[0]) {
                networkSummary.avg_signal_dbm = parseFloat(signalResult.rows[0].avg_signal) || 0;
            }
        } catch (err) {
            console.error('  Failed to fetch network summary:', err.message);
        }
    }

    return {
        // Fleet summary
        fleet_size: deployedTrailerCount || currentTrailers.length,
        fleet_breakdown: { vrm: vrmTrailerCount, ic2_only: ic2OnlyCount },

        // Yesterday's complete metrics
        yesterday: {
            avg_eod_soc: yesterdayData.avg_eod_soc,
            total_yield_kwh: yesterdayData.total_yield_kwh,
            total_data_gb: yesterdayData.total_data_gb,
            trailers_reporting: yesterdayData.trailers_with_data
        },

        // Current status
        current: {
            online: currentOnlineCount,
            total: deployedTrailerCount || currentTrailers.length,
            avg_soc: currentAvgSoc,
            low_soc_trailers: currentLowSoc.slice(0, 10)
        },

        // Needs attention
        critical_items: currentCritical,
        watch_items: currentWatch.slice(0, 10),

        // Performance
        top_performers: topPerformers,
        underperformers: underperformers,

        // Network
        network: networkSummary,

        // Alerts (for compatibility)
        active_alerts: alerts,
        trailers_below_50_soc: currentLowSoc.slice(0, 10)
    };
}

export function scheduleDigest() {
    const enabled = process.env.DIGEST_ENABLED === 'true';
    if (!enabled) {
        console.log('  Digest scheduling disabled (set DIGEST_ENABLED=true)');
        return;
    }
    const time = process.env.DIGEST_TIME || '06:00';
    const [hour, minute] = time.split(':').map(Number);
    const tz = process.env.DIGEST_TIMEZONE || 'America/Denver';
    const recipients = (process.env.DIGEST_RECIPIENTS || '')
        .split(',').map(e => e.trim()).filter(Boolean);

    if (recipients.length === 0) {
        console.log('  Digest scheduling skipped: no DIGEST_RECIPIENTS configured');
        return;
    }

    const cronExpr = `${minute} ${hour} * * *`;
    cron.schedule(cronExpr, async () => {
        console.log('  Running scheduled digest...');
        try {
            const data = await buildDigestData();
            // Fetch overdue maintenance if DB available
            if (dbAvailable) {
                try {
                    const upcoming = await getUpcomingMaintenance(0);
                    data.overdue_maintenance = upcoming
                        .filter(m => m.scheduled_date < Date.now())
                        .map(m => ({
                            title: m.title,
                            job_site_name: m.job_site_name || 'Unknown',
                            scheduled_date: new Date(m.scheduled_date).toISOString().slice(0, 10),
                        }));
                } catch { }
            }

            // Merge env var recipients with subscribed users
            const allRecipients = [...recipients];
            if (dbAvailable) {
                try {
                    const result = await db.query(`
                        SELECT email FROM users
                        WHERE digest_enabled = true
                        AND email IS NOT NULL
                        AND active = true
                    `);
                    const subscribedEmails = result.rows.map(r => r.email).filter(Boolean);
                    allRecipients.push(...subscribedEmails);
                } catch (err) {
                    console.error('  Failed to fetch subscribed users:', err.message);
                }
            }

            // Deduplicate recipients
            const uniqueRecipients = [...new Set(allRecipients)];

            if (uniqueRecipients.length > 0) {
                await sendDigestEmail(uniqueRecipients, data);
                console.log(`  Digest sent to ${uniqueRecipients.length} recipient(s) (${recipients.length} env, ${uniqueRecipients.length - recipients.length} subscribed)`);
            }
        } catch (err) {
            console.error('  Digest error:', err.message);
        }
    }, { timezone: tz });

    console.log(`  ✓ Digest scheduled at ${time} ${tz} → ${recipients.join(', ')}`);
}
