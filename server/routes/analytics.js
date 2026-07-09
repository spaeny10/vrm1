import { TRAILER_SPECS } from '../config.js';
import { computeDailyMetrics, getAllDailyEnergy, getAnalyticsByJobSite, getAnalyticsByTrailer, getAnalyticsDateRange, getBatteryHistory, getFleetAnalyticsSummary, getJobSiteRankings, getPool } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { dailyEnergy } from '../state.js';

export function registerAnalyticsRoutes(app) {

app.get('/api/analytics/fleet-summary', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const daily = await getFleetAnalyticsSummary(days);
        const dateRange = await getAnalyticsDateRange();
        res.json({ success: true, daily, date_range: dateRange });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/analytics/rankings', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        const rankings = await getJobSiteRankings(days);
        res.json({ success: true, rankings });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/analytics/job-site/:id', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const data = await getAnalyticsByJobSite(parseInt(req.params.id), days);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/analytics/trailer/:id', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const data = await getAnalyticsByTrailer(parseInt(req.params.id), days);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Backfill: compute metrics + expected yield for past N days
app.post('/api/analytics/backfill', requireRole('admin'), async (req, res) => {
    try {
        const days = parseInt(req.body?.days) || 30;
        const db = getPool();

        // Step 1: Backfill analytics_daily_metrics from snapshots
        let metricsRows = 0;
        for (let i = 1; i <= days; i++) {
            const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
            const count = await computeDailyMetrics(date);
            metricsRows += count;
        }
        console.log(`  Backfill: computed ${metricsRows} analytics_daily_metrics rows for ${days} days`);

        // Step 2: Backfill expected_yield_wh in daily_energy_summary using historical weather
        const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const endDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

        // Find rows missing expected_yield_wh
        const missing = await db.query(
            `SELECT des.site_id, des.date, ta.latitude, ta.longitude
             FROM daily_energy_summary des
             LEFT JOIN trailer_assignments ta ON ta.site_id = des.site_id
             WHERE des.date >= $1::date AND des.date <= $2::date
               AND des.expected_yield_wh IS NULL
               AND ta.latitude IS NOT NULL AND ta.longitude IS NOT NULL
             ORDER BY des.site_id, des.date`,
            [startDate, endDate]
        );

        // Group by GPS location (rounded to 0.1°) to minimize API calls
        const locationGroups = new Map();
        for (const row of missing.rows) {
            const key = `${Math.round(row.latitude * 10) / 10},${Math.round(row.longitude * 10) / 10}`;
            if (!locationGroups.has(key)) {
                locationGroups.set(key, { lat: row.latitude, lng: row.longitude, rows: [] });
            }
            locationGroups.get(key).rows.push(row);
        }

        let expectedUpdated = 0;
        const specs = TRAILER_SPECS;

        for (const [locKey, group] of locationGroups) {
            try {
                // Open-Meteo archive API for historical solar radiation
                const url = `https://archive-api.open-meteo.com/v1/archive`
                    + `?latitude=${group.lat}&longitude=${group.lng}`
                    + `&start_date=${startDate}&end_date=${endDate}`
                    + `&daily=shortwave_radiation_sum&timezone=auto`;
                const resp = await fetch(url);
                if (!resp.ok) {
                    console.warn(`  Backfill: Open-Meteo archive failed for ${locKey}: ${resp.status}`);
                    continue;
                }
                const json = await resp.json();
                const dates = json.daily?.time || [];
                const radiation = json.daily?.shortwave_radiation_sum || [];

                // Build date->PSH lookup
                const pshByDate = new Map();
                for (let i = 0; i < dates.length; i++) {
                    if (radiation[i] != null) {
                        pshByDate.set(dates[i], radiation[i] / 3.6); // MJ/m² to kWh/m² (PSH)
                    }
                }

                // Update each row's expected_yield_wh
                for (const row of group.rows) {
                    const dateStr = new Date(row.date).toISOString().slice(0, 10);
                    const psh = pshByDate.get(dateStr);
                    if (psh != null && psh > 0) {
                        const expectedWh = specs.solar.total_watts * psh * specs.solar.system_efficiency;
                        await db.query(
                            `UPDATE daily_energy_summary SET expected_yield_wh = $1 WHERE site_id = $2 AND date = $3::date`,
                            [Math.round(expectedWh), row.site_id, dateStr]
                        );
                        expectedUpdated++;
                    }
                }

                // Rate limit: 1 req/sec for Open-Meteo
                await new Promise(r => setTimeout(r, 1100));
            } catch (err) {
                console.warn(`  Backfill: error for location ${locKey}: ${err.message}`);
            }
        }
        console.log(`  Backfill: updated ${expectedUpdated} expected_yield_wh values across ${locationGroups.size} locations`);

        // Step 3: Reload in-memory dailyEnergy cache from updated DB
        const rows = await getAllDailyEnergy(days);
        for (const row of rows) {
            const siteId = row.site_id;
            const dateStr = new Date(row.date).toISOString().slice(0, 10);
            if (!dailyEnergy.has(siteId)) {
                dailyEnergy.set(siteId, {});
            }
            const siteData = dailyEnergy.get(siteId);
            siteData[dateStr] = {
                site_name: row.site_name || `Site ${siteId}`,
                yield_wh: row.yield_wh != null ? Number(row.yield_wh) : null,
                consumed_wh: row.consumed_wh != null ? Number(row.consumed_wh) : null,
                expected_yield_wh: row.expected_yield_wh != null ? Number(row.expected_yield_wh) : null,
                updated: Date.now(),
            };
        }
        console.log(`  Backfill: reloaded ${rows.length} dailyEnergy records into memory`);

        res.json({
            success: true,
            days_processed: days,
            metrics_rows: metricsRows,
            expected_yield_backfilled: expectedUpdated,
            locations_queried: locationGroups.size,
            cache_reloaded: rows.length,
        });
    } catch (err) {
        console.error('  Backfill error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Battery health prediction
// ============================================================
app.get('/api/analytics/trailer/:id/battery-health', async (req, res) => {
    try {
        const siteId = parseInt(req.params.id);
        const days = parseInt(req.query.days) || 30;
        const dataPoints = await getBatteryHistory(siteId, days);

        if (dataPoints.length < 3) {
            return res.json({ success: true, trend: 'insufficient_data', dataPoints });
        }

        // Linear regression on max_soc over time (peak daily SOC after charging = true capacity)
        const n = dataPoints.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (let i = 0; i < n; i++) {
            const y = dataPoints[i].max_soc ?? dataPoints[i].avg_soc ?? 0;
            sumX += i;
            sumY += y;
            sumXY += i * y;
            sumXX += i * i;
        }
        const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
        const avgDailyChange = slope; // % per day

        let trend = 'stable';
        if (slope < -0.5) trend = 'declining';
        else if (slope > 0.5) trend = 'improving';

        let daysUntilCritical = null;
        if (trend === 'declining') {
            const currentSoc = dataPoints[n - 1].max_soc ?? dataPoints[n - 1].avg_soc ?? 50;
            if (currentSoc > 20) {
                daysUntilCritical = Math.round((currentSoc - 20) / Math.abs(slope));
            }
        }

        res.json({
            success: true,
            trend,
            avg_daily_change: Math.round(avgDailyChange * 100) / 100,
            days_until_critical: daysUntilCritical,
            data_points: dataPoints,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

}
