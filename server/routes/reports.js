import { getAllDailyEnergy, getBatteryHistory, getJobSite, getMaintenanceLogs, getMaintenanceStats, getTrailersByJobSite, getUpcomingMaintenance } from '../db.js';
import { hasVrmData } from '../lib/util.js';
import { computeAlerts } from '../services/alerts.js';
import { computeHealthGrade, computeTrailerIntelligence } from '../services/intelligence.js';
import { dailyEnergy, dbAvailable, snapshotCache } from '../state.js';

export function registerReportsRoutes(app) {

app.get('/api/reports/trailer/:id', async (req, res) => {
    try {
        const siteId = parseInt(req.params.id);
        const snapshot = snapshotCache.get(siteId);
        const intel = await computeTrailerIntelligence(siteId);
        const healthGrade = computeHealthGrade(siteId);
        const energyData = dailyEnergy.get(siteId) || {};
        const alertsList = computeAlerts().filter(a => a.site_id === siteId);

        let maintenance = [];
        let upcoming = [];
        let batteryHistory = [];
        if (dbAvailable) {
            try { maintenance = await getMaintenanceLogs({ site_id: siteId, limit: 20 }); } catch { }
            try { upcoming = (await getUpcomingMaintenance(30)).filter(m => m.site_id === siteId); } catch { }
            try { batteryHistory = await getBatteryHistory(siteId, 30); } catch { }
        }

        const energyHistory = Object.entries(energyData)
            .sort(([a], [b]) => b.localeCompare(a))
            .slice(0, 14)
            .map(([date, data]) => ({ date, ...data }));

        res.json({
            success: true,
            report: {
                generated_at: new Date().toISOString(),
                type: 'trailer',
                trailer: { site_id: siteId, site_name: snapshot?.site_name || `Site ${siteId}` },
                current_status: snapshot || null,
                health_grade: healthGrade,
                intelligence: intel,
                alerts: alertsList,
                maintenance: { recent: maintenance, upcoming },
                battery_history: batteryHistory,
                energy_history: energyHistory,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/reports/site/:id', async (req, res) => {
    try {
        const jobSiteId = parseInt(req.params.id);
        const jobSite = await getJobSite(jobSiteId);
        if (!jobSite) return res.status(404).json({ error: 'Job site not found' });

        const trailers = await getTrailersByJobSite(jobSiteId);
        const trailerSummaries = [];
        for (const t of trailers) {
            const snapshot = snapshotCache.get(t.site_id);
            const fresh = hasVrmData(snapshot);
            const grade = fresh ? computeHealthGrade(t.site_id) : null;
            trailerSummaries.push({
                site_id: t.site_id,
                site_name: t.site_name,
                health_grade: grade,
                battery_soc: fresh ? snapshot?.battery_soc : null,
                solar_watts: fresh ? snapshot?.solar_watts : null,
                yield_today: fresh ? snapshot?.solar_yield_today : null,
            });
        }

        let maintenance = [];
        if (dbAvailable) {
            try { maintenance = await getMaintenanceLogs({ job_site_id: jobSiteId, limit: 20 }); } catch { }
        }

        res.json({
            success: true,
            report: {
                generated_at: new Date().toISOString(),
                type: 'site',
                job_site: jobSite,
                trailers: trailerSummaries,
                maintenance: { recent: maintenance },
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/reports/fleet', async (req, res) => {
    try {
        const trailers = [];
        for (const [siteId, snapshot] of snapshotCache) {
            if (!hasVrmData(snapshot)) continue; // skip connectivity-only trailers
            const intel = await computeTrailerIntelligence(siteId);
            trailers.push({
                site_id: siteId,
                site_name: snapshot.site_name,
                health_grade: computeHealthGrade(siteId),
                battery_soc: snapshot.battery_soc,
                battery_voltage: snapshot.battery_voltage,
                solar_watts: snapshot.solar_watts,
                yield_today: snapshot.solar_yield_today,
                charge_state: snapshot.charge_state,
                intelligence: intel,
            });
        }

        const alerts = computeAlerts();
        let stats = null;
        let energyTrends = [];
        if (dbAvailable) {
            try { stats = await getMaintenanceStats(); } catch { }
            try { energyTrends = await getAllDailyEnergy(14); } catch { }
        }

        // Aggregate KPIs
        const onlineTrailers = trailers.filter(t => t.battery_soc != null);
        const avgSoc = onlineTrailers.length > 0
            ? onlineTrailers.reduce((s, t) => s + t.battery_soc, 0) / onlineTrailers.length : 0;
        const totalYieldToday = trailers.reduce((s, t) => s + (t.yield_today || 0), 0);
        const gradeDistribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
        for (const t of trailers) {
            const g = t.health_grade?.grade;
            if (g && gradeDistribution[g] !== undefined) gradeDistribution[g]++;
        }

        // Group energy trends by date for fleet totals
        const energyByDate = {};
        for (const e of energyTrends) {
            const d = e.date;
            if (!energyByDate[d]) energyByDate[d] = { date: d, yield_wh: 0, consumed_wh: 0 };
            energyByDate[d].yield_wh += parseFloat(e.yield_wh) || 0;
            energyByDate[d].consumed_wh += parseFloat(e.consumed_wh) || 0;
        }

        res.json({
            success: true,
            report: {
                generated_at: new Date().toISOString(),
                type: 'fleet',
                kpis: {
                    total_trailers: trailers.length,
                    online: onlineTrailers.length,
                    avg_soc: Math.round(avgSoc * 10) / 10,
                    total_yield_today_kwh: Math.round(totalYieldToday) / 1000,
                    active_alerts: alerts.length,
                },
                grade_distribution: gradeDistribution,
                trailers,
                alerts,
                energy_trends: Object.values(energyByDate).sort((a, b) => a.date.localeCompare(b.date)),
                maintenance_stats: stats,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

}
