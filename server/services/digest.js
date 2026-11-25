import cron from 'node-cron';
import { dbAvailable } from '../state.js';
import { getPool, getUsers, getUpcomingMaintenance } from '../db.js';
import { computeAlerts } from './alerts.js';
import { sendDigestEmail, isEmailConfigured } from '../email.js';
import { buildTrailerBoard, summarize } from './board.js';
import { solarScoreConfig } from '../state.js';

// --- Morning digest ---
// Built from the same board rows as the dashboard, so the email and the
// screens always agree: in-service trailers only, one row per physical
// trailer, health and wording decided in services/board.js.
export async function buildDigestData() {
    const db = getPool();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const rows = await buildTrailerBoard();
    const summary = summarize(rows);
    const fleet = rows.filter(r => r.in_service);
    const item = (r) => ({
        type: r.health, trailer: r.unit, reason: r.diagnosis || '',
        site: r.site?.name || null, customer: r.customer?.name || null, soc: r.soc, last_seen: r.last_seen,
    });

    // Dispatch now: dark or faulted. Watch: trending the wrong way, or can't be monitored.
    const criticalItems = fleet.filter(r => r.health === 'offline' || r.health === 'attention').map(item);
    const watchItems = fleet.filter(r => r.health === 'watch' || r.health === 'unknown').map(item);

    const live = fleet.filter(r => r.soc != null);
    const reporting = fleet.filter(r => r.soc != null || (!r.has_cerbo && r.online)).length;
    const avgSoc = live.length ? live.reduce((s, r) => s + r.soc, 0) / live.length : 0;
    const lowSoc = live.filter(r => r.soc < 50).sort((a, b) => a.soc - b.soc).slice(0, 10)
        .map(r => ({ site_name: r.unit, battery_soc: r.soc }));

    // Yesterday's history, limited to the trailers that are in service today
    const siteIds = fleet.map(r => r.site_id).filter(id => id > 0);
    const routerNames = fleet.map(r => r.router_name).filter(Boolean);
    const yesterdayData = { avg_eod_soc: 0, total_yield_kwh: 0, total_data_gb: 0, trailers_with_data: 0 };
    const performers = [];
    const networkSummary = { avg_signal_dbm: 0, total_data_gb: 0, high_usage: [], poor_signal: [] };

    if (dbAvailable) {
        try {
            const energy = await db.query(`
                SELECT AVG(battery_soc_eod) AS avg_soc, SUM(yield_wh) / 1000.0 AS total_yield_kwh, COUNT(*) AS trailer_count
                FROM daily_energy_summary
                WHERE date = $1::date AND site_id = ANY($2::int[])
            `, [yesterdayStr, siteIds]);
            if (energy.rows[0]) {
                yesterdayData.avg_eod_soc = parseFloat(energy.rows[0].avg_soc) || 0;
                yesterdayData.total_yield_kwh = parseFloat(energy.rows[0].total_yield_kwh) || 0;
                yesterdayData.trailers_with_data = parseInt(energy.rows[0].trailer_count) || 0;
            }

            const perf = await db.query(`
                SELECT site_name, yield_wh / 1000.0 AS yield_kwh, expected_yield_wh / 1000.0 AS expected_kwh,
                       yield_wh::float / expected_yield_wh * 100 AS percent
                FROM daily_energy_summary
                WHERE date = $1::date AND expected_yield_wh > 0 AND site_id = ANY($2::int[])
                  -- a day that ended with a full battery was throttled, not underperforming
                  AND (battery_soc_eod IS NULL OR battery_soc_eod < $3)
                ORDER BY percent DESC
            `, [yesterdayStr, siteIds, solarScoreConfig.throttle_soc_threshold]);
            performers.push(...perf.rows.map(r => ({
                site_name: r.site_name,
                yield_kwh: parseFloat(r.yield_kwh) || 0,
                expected_kwh: parseFloat(r.expected_kwh) || 0,
                percent: parseFloat(r.percent) || 0,
            })));

            // usage_mb is a running total for the day, so a device's day is its maximum
            const net = await db.query(`
                SELECT device_name, MAX(usage_mb) / 1024.0 AS total_gb, AVG(rsrp) AS avg_signal
                FROM pepwave_snapshots
                WHERE timestamp >= extract(epoch from $1::date) * 1000
                  AND timestamp < extract(epoch from ($1::date + interval '1 day')) * 1000
                  AND device_name = ANY($2::text[])
                GROUP BY device_name
            `, [yesterdayStr, routerNames]);
            const withSignal = net.rows.filter(r => r.avg_signal != null);
            networkSummary.total_data_gb = net.rows.reduce((s, r) => s + (parseFloat(r.total_gb) || 0), 0);
            networkSummary.avg_signal_dbm = withSignal.length
                ? withSignal.reduce((s, r) => s + parseFloat(r.avg_signal), 0) / withSignal.length : 0;
            networkSummary.high_usage = net.rows
                .map(r => ({ device: r.device_name, usage_gb: parseFloat(r.total_gb) || 0 }))
                .filter(r => r.usage_gb > 0.5).sort((a, b) => b.usage_gb - a.usage_gb).slice(0, 5);
            yesterdayData.total_data_gb = networkSummary.total_data_gb;
        } catch (err) {
            console.error('  Failed to fetch yesterday data:', err.message);
        }
    }

    return {
        // The fleet = trailers in service (on rent or at a customer site)
        fleet_size: summary.total,
        fleet_breakdown: {
            vrm: fleet.filter(r => r.has_cerbo).length,
            ic2_only: fleet.filter(r => !r.has_cerbo && r.has_router).length,
        },
        yard: { total: summary.inactive, ready: summary.yard_ready },
        summary,

        yesterday: {
            avg_eod_soc: yesterdayData.avg_eod_soc,
            total_yield_kwh: yesterdayData.total_yield_kwh,
            total_data_gb: yesterdayData.total_data_gb,
            trailers_reporting: yesterdayData.trailers_with_data,
        },

        current: { online: reporting, total: summary.total, avg_soc: avgSoc, low_soc_trailers: lowSoc },

        critical_items: criticalItems,
        watch_items: watchItems,

        top_performers: performers.filter(p => p.percent >= 100).slice(0, 3),
        underperformers: performers.filter(p => p.percent < 70).slice(-3).reverse(),

        network: networkSummary,

        active_alerts: computeAlerts(),
        trailers_below_50_soc: lowSoc,
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


    const cronExpr = `${minute} ${hour} * * *`;
    cron.schedule(cronExpr, async () => {
        console.log('  Running scheduled digest...');
        try {
            const db = getPool();
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
                            scheduled_date: new Date(Number(m.scheduled_date)).toISOString().slice(0, 10),
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

    console.log(`  ✓ Digest scheduled at ${time} ${tz} → ${recipients.length ? recipients.join(', ') : 'subscribed users only'}`);
}
