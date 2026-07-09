import { pool } from './core.js';

export async function insertSnapshot(snapshot) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO site_snapshots
      (site_id, site_name, timestamp, battery_soc, battery_voltage, battery_current,
       battery_temp, battery_power, solar_watts, solar_yield_today, solar_yield_yesterday,
       charge_state, raw_battery, raw_solar,
       consumed_ah, dc_load_watts, load_current, load_state, inverter_mode,
       mppt_state, alarm_reason, error_code, lifetime_yield_kwh, time_to_go_min)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [
            snapshot.site_id,
            snapshot.site_name,
            snapshot.timestamp,
            snapshot.battery_soc,
            snapshot.battery_voltage,
            snapshot.battery_current,
            snapshot.battery_temp,
            snapshot.battery_power,
            snapshot.solar_watts,
            snapshot.solar_yield_today,
            snapshot.solar_yield_yesterday,
            snapshot.charge_state,
            snapshot.raw_battery ? JSON.stringify(snapshot.raw_battery) : null,
            snapshot.raw_solar ? JSON.stringify(snapshot.raw_solar) : null,
            snapshot.consumed_ah ?? null,
            snapshot.dc_load_watts ?? null,
            snapshot.load_current ?? null,
            snapshot.load_state != null ? String(snapshot.load_state) : null,
            snapshot.inverter_mode != null ? String(snapshot.inverter_mode) : null,
            snapshot.mppt_state != null ? String(snapshot.mppt_state) : null,
            snapshot.alarm_reason != null ? String(snapshot.alarm_reason) : null,
            snapshot.error_code != null ? String(snapshot.error_code) : null,
            snapshot.lifetime_yield_kwh ?? null,
            snapshot.time_to_go_min ?? null,
        ]
    );
}

export async function getHistory(siteId, startTs, endTs) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM site_snapshots
     WHERE site_id = $1 AND timestamp >= $2 AND timestamp <= $3
     ORDER BY timestamp ASC`,
        [siteId, startTs, endTs]
    );
    return result.rows;
}

export async function getLatestSnapshots() {
    if (!pool) return [];
    // Only return snapshots from the last 30 minutes to avoid serving stale data
    const cutoff = Date.now() - 30 * 60 * 1000;
    const result = await pool.query(`
    SELECT DISTINCT ON (site_id) *
    FROM site_snapshots
    WHERE timestamp > $1
    ORDER BY site_id, timestamp DESC
  `, [cutoff]);
    return result.rows;
}

// ============================================================
// Pepwave Snapshots
// ============================================================
export async function insertPepwaveSnapshot(snap) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO pepwave_snapshots
      (device_name, timestamp, online, signal_bar, rsrp, rsrq, rssi, sinr, carrier, technology, usage_mb, tx_mb, rx_mb, client_count, uptime, wan_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
            snap.device_name,
            snap.timestamp,
            snap.online,
            snap.signal_bar,
            snap.rsrp,
            snap.rsrq,
            snap.rssi,
            snap.sinr,
            snap.carrier,
            snap.technology,
            snap.usage_mb,
            snap.tx_mb,
            snap.rx_mb,
            snap.client_count,
            snap.uptime,
            snap.wan_ip,
        ]
    );
}

export async function getPepwaveHistory(deviceName, startTs, endTs) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM pepwave_snapshots
     WHERE device_name = $1 AND timestamp >= $2 AND timestamp <= $3
     ORDER BY timestamp ASC`,
        [deviceName, startTs, endTs]
    );
    return result.rows;
}

export async function getPepwaveDailyUsage(deviceName, days = 30) {
    if (!pool) return [];
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = await pool.query(
        `SELECT
          DATE(to_timestamp(timestamp / 1000)) as day,
          MAX(usage_mb) - MIN(usage_mb) as daily_usage_mb,
          AVG(rsrp) as avg_rsrp,
          MIN(rsrp) as min_rsrp,
          MAX(signal_bar) as max_signal_bar,
          AVG(client_count) as avg_clients,
          COUNT(*) as samples,
          BOOL_AND(online) as all_online
        FROM pepwave_snapshots
        WHERE device_name = $1 AND timestamp >= $2
        GROUP BY DATE(to_timestamp(timestamp / 1000))
        ORDER BY day ASC`,
        [deviceName, cutoff]
    );
    return result.rows;
}


export async function getBatteryHistory(siteId, days = 30) {
    if (!pool) return [];
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const result = await pool.query(
        `SELECT date, min_soc, avg_soc, max_soc, avg_voltage, solar_yield_kwh
         FROM analytics_daily_metrics
         WHERE site_id = $1 AND date >= $2::date
         ORDER BY date ASC`,
        [siteId, cutoff]
    );
    return result.rows;
}

// ============================================================
// Users
// ============================================================

