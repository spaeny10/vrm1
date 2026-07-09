import { pool } from './core.js';

export async function computeDailyMetrics(dateStr) {
    // Compute daily metrics for a given date (YYYY-MM-DD) from site_snapshots + pepwave_snapshots
    if (!pool) return 0;

    // Convert date string to timestamp range
    const dayStart = new Date(dateStr + 'T00:00:00Z').getTime();
    const dayEnd = dayStart + 86400000;

    const result = await pool.query(`
        INSERT INTO analytics_daily_metrics (date, site_id, avg_soc, min_soc, max_soc, solar_yield_kwh, avg_voltage, avg_signal_bar, data_usage_mb, uptime_percent, created_at)
        SELECT
            $1::date as date,
            ss.site_id,
            AVG(ss.battery_soc) as avg_soc,
            MIN(ss.battery_soc) as min_soc,
            MAX(ss.battery_soc) as max_soc,
            MAX(ss.solar_yield_today) / 1000.0 as solar_yield_kwh,
            AVG(ss.battery_voltage) as avg_voltage,
            (SELECT AVG(ps.signal_bar) FROM pepwave_snapshots ps
             INNER JOIN trailer_assignments ta ON ps.device_name = ta.site_name AND ta.site_id = ss.site_id
             WHERE ps.timestamp >= $2 AND ps.timestamp < $3) as avg_signal_bar,
            (SELECT MAX(ps.usage_mb) - MIN(ps.usage_mb) FROM pepwave_snapshots ps
             INNER JOIN trailer_assignments ta ON ps.device_name = ta.site_name AND ta.site_id = ss.site_id
             WHERE ps.timestamp >= $2 AND ps.timestamp < $3) as data_usage_mb,
            CASE
                WHEN COUNT(*) > 0 THEN COUNT(CASE WHEN ss.battery_soc IS NOT NULL THEN 1 END)::REAL / COUNT(*)::REAL * 100
                ELSE NULL
            END as uptime_percent,
            $4 as created_at
        FROM site_snapshots ss
        WHERE ss.timestamp >= $2 AND ss.timestamp < $3
        GROUP BY ss.site_id
        ON CONFLICT (site_id, date) DO UPDATE SET
            avg_soc = EXCLUDED.avg_soc,
            min_soc = EXCLUDED.min_soc,
            max_soc = EXCLUDED.max_soc,
            solar_yield_kwh = EXCLUDED.solar_yield_kwh,
            avg_voltage = EXCLUDED.avg_voltage,
            avg_signal_bar = EXCLUDED.avg_signal_bar,
            data_usage_mb = EXCLUDED.data_usage_mb,
            uptime_percent = EXCLUDED.uptime_percent
    `, [dateStr, dayStart, dayEnd, Date.now()]);

    return result.rowCount;
}

export async function getAnalyticsByTrailer(siteId, days = 30) {
    if (!pool) return [];
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const result = await pool.query(
        `SELECT * FROM analytics_daily_metrics
         WHERE site_id = $1 AND date >= $2::date
         ORDER BY date ASC`,
        [siteId, cutoff]
    );
    return result.rows;
}

export async function getAnalyticsByJobSite(jobSiteId, days = 30) {
    if (!pool) return [];
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const result = await pool.query(
        `SELECT
            adm.date,
            AVG(adm.avg_soc) as avg_soc,
            MIN(adm.min_soc) as min_soc,
            MAX(adm.max_soc) as max_soc,
            SUM(adm.solar_yield_kwh) as total_yield_kwh,
            AVG(adm.avg_voltage) as avg_voltage,
            AVG(adm.avg_signal_bar) as avg_signal_bar,
            SUM(adm.data_usage_mb) as total_data_mb,
            AVG(adm.uptime_percent) as avg_uptime
         FROM analytics_daily_metrics adm
         INNER JOIN trailer_assignments ta ON adm.site_id = ta.site_id
         WHERE ta.job_site_id = $1 AND adm.date >= $2::date
         GROUP BY adm.date
         ORDER BY adm.date ASC`,
        [jobSiteId, cutoff]
    );
    return result.rows;
}

export async function getFleetAnalyticsSummary(days = 30) {
    if (!pool) return {};
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const result = await pool.query(
        `SELECT
            date,
            AVG(avg_soc) as fleet_avg_soc,
            MIN(min_soc) as fleet_min_soc,
            SUM(solar_yield_kwh) as fleet_yield_kwh,
            AVG(avg_voltage) as fleet_avg_voltage,
            SUM(data_usage_mb) as fleet_data_mb,
            AVG(uptime_percent) as fleet_uptime
         FROM analytics_daily_metrics
         WHERE date >= $1::date
         GROUP BY date
         ORDER BY date ASC`,
        [cutoff]
    );
    return result.rows;
}

export async function getJobSiteRankings(days = 7) {
    if (!pool) return [];
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const result = await pool.query(
        `SELECT
            js.id as job_site_id,
            js.name as job_site_name,
            js.status,
            COUNT(DISTINCT adm.site_id) as trailer_count,
            AVG(adm.avg_soc) as avg_soc,
            MIN(adm.min_soc) as min_soc,
            SUM(adm.solar_yield_kwh) / NULLIF(COUNT(DISTINCT adm.date), 0) as avg_daily_yield_kwh,
            AVG(adm.uptime_percent) as avg_uptime,
            AVG(adm.avg_voltage) as avg_voltage
         FROM job_sites js
         INNER JOIN trailer_assignments ta ON ta.job_site_id = js.id
         INNER JOIN analytics_daily_metrics adm ON adm.site_id = ta.site_id
         WHERE adm.date >= $1::date AND js.status = 'active'
         GROUP BY js.id, js.name, js.status
         ORDER BY avg_soc DESC`,
        [cutoff]
    );
    return result.rows;
}

export async function getAnalyticsDateRange() {
    if (!pool) return {};
    const result = await pool.query(
        `SELECT MIN(date) as first_date, MAX(date) as last_date, COUNT(DISTINCT date) as days_count
         FROM analytics_daily_metrics`
    );
    return result.rows[0] || {};
}

// ============================================================
// Daily Energy Summary (persistent)
// ============================================================

