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
        // Try to enable pgvector extension (optional - only needed for semantic search)
        try {
            await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
            console.log('  ✓ pgvector extension enabled');
        } catch (vecErr) {
            console.warn('  ⚠ pgvector not available - semantic search disabled');
        }

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

        // Pepwave snapshots table
        await client.query(`
      CREATE TABLE IF NOT EXISTS pepwave_snapshots (
        id SERIAL PRIMARY KEY,
        device_name TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        online BOOLEAN,
        signal_bar INTEGER,
        rsrp REAL,
        rsrq REAL,
        rssi REAL,
        sinr REAL,
        carrier TEXT,
        technology TEXT,
        usage_mb REAL,
        tx_mb REAL,
        rx_mb REAL,
        client_count INTEGER,
        uptime INTEGER,
        wan_ip TEXT
      )
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pepwave_device_ts
      ON pepwave_snapshots(device_name, timestamp)
    `);

        // Embeddings table for semantic search (1024 dimensions for Voyage AI)
        // Only create if pgvector is available
        try {
            await client.query(`
          CREATE TABLE IF NOT EXISTS fleet_embeddings (
            id SERIAL PRIMARY KEY,
            content_type TEXT NOT NULL,
            content_id TEXT NOT NULL,
            content_text TEXT NOT NULL,
            embedding vector(1024),
            metadata JSONB,
            timestamp BIGINT NOT NULL,
            UNIQUE(content_type, content_id)
          )
        `);

            // Vector similarity index using HNSW for fast nearest neighbor search
            await client.query(`
          CREATE INDEX IF NOT EXISTS idx_fleet_embeddings_vector
          ON fleet_embeddings USING hnsw (embedding vector_cosine_ops)
        `);

            await client.query(`
          CREATE INDEX IF NOT EXISTS idx_fleet_embeddings_type
          ON fleet_embeddings(content_type)
        `);
            console.log('  ✓ Semantic search tables created');
        } catch (embErr) {
            console.warn('  ⚠ Semantic search tables skipped (pgvector required)');
        }

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
    await pool.query("DELETE FROM pepwave_snapshots WHERE timestamp < $1", [cutoff]);
}

export async function getDbStats() {
    if (!pool) return { size: 0, count: 0, pepwave_count: 0 };
    const countResult = await pool.query("SELECT COUNT(*) as count FROM site_snapshots");
    const pepwaveCountResult = await pool.query("SELECT COUNT(*) as count FROM pepwave_snapshots");
    let sizeBytes = 0;
    try {
        const sizeResult = await pool.query(
            "SELECT pg_total_relation_size('site_snapshots') + pg_total_relation_size('pepwave_snapshots') as size"
        );
        sizeBytes = parseInt(sizeResult.rows[0].size, 10);
    } catch {
        // May not have permissions for pg_total_relation_size
    }
    return {
        size: sizeBytes,
        count: parseInt(countResult.rows[0].count, 10),
        pepwave_count: parseInt(pepwaveCountResult.rows[0].count, 10),
    };
}

// ============================================================
// Semantic Search - Embeddings Management
// ============================================================

export async function upsertEmbedding(contentType, contentId, contentText, embedding, metadata = {}) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO fleet_embeddings
      (content_type, content_id, content_text, embedding, metadata, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (content_type, content_id)
     DO UPDATE SET content_text = $3, embedding = $4, metadata = $5, timestamp = $6`,
        [contentType, contentId, contentText, JSON.stringify(embedding), metadata, Date.now()]
    );
}

export async function semanticSearch(queryEmbedding, contentTypes = null, limit = 20) {
    if (!pool) return [];

    let query = `
        SELECT
            content_type,
            content_id,
            content_text,
            metadata,
            timestamp,
            1 - (embedding <=> $1::vector) as similarity
        FROM fleet_embeddings
    `;

    const params = [JSON.stringify(queryEmbedding)];

    if (contentTypes && contentTypes.length > 0) {
        query += ` WHERE content_type = ANY($2)`;
        params.push(contentTypes);
    }

    query += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);
    return result.rows;
}

export async function getEmbeddingStats() {
    if (!pool) return {};
    const result = await pool.query(`
        SELECT
            content_type,
            COUNT(*) as count,
            MAX(timestamp) as latest_timestamp
        FROM fleet_embeddings
        GROUP BY content_type
        ORDER BY content_type
    `);
    return result.rows;
}

export async function getAllContentForEmbedding() {
    if (!pool) return [];

    // Get all sites with latest data
    const sites = await pool.query(`
        SELECT DISTINCT ON (site_id)
            site_id,
            site_name,
            battery_soc,
            battery_voltage,
            solar_watts,
            charge_state,
            timestamp
        FROM site_snapshots
        ORDER BY site_id, timestamp DESC
    `);

    // Get all pepwave devices with latest data
    const devices = await pool.query(`
        SELECT DISTINCT ON (device_name)
            device_name,
            online,
            signal_bar,
            rsrp,
            carrier,
            technology,
            timestamp
        FROM pepwave_snapshots
        ORDER BY device_name, timestamp DESC
    `);

    return {
        sites: sites.rows,
        devices: devices.rows
    };
}

export function getPool() {
    return pool;
}
