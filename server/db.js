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

        // Job sites table (construction locations with 1-6 trailers each)
        await client.query(`
      CREATE TABLE IF NOT EXISTS job_sites (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        address TEXT,
        status TEXT DEFAULT 'active',
        notes TEXT,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);

        // Trailer-to-job-site assignments (links VRM installations to construction sites)
        await client.query(`
      CREATE TABLE IF NOT EXISTS trailer_assignments (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL UNIQUE,
        site_name TEXT NOT NULL,
        job_site_id INTEGER REFERENCES job_sites(id) ON DELETE SET NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        manual_override BOOLEAN DEFAULT FALSE,
        assigned_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trailer_assignments_job_site
      ON trailer_assignments(job_site_id)
    `);

        console.log('  ✓ Job sites and trailer assignments tables ready');

        // Maintenance logs table
        await client.query(`
      CREATE TABLE IF NOT EXISTS maintenance_logs (
        id SERIAL PRIMARY KEY,
        job_site_id INTEGER REFERENCES job_sites(id) ON DELETE SET NULL,
        site_id INTEGER,
        visit_type TEXT NOT NULL,
        status TEXT DEFAULT 'scheduled',
        title TEXT NOT NULL,
        description TEXT,
        technician TEXT,
        scheduled_date BIGINT,
        completed_date BIGINT,
        labor_hours REAL,
        labor_cost_cents INTEGER DEFAULT 0,
        parts_cost_cents INTEGER DEFAULT 0,
        parts_used JSONB,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_maintenance_job_site ON maintenance_logs(job_site_id)
    `);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_maintenance_site_id ON maintenance_logs(site_id)
    `);

        // Trailer components table
        await client.query(`
      CREATE TABLE IF NOT EXISTS trailer_components (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL,
        component_type TEXT NOT NULL,
        make TEXT,
        model TEXT,
        serial_number TEXT,
        installed_date BIGINT,
        warranty_expiry BIGINT,
        status TEXT DEFAULT 'active',
        notes TEXT,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_components_site ON trailer_components(site_id)
    `);

        console.log('  ✓ Maintenance and components tables ready');

        // Analytics daily metrics (pre-computed per trailer per day)
        await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_daily_metrics (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        site_id INTEGER NOT NULL,
        avg_soc REAL, min_soc REAL, max_soc REAL,
        solar_yield_kwh REAL,
        avg_voltage REAL,
        avg_signal_bar REAL,
        data_usage_mb REAL,
        uptime_percent REAL,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        UNIQUE(site_id, date)
      )
    `);

        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_daily ON analytics_daily_metrics(site_id, date DESC)
    `);

        console.log('  ✓ Analytics daily metrics table ready');

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

// ============================================================
// Job Sites
// ============================================================

export async function getJobSites() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM job_sites WHERE status != 'completed' ORDER BY name`
    );
    return result.rows;
}

export async function getJobSite(id) {
    if (!pool) return null;
    const result = await pool.query(`SELECT * FROM job_sites WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function insertJobSite(site) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO job_sites (name, latitude, longitude, address, status, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         RETURNING *`,
        [site.name, site.latitude, site.longitude, site.address || null, site.status || 'active', site.notes || null, Date.now()]
    );
    return result.rows[0];
}

export async function updateJobSite(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (['name', 'latitude', 'longitude', 'address', 'status', 'notes'].includes(key)) {
            fields.push(`${key} = $${idx}`);
            values.push(value);
            idx++;
        }
    }
    if (fields.length === 0) return null;

    fields.push(`updated_at = $${idx}`);
    values.push(Date.now());
    idx++;

    values.push(id);
    const result = await pool.query(
        `UPDATE job_sites SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

// ============================================================
// Trailer Assignments
// ============================================================

export async function getTrailerAssignments() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT ta.*, js.name as job_site_name
         FROM trailer_assignments ta
         LEFT JOIN job_sites js ON ta.job_site_id = js.id
         ORDER BY ta.site_name`
    );
    return result.rows;
}

export async function getTrailersByJobSite(jobSiteId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM trailer_assignments WHERE job_site_id = $1 ORDER BY site_name`,
        [jobSiteId]
    );
    return result.rows;
}

export async function upsertTrailerAssignment(siteId, siteName, latitude, longitude, jobSiteId = null) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO trailer_assignments (site_id, site_name, latitude, longitude, job_site_id, assigned_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (site_id) DO UPDATE SET
           site_name = $2,
           latitude = COALESCE($3, trailer_assignments.latitude),
           longitude = COALESCE($4, trailer_assignments.longitude),
           job_site_id = CASE WHEN trailer_assignments.manual_override THEN trailer_assignments.job_site_id ELSE COALESCE($5, trailer_assignments.job_site_id) END,
           assigned_at = $6
         RETURNING *`,
        [siteId, siteName, latitude, longitude, jobSiteId, Date.now()]
    );
    return result.rows[0];
}

export async function assignTrailerToJobSite(siteId, jobSiteId, manual = false) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE trailer_assignments
         SET job_site_id = $1, manual_override = $2, assigned_at = $3
         WHERE site_id = $4
         RETURNING *`,
        [jobSiteId, manual, Date.now(), siteId]
    );
    return result.rows[0] || null;
}

export async function getTrailersWithGps() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM trailer_assignments
         WHERE latitude IS NOT NULL AND longitude IS NOT NULL
         ORDER BY site_name`
    );
    return result.rows;
}

// ============================================================
// Maintenance Logs
// ============================================================

export async function getMaintenanceLogs(filters = {}) {
    if (!pool) return [];
    let query = `SELECT ml.*, js.name as job_site_name, ta.site_name as trailer_name
                 FROM maintenance_logs ml
                 LEFT JOIN job_sites js ON ml.job_site_id = js.id
                 LEFT JOIN trailer_assignments ta ON ml.site_id = ta.site_id
                 WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (filters.job_site_id) {
        query += ` AND ml.job_site_id = $${idx}`;
        params.push(filters.job_site_id);
        idx++;
    }
    if (filters.site_id) {
        query += ` AND ml.site_id = $${idx}`;
        params.push(filters.site_id);
        idx++;
    }
    if (filters.status) {
        query += ` AND ml.status = $${idx}`;
        params.push(filters.status);
        idx++;
    }

    query += ` ORDER BY COALESCE(ml.scheduled_date, ml.created_at) DESC`;

    if (filters.limit) {
        query += ` LIMIT $${idx}`;
        params.push(filters.limit);
    }

    const result = await pool.query(query, params);
    return result.rows;
}

export async function getMaintenanceLog(id) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT ml.*, js.name as job_site_name, ta.site_name as trailer_name
         FROM maintenance_logs ml
         LEFT JOIN job_sites js ON ml.job_site_id = js.id
         LEFT JOIN trailer_assignments ta ON ml.site_id = ta.site_id
         WHERE ml.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

export async function insertMaintenanceLog(log) {
    if (!pool) return null;
    const now = Date.now();
    const result = await pool.query(
        `INSERT INTO maintenance_logs
         (job_site_id, site_id, visit_type, status, title, description, technician,
          scheduled_date, completed_date, labor_hours, labor_cost_cents, parts_cost_cents, parts_used,
          created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
         RETURNING *`,
        [
            log.job_site_id || null, log.site_id || null, log.visit_type, log.status || 'scheduled',
            log.title, log.description || null, log.technician || null,
            log.scheduled_date || null, log.completed_date || null,
            log.labor_hours || null, log.labor_cost_cents || 0, log.parts_cost_cents || 0,
            log.parts_used ? JSON.stringify(log.parts_used) : null,
            now
        ]
    );
    return result.rows[0];
}

export async function updateMaintenanceLog(id, updates) {
    if (!pool) return null;
    const allowedFields = [
        'job_site_id', 'site_id', 'visit_type', 'status', 'title', 'description',
        'technician', 'scheduled_date', 'completed_date', 'labor_hours',
        'labor_cost_cents', 'parts_cost_cents', 'parts_used'
    ];
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            if (key === 'parts_used') {
                fields.push(`${key} = $${idx}`);
                values.push(value ? JSON.stringify(value) : null);
            } else {
                fields.push(`${key} = $${idx}`);
                values.push(value);
            }
            idx++;
        }
    }
    if (fields.length === 0) return null;

    fields.push(`updated_at = $${idx}`);
    values.push(Date.now());
    idx++;

    values.push(id);
    const result = await pool.query(
        `UPDATE maintenance_logs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

export async function deleteMaintenanceLog(id) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE maintenance_logs SET status = 'cancelled', updated_at = $1 WHERE id = $2 RETURNING *`,
        [Date.now(), id]
    );
    return result.rows[0] || null;
}

export async function getMaintenanceStats() {
    if (!pool) return {};
    const result = await pool.query(`
        SELECT
            COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled')) as open_count,
            COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_date < $1) as overdue_count,
            COUNT(*) FILTER (WHERE status = 'scheduled'
                AND scheduled_date >= $1
                AND scheduled_date <= $2) as upcoming_week,
            COALESCE(SUM(labor_cost_cents + parts_cost_cents) FILTER (
                WHERE status = 'completed'
                AND completed_date >= $3
            ), 0) as cost_mtd_cents
        FROM maintenance_logs
    `, [Date.now(), Date.now() + 7 * 86400000, getMonthStart()]);
    return result.rows[0];
}

function getMonthStart() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export async function getUpcomingMaintenance(days = 30) {
    if (!pool) return [];
    const cutoff = Date.now() + days * 86400000;
    const result = await pool.query(
        `SELECT ml.*, js.name as job_site_name, ta.site_name as trailer_name
         FROM maintenance_logs ml
         LEFT JOIN job_sites js ON ml.job_site_id = js.id
         LEFT JOIN trailer_assignments ta ON ml.site_id = ta.site_id
         WHERE ml.status = 'scheduled' AND ml.scheduled_date <= $1
         ORDER BY ml.scheduled_date ASC`,
        [cutoff]
    );
    return result.rows;
}

// ============================================================
// Trailer Components
// ============================================================

export async function getComponents(siteId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM trailer_components WHERE site_id = $1 ORDER BY component_type, created_at`,
        [siteId]
    );
    return result.rows;
}

export async function insertComponent(comp) {
    if (!pool) return null;
    const now = Date.now();
    const result = await pool.query(
        `INSERT INTO trailer_components
         (site_id, component_type, make, model, serial_number, installed_date, warranty_expiry, status, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         RETURNING *`,
        [comp.site_id, comp.component_type, comp.make || null, comp.model || null,
         comp.serial_number || null, comp.installed_date || null, comp.warranty_expiry || null,
         comp.status || 'active', comp.notes || null, now]
    );
    return result.rows[0];
}

export async function updateComponent(id, updates) {
    if (!pool) return null;
    const allowedFields = ['component_type', 'make', 'model', 'serial_number', 'installed_date', 'warranty_expiry', 'status', 'notes'];
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            fields.push(`${key} = $${idx}`);
            values.push(value);
            idx++;
        }
    }
    if (fields.length === 0) return null;

    fields.push(`updated_at = $${idx}`);
    values.push(Date.now());
    idx++;

    values.push(id);
    const result = await pool.query(
        `UPDATE trailer_components SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

// ============================================================
// Analytics Daily Metrics
// ============================================================

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

export function getPool() {
    return pool;
}
