import { pool } from './core.js';

export async function getActiveAlerts() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM alert_history WHERE resolved_at IS NULL ORDER BY created_at DESC`
    );
    return result.rows;
}

export async function insertAlertHistory(siteId, siteName, severity, streakDays, deficitWh) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO alert_history (site_id, site_name, severity, streak_days, deficit_wh)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [siteId, siteName, severity, streakDays, deficitWh]
    );
    return result.rows[0];
}

export async function resolveAlert(siteId) {
    if (!pool) return;
    await pool.query(
        `UPDATE alert_history SET resolved_at = NOW() WHERE site_id = $1 AND resolved_at IS NULL`,
        [siteId]
    );
}

export async function getAlertHistory(days = 30) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM alert_history
         WHERE created_at >= NOW() - INTERVAL '1 day' * $1
         ORDER BY created_at DESC`,
        [days]
    );
    return result.rows;
}

// ============================================================
// Battery Health (trend analysis)
// ============================================================

