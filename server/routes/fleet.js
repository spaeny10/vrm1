import { TRAILER_SPECS } from '../config.js';
import { getAlertHistory, getJobSites, getLatestSnapshots, getRentals, getTrailerAssignments, getTrailers } from '../db.js';
import { hasVrmData } from '../lib/util.js';
import { computeAlerts } from '../services/alerts.js';
import { computeHealthGrade, computeTechStatus, computeTrailerIntelligence } from '../services/intelligence.js';
import { fetchSolarIrradiance } from '../services/weather.js';
import { dailyEnergy, dbAvailable, gpsCache, lastIc2Poll, pepwaveCache, sitesCacheTime, snapshotCache } from '../state.js';

export function registerFleetRoutes(app) {

// Latest snapshots
app.get('/api/fleet/latest', async (req, res) => {
    try {
        if (dbAvailable) {
            const rows = await getLatestSnapshots();
            if (rows.length > 0) {
                return res.json({ success: true, records: rows });
            }
        }
        const records = Array.from(snapshotCache.values());
        res.json({ success: true, records });
    } catch (err) {
        const records = Array.from(snapshotCache.values());
        res.json({ success: true, records });
    }
});

// Fleet energy
app.get('/api/fleet/energy', (req, res) => {
    const result = [];
    for (const [siteId, days] of dailyEnergy.entries()) {
        const siteName = Object.values(days)[0]?.site_name || `Site ${siteId}`;
        const dailyData = Object.entries(days)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, info]) => ({
                date,
                yield_wh: info.yield_wh,
                consumed_wh: info.consumed_wh,
                consumption_source: info.consumption_source || null,
            }));
        result.push({ site_id: siteId, site_name: siteName, days: dailyData });
    }
    result.sort((a, b) => a.site_name.localeCompare(b.site_name, undefined, { numeric: true }));
    res.json({ success: true, records: result });
});

// Fleet alerts
app.get('/api/fleet/alerts', (req, res) => {
    const alerts = computeAlerts();
    res.json({ success: true, alerts });
});

// Alert history
app.get('/api/alerts/history', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const history = await getAlertHistory(days);
        res.json({ success: true, alerts: history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Fleet combined: VRM snapshots + Pepwave data merged by name
// ============================================================
app.get('/api/fleet/combined', (req, res) => {
    // Build a pepwave lookup by device name
    const pepwaveMap = {};
    for (const [name, device] of pepwaveCache.entries()) {
        pepwaveMap[name] = {
            online: device.online,
            status: device.status,
            signal_bar: device.cellular?.signal_bar ?? null,
            rsrp: device.cellular?.signal?.rsrp ?? null,
            carrier: device.cellular?.carrier || null,
            technology: device.cellular?.technology || null,
            client_count: device.client_count || 0,
            usage_mb: device.usage_mb || 0,
            uptime: device.uptime || 0,
            model: device.model,
            wan_ip: device.wan_ip,
        };
    }
    res.json({ success: true, pepwave: pepwaveMap, last_poll: lastIc2Poll });
});

app.get('/api/fleet/deployment', async (req, res) => {
    try {
        // Prefer explicit rental records (commercial truth) when they exist
        const openRentals = dbAvailable ? await getRentals({ open: true }) : [];
        if (openRentals.length > 0) {
            const trailers = await getTrailers();
            const billingSites = new Set(), standbySites = new Set(), pickupSites = new Set();
            let billingTrailers = 0, standbyTrailers = 0, pickupTrailers = 0;

            for (const r of openRentals) {
                // called_off keeps accruing until billing is explicitly stopped
                if (r.status === 'billing' || r.status === 'called_off') {
                    billingTrailers++;
                    if (r.job_site_id) billingSites.add(r.job_site_id);
                } else if (r.status === 'delivered') {
                    standbyTrailers++;
                    if (r.job_site_id) standbySites.add(r.job_site_id);
                } else if (r.status === 'awaiting_pickup') {
                    pickupTrailers++;
                    if (r.job_site_id) pickupSites.add(r.job_site_id);
                }
            }

            const availableTrailers = trailers.filter(t => t.status === 'available').length;

            return res.json({
                success: true,
                source: 'rentals',
                active_billing: { sites: billingSites.size, trailers: billingTrailers },
                standby: { sites: standbySites.size, trailers: standbyTrailers },
                available_at_hq: { trailers: availableTrailers },
                awaiting_pickup: { sites: pickupSites.size, trailers: pickupTrailers },
                total_deployed: { sites: billingSites.size + standbySites.size, trailers: billingTrailers + standbyTrailers },
            });
        }

        // Legacy fallback: infer from job site status
        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

        const assignmentsByJobSite = new Map();
        for (const a of assignments) {
            if (!assignmentsByJobSite.has(a.job_site_id)) {
                assignmentsByJobSite.set(a.job_site_id, []);
            }
            assignmentsByJobSite.get(a.job_site_id).push(a);
        }

        let activeBillingSites = 0, activeBillingTrailers = 0;
        let standbySites = 0, standbyTrailers = 0;
        let hqTrailers = 0;
        let awaitingPickupSites = 0, awaitingPickupTrailers = 0;

        for (const js of jobSites) {
            const trailerCount = (assignmentsByJobSite.get(js.id) || []).length;

            if (js.is_headquarters) {
                hqTrailers += trailerCount;
                continue;
            }

            if (js.status === 'active') {
                activeBillingSites++;
                activeBillingTrailers += trailerCount;
            } else if (js.status === 'standby') {
                standbySites++;
                standbyTrailers += trailerCount;
            } else if (js.status === 'completed') {
                // Completed but not yet picked up
                if (!js.pickup_date || new Date(js.pickup_date) >= new Date(new Date().toDateString())) {
                    awaitingPickupSites++;
                    awaitingPickupTrailers += trailerCount;
                }
            }
        }

        res.json({
            success: true,
            source: 'job_site_status',
            active_billing: { sites: activeBillingSites, trailers: activeBillingTrailers },
            standby: { sites: standbySites, trailers: standbyTrailers },
            available_at_hq: { trailers: hqTrailers },
            awaiting_pickup: { sites: awaitingPickupSites, trailers: awaitingPickupTrailers },
            total_deployed: { sites: activeBillingSites + standbySites, trailers: activeBillingTrailers + standbyTrailers },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Unified dashboard endpoint (single call for FleetOverview)
// ============================================================
app.get('/api/fleet/dashboard', (req, res) => {
    const snapshots = Array.from(snapshotCache.values());
    const vrmSnapshots = snapshots.filter(hasVrmData);
    const devices = Array.from(pepwaveCache.values());

    let totalSoc = 0, socCount = 0, totalSolar = 0;
    let onlineTrailers = 0, offlineTrailers = 0;

    for (const s of vrmSnapshots) {
        if (s.battery_soc != null) {
            totalSoc += s.battery_soc;
            socCount++;
        }
        totalSolar += s.solar_watts || 0;
        onlineTrailers++;
    }

    let netOnline = 0, netOffline = 0;
    for (const d of devices) {
        if (d.online) netOnline++;
        else netOffline++;
    }

    const alerts = computeAlerts();

    res.json({
        success: true,
        site_count: snapshots.length,
        device_count: devices.length,
        avg_soc: socCount > 0 ? totalSoc / socCount : null,
        total_solar_watts: totalSolar,
        trailers_online: onlineTrailers,
        trailers_offline: offlineTrailers,
        net_online: netOnline,
        net_offline: netOffline,
        alert_count: alerts.length,
        top_alerts: alerts.slice(0, 5),
        last_vrm_poll: sitesCacheTime,
        last_ic2_poll: lastIc2Poll,
    });
});

// ============================================================
// Intelligence API: Spec + location-aware metrics
// ============================================================
app.get('/api/intelligence/trailer/:id', async (req, res) => {
    try {
        const siteId = parseInt(req.params.id);
        const intel = await computeTrailerIntelligence(siteId);
        if (!intel) {
            return res.status(404).json({ success: false, error: 'Trailer not found or no data' });
        }
        res.json({ success: true, intelligence: intel });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/fleet/intelligence', async (req, res) => {
    try {
        const results = [];
        // Batch weather fetches by unique GPS locations first
        const uniqueLocations = new Map();
        for (const [siteId] of snapshotCache) {
            const gps = gpsCache.get(siteId);
            if (gps) {
                const key = `${Math.round(gps.latitude * 10) / 10},${Math.round(gps.longitude * 10) / 10}`;
                if (!uniqueLocations.has(key)) {
                    uniqueLocations.set(key, { lat: gps.latitude, lon: gps.longitude });
                }
            }
        }
        // Pre-fetch weather for all unique locations (in parallel, max 10)
        const locationEntries = Array.from(uniqueLocations.values()).slice(0, 10);
        await Promise.allSettled(locationEntries.map(loc => fetchSolarIrradiance(loc.lat, loc.lon)));

        // Now compute intelligence for VRM-connected trailers only (weather is cached)
        for (const [siteId, snap] of snapshotCache) {
            if (!hasVrmData(snap)) continue;
            const intel = await computeTrailerIntelligence(siteId);
            if (intel) results.push(intel);
        }

        // Fleet-wide aggregates
        const withScore = results.filter(r => r.solar.score !== null);
        const withAutonomy = results.filter(r => r.battery.days_of_autonomy !== null);
        const withPerformance = results.filter(r => r.solar.panel_performance_pct !== null);

        const underperforming = results.filter(r => r.solar.avg_7d_score !== null && r.solar.avg_7d_score < 50);
        const lowAutonomy = results.filter(r => r.battery.days_of_autonomy !== null && r.battery.days_of_autonomy < 1.5);

        res.json({
            success: true,
            fleet: {
                trailer_count: results.length,
                avg_solar_score: withScore.length > 0
                    ? Math.round(withScore.reduce((s, r) => s + r.solar.score, 0) / withScore.length * 10) / 10
                    : null,
                avg_panel_performance: withPerformance.length > 0
                    ? Math.round(withPerformance.reduce((s, r) => s + r.solar.panel_performance_pct, 0) / withPerformance.length * 10) / 10
                    : null,
                avg_days_autonomy: withAutonomy.length > 0
                    ? Math.round(withAutonomy.reduce((s, r) => s + r.battery.days_of_autonomy, 0) / withAutonomy.length * 10) / 10
                    : null,
                underperforming_count: underperforming.length,
                low_autonomy_count: lowAutonomy.length,
                specs: TRAILER_SPECS,
            },
            trailers: results,
            underperforming: underperforming.map(r => ({
                site_id: r.site_id, site_name: r.site_name, score_7d: r.solar.avg_7d_score,
            })),
            low_autonomy: lowAutonomy.map(r => ({
                site_id: r.site_id, site_name: r.site_name, days: r.battery.days_of_autonomy, soc: r.battery.soc_pct,
            })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/fleet/health-grades', (req, res) => {
    const grades = {};
    for (const [siteId, snap] of snapshotCache) {
        if (!hasVrmData(snap)) continue;
        grades[siteId] = computeHealthGrade(siteId);
    }
    res.json({ success: true, grades });
});

app.get('/api/fleet/tech-status', (req, res) => {
    // Build deficit streak map once (reuse computeAlerts)
    const alertsMap = {};
    for (const alert of computeAlerts()) {
        alertsMap[alert.site_id] = alert.streak_days;
    }

    const statuses = {};
    // VRM-connected trailers
    for (const [siteId] of snapshotCache) {
        statuses[siteId] = computeTechStatus(siteId, alertsMap);
    }
    // IC2-only trailers (pepwave-only, no VRM snapshot)
    // Use negative device ID to match /api/sites key format
    for (const [name, dev] of pepwaveCache) {
        let covered = false;
        for (const [, snap] of snapshotCache) {
            if (snap.site_name === name) { covered = true; break; }
        }
        if (!covered) {
            statuses[-dev.id] = {
                status: dev.online ? 'good' : 'attention',
                reason: dev.online ? 'Network-only, Pepwave online' : 'Pepwave offline',
            };
        }
    }

    const summary = { good: 0, watch: 0, attention: 0 };
    for (const s of Object.values(statuses)) {
        if (s) summary[s.status]++;
    }

    res.json({ success: true, statuses, summary });
});

}
