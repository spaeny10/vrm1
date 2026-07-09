import { pool } from './core.js';

export async function upsertDailyEnergy(siteId, date, siteName, yieldWh, consumedWh, socStartOfDay = null, expectedYieldWh = null, consumptionSource = null, batterySocEod = null, mpptStateEod = null) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO daily_energy_summary (site_id, date, site_name, yield_wh, consumed_wh, soc_start_of_day, expected_yield_wh, consumption_source, battery_soc_eod, mppt_state_eod, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (site_id, date) DO UPDATE SET
           site_name = COALESCE($3, daily_energy_summary.site_name),
           yield_wh = COALESCE($4, daily_energy_summary.yield_wh),
           consumed_wh = COALESCE($5, daily_energy_summary.consumed_wh),
           soc_start_of_day = COALESCE($6, daily_energy_summary.soc_start_of_day),
           expected_yield_wh = COALESCE($7, daily_energy_summary.expected_yield_wh),
           consumption_source = COALESCE($8, daily_energy_summary.consumption_source),
           battery_soc_eod = COALESCE($9, daily_energy_summary.battery_soc_eod),
           mppt_state_eod = COALESCE($10, daily_energy_summary.mppt_state_eod),
           updated_at = $11`,
        [siteId, date, siteName, yieldWh, consumedWh, socStartOfDay, expectedYieldWh, consumptionSource, batterySocEod, mpptStateEod, Date.now()]
    );
}

export async function getDailyEnergy(siteId, days = 14) {
    if (!pool) return [];
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const result = await pool.query(
        `SELECT site_id, date, site_name, yield_wh, consumed_wh, soc_start_of_day, expected_yield_wh
         FROM daily_energy_summary
         WHERE site_id = $1 AND date >= $2::date
         ORDER BY date ASC`,
        [siteId, cutoff]
    );
    return result.rows;
}

export async function getAllDailyEnergy(days = 14) {
    if (!pool) return [];
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const result = await pool.query(
        `SELECT site_id, date, site_name, yield_wh, consumed_wh, soc_start_of_day, expected_yield_wh
         FROM daily_energy_summary
         WHERE date >= $1::date
         ORDER BY site_id, date ASC`,
        [cutoff]
    );
    return result.rows;
}

// ============================================================
// Alert History (persistent)
// ============================================================

