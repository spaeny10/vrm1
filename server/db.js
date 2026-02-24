import pg from 'pg';

const { Pool } = pg;

let pool = null;

export async function initDb() {
    const connectionString = process.env.DATABASE_URL;

    if (connectionString) {
        pool = new Pool({
            connectionString,
            ssl: process.env.NODE_ENV === 'production'
                ? { rejectUnauthorized: false }
                : false,
        });
    } else {
        // Local development fallback
        pool = new Pool({
            host: process.env.PGHOST || 'localhost',
            port: parseInt(process.env.PGPORT || '5432'),
            database: process.env.PGDATABASE || 'vrm_dashboard',
            user: process.env.PGUSER || 'postgres',
            password: process.env.PGPASSWORD || 'postgres',
        });
    }

    // Test connection
    const client = await pool.connect();
    try {
        await client.query(`
      CREATE TABLE IF NOT EXISTS site_snapshots (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL,
        site_name TEXT,
        timestamp BIGINT NOT NULL,
        battery_soc REAL,
        battery_voltage REAL,
        battery_current REAL,
        battery_temp REAL,
        battery_power REAL,
        solar_watts REAL,
        solar_yield_today REAL,
        solar_yield_yesterday REAL,
        charge_state TEXT,
        raw_battery JSONB,
        raw_solar JSONB
      )
    `);

        await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_site_ts
      ON site_snapshots(site_id, timestamp)
    `);

        // Default retention: 90 days
        await client.query(`
      INSERT INTO settings (key, value)
      VALUES ('retention_days', '90')
      ON CONFLICT (key) DO NOTHING
    `);
    } finally {
        client.release();
    }

    return pool;
}

export async function insertSnapshot(snapshot) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO site_snapshots
      (site_id, site_name, timestamp, battery_soc, battery_voltage, battery_current, battery_temp, battery_power, solar_watts, solar_yield_today, solar_yield_yesterday, charge_state, raw_battery, raw_solar)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
    const result = await pool.query(`
    SELECT DISTINCT ON (site_id) *
    FROM site_snapshots
    ORDER BY site_id, timestamp DESC
  `);
    return result.rows;
}

export async function getRetentionDays() {
    if (!pool) return 90;
    const result = await pool.query("SELECT value FROM settings WHERE key='retention_days'");
    if (result.rows.length === 0) return 90;
    return parseInt(result.rows[0].value, 10);
}

export async function setRetentionDays(days) {
    if (!pool) return;
    await pool.query(
        "INSERT INTO settings (key, value) VALUES ('retention_days', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [String(days)]
    );
}

export async function pruneOldData() {
    if (!pool) return;
    const days = await getRetentionDays();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    await pool.query("DELETE FROM site_snapshots WHERE timestamp < $1", [cutoff]);
}

export async function getDbStats() {
    if (!pool) return { size: 0, count: 0 };
    const countResult = await pool.query("SELECT COUNT(*) as count FROM site_snapshots");
    let sizeBytes = 0;
    try {
        const sizeResult = await pool.query(
            "SELECT pg_total_relation_size('site_snapshots') as size"
        );
        sizeBytes = parseInt(sizeResult.rows[0].size, 10);
    } catch {
        // May not have permissions for pg_total_relation_size
    }
    return {
        size: sizeBytes,
        count: parseInt(countResult.rows[0].count, 10),
    };
}
