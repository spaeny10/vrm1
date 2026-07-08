import pg from 'pg';

const { Pool } = pg;

let pool = null;

export async function initDb() {
    const connectionString = process.env.DATABASE_URL;

    const poolConfig = {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    };

    if (connectionString) {
        pool = new Pool({
            ...poolConfig,
            connectionString,
            ssl: process.env.NODE_ENV === 'production'
                ? { rejectUnauthorized: false }
                : false,
        });
    } else {
        // Local development fallback
        pool = new Pool({
            ...poolConfig,
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

        // Add IC2 device ID column for persistent GPS binding
        await client.query(`ALTER TABLE trailer_assignments ADD COLUMN IF NOT EXISTS ic2_device_id INTEGER`);
        await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trailer_assignments_ic2_device
      ON trailer_assignments(ic2_device_id) WHERE ic2_device_id IS NOT NULL
    `);

        // Add GPS tracking columns for change detection
        await client.query(`ALTER TABLE trailer_assignments ADD COLUMN IF NOT EXISTS last_gps_lat DOUBLE PRECISION`);
        await client.query(`ALTER TABLE trailer_assignments ADD COLUMN IF NOT EXISTS last_gps_lon DOUBLE PRECISION`);
        await client.query(`ALTER TABLE trailer_assignments ADD COLUMN IF NOT EXISTS last_gps_update BIGINT`);

        console.log('  ✓ Job sites and trailer assignments tables ready');

        // Add deployment management columns to job_sites
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS is_headquarters BOOLEAN DEFAULT FALSE`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS delivery_date DATE`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS active_date DATE`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS calloff_date DATE`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS pickup_date DATE`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS geofence_radius_m INTEGER DEFAULT 500`);

        // Site Information Architecture columns
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS uid TEXT UNIQUE`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS customer_name TEXT`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS primary_contact_name TEXT`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS primary_contact_phone TEXT`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS primary_contact_email TEXT`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS secondary_contact_name TEXT`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS secondary_contact_phone TEXT`);
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS secondary_contact_email TEXT`);

        // Create site notes table for communications
        await client.query(`
      CREATE TABLE IF NOT EXISTS site_notes (
        id SERIAL PRIMARY KEY,
        job_site_id INTEGER REFERENCES job_sites(id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        author TEXT,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_site_notes_job_site ON site_notes(job_site_id)`);
        await client.query(`ALTER TABLE site_notes ADD COLUMN IF NOT EXISTS mentions JSONB DEFAULT '[]'`);
        await client.query(`ALTER TABLE site_notes ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES site_notes(id) ON DELETE CASCADE`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_site_notes_parent ON site_notes(parent_id)`);
        await client.query(`ALTER TABLE site_notes ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_site_notes_tags ON site_notes USING GIN (tags)`);
        await client.query(`ALTER TABLE site_notes ADD COLUMN IF NOT EXISTS updated_at BIGINT`);
        await client.query(`ALTER TABLE site_notes ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE`);

        // Note read receipts
        await client.query(`
      CREATE TABLE IF NOT EXISTS note_reads (
        id SERIAL PRIMARY KEY,
        note_id INTEGER NOT NULL REFERENCES site_notes(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        read_at BIGINT NOT NULL,
        UNIQUE(note_id, user_id)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_note_reads_note ON note_reads(note_id)`);

        // Audit log table
        await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id INTEGER,
        action TEXT NOT NULL,
        details JSONB DEFAULT '{}',
        actor TEXT,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC)`);
        console.log('  ✓ Audit log table ready');

        // Users table (authentication + roles) — must exist before tables that
        // reference users(id), e.g. gps_change_suggestions on a fresh install
        await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','technician','viewer')),
        active BOOLEAN DEFAULT TRUE,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
        // Google SSO columns
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login BIGINT`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN DEFAULT FALSE`);
        console.log('  ✓ Users table ready');

        // Extend users role constraint to include 'customer'
        await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
        await client.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','technician','viewer','customer'))`);

        // Companies table
        await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT,
        city TEXT,
        state TEXT,
        zip TEXT,
        notes TEXT,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name ON companies(name)`);

        // Contacts table
        await client.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        title TEXT,
        phone TEXT,
        email TEXT,
        is_primary BOOLEAN DEFAULT false,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id)`);

        // Site-contacts junction table
        await client.query(`
      CREATE TABLE IF NOT EXISTS site_contacts (
        id SERIAL PRIMARY KEY,
        job_site_id INTEGER REFERENCES job_sites(id) ON DELETE CASCADE,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
        role TEXT DEFAULT 'on-site',
        UNIQUE(job_site_id, contact_id)
      )
    `);

        // GPS change suggestions table for automatic relocation detection
        await client.query(`
      CREATE TABLE IF NOT EXISTS gps_change_suggestions (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL,
        site_name TEXT NOT NULL,
        old_latitude DOUBLE PRECISION,
        old_longitude DOUBLE PRECISION,
        new_latitude DOUBLE PRECISION NOT NULL,
        new_longitude DOUBLE PRECISION NOT NULL,
        distance_km REAL NOT NULL,
        current_job_site_id INTEGER REFERENCES job_sites(id),
        current_job_site_name TEXT,
        suggested_job_site_id INTEGER REFERENCES job_sites(id),
        suggested_job_site_name TEXT,
        suggestion_type TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        resolved_at BIGINT,
        resolved_by INTEGER REFERENCES users(id)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_gps_suggestions_status ON gps_change_suggestions(status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_gps_suggestions_site ON gps_change_suggestions(site_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_gps_suggestions_created ON gps_change_suggestions(created_at DESC)`);

        // Add company_id FK to job_sites
        await client.query(`ALTER TABLE job_sites ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`);
        console.log('  ✓ Company/Contact tables ready');
        console.log('  ✓ GPS change detection tables ready');

        // Auto-flag Big View HQ as headquarters
        await client.query(`UPDATE job_sites SET is_headquarters = TRUE WHERE name ILIKE '%big view hq%' AND (is_headquarters IS NULL OR is_headquarters = FALSE)`);
        // Fix: clustering bug overwrote HQ coordinates with remote site GPS — clear them
        await client.query(`UPDATE job_sites SET latitude = NULL, longitude = NULL WHERE is_headquarters = TRUE AND latitude IS NOT NULL`);
        console.log('  ✓ Deployment management columns ready');

        // Promote VRM diagnostic fields from JSONB to dedicated columns
        await client.query(`ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS consumed_ah REAL`);
        await client.query(`ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS dc_load_watts REAL`);
        await client.query(`ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS load_current REAL`);
        await client.query(`ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS load_state TEXT`);
        await client.query(`ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS inverter_mode TEXT`);
        await client.query(`ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS mppt_state TEXT`);
        await client.query(`ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS alarm_reason TEXT`);
        await client.query(`ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS error_code TEXT`);
        await client.query(`ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS lifetime_yield_kwh REAL`);
        await client.query(`ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS time_to_go_min REAL`);
        console.log('  ✓ Extended VRM diagnostic columns ready');

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

        // Database indexes for name-based lookups
        await client.query(`CREATE INDEX IF NOT EXISTS idx_site_snapshots_site_name ON site_snapshots(site_name)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_pepwave_snapshots_device_name ON pepwave_snapshots(device_name)`);

        // Daily energy summary (persists across server restarts)
        await client.query(`
      CREATE TABLE IF NOT EXISTS daily_energy_summary (
        site_id INTEGER NOT NULL,
        date DATE NOT NULL,
        site_name TEXT,
        yield_wh NUMERIC,
        consumed_wh NUMERIC,
        updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        PRIMARY KEY (site_id, date)
      )
    `);

        // Add soc_start_of_day column for persistent consumption estimation
        await client.query(`ALTER TABLE daily_energy_summary ADD COLUMN IF NOT EXISTS soc_start_of_day REAL`);

        // Add expected_yield_wh column so each day's score uses that day's weather
        await client.query(`ALTER TABLE daily_energy_summary ADD COLUMN IF NOT EXISTS expected_yield_wh NUMERIC`);
        await client.query(`ALTER TABLE daily_energy_summary ADD COLUMN IF NOT EXISTS consumption_source TEXT`);

        // Add end-of-day state columns for intelligent deficit detection
        await client.query(`ALTER TABLE daily_energy_summary ADD COLUMN IF NOT EXISTS battery_soc_eod REAL`);
        await client.query(`ALTER TABLE daily_energy_summary ADD COLUMN IF NOT EXISTS mppt_state_eod INTEGER`);

        // Alert history (persists across server restarts)
        await client.query(`
      CREATE TABLE IF NOT EXISTS alert_history (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL,
        site_name TEXT,
        severity TEXT NOT NULL,
        streak_days INTEGER NOT NULL,
        deficit_wh NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `);

        await client.query(`ALTER TABLE alert_history ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_alert_history_active ON alert_history(site_id) WHERE resolved_at IS NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_alert_history_created ON alert_history(created_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_daily_energy_date ON daily_energy_summary(date DESC)`);

        // One-time fix: CE diagnostic resets to 0 at battery sync, causing bogus
        // consumed_wh = 0 entries.  Null them out so Tier 3 (SOC delta) can
        // replace them with real estimates on the next polling cycle.
        const fixResult = await client.query(
            `UPDATE daily_energy_summary SET consumed_wh = NULL WHERE consumed_wh = 0`
        );
        if (fixResult.rowCount > 0) {
            console.log(`  ✓ Cleaned ${fixResult.rowCount} bogus consumed_wh=0 entries`);
        }

        console.log('  ✓ Energy summary, alert history tables ready');

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

        // Customer site access (customer portal)
        await client.query(`
      CREATE TABLE IF NOT EXISTS customer_site_access (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_site_id INTEGER NOT NULL REFERENCES job_sites(id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        UNIQUE(user_id, job_site_id)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_customer_site_user ON customer_site_access(user_id)`);
        console.log('  ✓ Customer portal tables ready');

        // Action queue acknowledgements
        await client.query(`
      CREATE TABLE IF NOT EXISTS action_queue_acks (
        id SERIAL PRIMARY KEY,
        action_key TEXT NOT NULL UNIQUE,
        acknowledged_by INTEGER REFERENCES users(id),
        acknowledged_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        notes TEXT
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_ack_key ON action_queue_acks(action_key)`);

        // Checklist templates (admin-editable inspection checklists)
        await client.query(`
      CREATE TABLE IF NOT EXISTS checklist_templates (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        visit_type TEXT NOT NULL,
        items JSONB NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);

        // Completed checklists (linked to maintenance logs)
        await client.query(`
      CREATE TABLE IF NOT EXISTS completed_checklists (
        id SERIAL PRIMARY KEY,
        maintenance_log_id INTEGER REFERENCES maintenance_logs(id) ON DELETE CASCADE,
        template_id INTEGER REFERENCES checklist_templates(id),
        template_name TEXT,
        completed_by INTEGER REFERENCES users(id),
        items JSONB NOT NULL,
        completed_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_checklists_maint ON completed_checklists(maintenance_log_id)`);

        // Issue templates (common maintenance log prefills)
        await client.query(`
      CREATE TABLE IF NOT EXISTS issue_templates (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        visit_type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        expected_parts JSONB,
        estimated_hours REAL,
        active BOOLEAN DEFAULT TRUE,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);

        console.log('  ✓ Checklists, issue templates, action queue tables ready');

        // Add assigned_technician_id to maintenance_logs if not exists
        await client.query(`
      ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS assigned_technician_id INTEGER REFERENCES users(id)
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_maintenance_technician ON maintenance_logs(assigned_technician_id)`);

        // Additional performance indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON site_snapshots(timestamp DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance_logs(status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_maintenance_scheduled ON maintenance_logs(scheduled_date)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_daily_energy_site_date ON daily_energy_summary(site_id, date DESC)`);

        // Recurring maintenance support
        await client.query(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS recurrence_rule TEXT`);
        await client.query(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS recurrence_end_date BIGINT`);
        await client.query(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS parent_log_id INTEGER REFERENCES maintenance_logs(id) ON DELETE SET NULL`);

        // Seed default checklist templates
        const checklistCount = await client.query(`SELECT count(*) FROM checklist_templates`);
        if (parseInt(checklistCount.rows[0].count) === 0) {
            await client.query(`
          INSERT INTO checklist_templates (name, visit_type, items) VALUES
          ('Routine Inspection', 'inspection', $1),
          ('Solar Troubleshooting', 'repair', $2),
          ('Battery Service', 'scheduled', $3),
          ('Network Fix', 'repair', $4)
        `, [
                JSON.stringify([
                    { text: 'Check solar panel cleanliness', required: true },
                    { text: 'Inspect wiring and connections', required: true },
                    { text: 'Verify battery terminal tightness', required: true },
                    { text: 'Check charge controller LED indicators', required: false },
                    { text: 'Verify network connectivity', required: false },
                    { text: 'Inspect enclosure seals and weatherproofing', required: true },
                    { text: 'Check for physical damage or vandalism', required: true },
                    { text: 'Verify ventilation and airflow', required: false },
                ]),
                JSON.stringify([
                    { text: 'Measure panel open-circuit voltage', required: true },
                    { text: 'Check MC4 connector integrity', required: true },
                    { text: 'Inspect for shading obstructions', required: true },
                    { text: 'Verify charge controller settings', required: true },
                    { text: 'Measure string current', required: false },
                    { text: 'Clean panel surfaces', required: false },
                    { text: 'Check panel mounting and tilt angle', required: false },
                ]),
                JSON.stringify([
                    { text: 'Measure individual cell voltages', required: true },
                    { text: 'Check battery terminal torque', required: true },
                    { text: 'Inspect for corrosion or swelling', required: true },
                    { text: 'Verify BMS settings and operation', required: true },
                    { text: 'Check battery ventilation', required: false },
                    { text: 'Record battery temperature', required: true },
                    { text: 'Test load disconnect function', required: false },
                ]),
                JSON.stringify([
                    { text: 'Check SIM card seating', required: true },
                    { text: 'Verify APN settings', required: true },
                    { text: 'Test signal strength at location', required: true },
                    { text: 'Inspect antenna connections', required: true },
                    { text: 'Check router firmware version', required: false },
                    { text: 'Verify WAN interface status', required: true },
                    { text: 'Test client device connectivity', required: false },
                ]),
            ]);
            console.log('  ✓ Default checklist templates seeded');
        }

        // Seed default issue templates
        const issueCount = await client.query(`SELECT count(*) FROM issue_templates`);
        if (parseInt(issueCount.rows[0].count) === 0) {
            await client.query(`
          INSERT INTO issue_templates (name, visit_type, title, description, expected_parts, estimated_hours) VALUES
          ('Panel Cleaning', 'inspection', 'Solar Panel Cleaning', 'Clean all solar panels to remove dust, debris, and bird droppings affecting output.', '[]', 1.0),
          ('Battery Replacement', 'repair', 'Battery Replacement', 'Replace failing battery unit. Disconnect old battery, install new unit, verify BMS configuration.', $1, 3.0),
          ('Network Troubleshooting', 'repair', 'Network Connectivity Repair', 'Diagnose and resolve cellular network connectivity issues.', '[]', 1.5),
          ('Generator Service', 'scheduled', 'Generator Maintenance', 'Scheduled generator maintenance including oil change, filter replacement, and run test.', $2, 2.0),
          ('Charge Controller Reset', 'repair', 'Charge Controller Reset/Replacement', 'Reset or replace solar charge controller. Verify settings and solar input after service.', '[]', 1.0),
          ('Antenna Replacement', 'repair', 'Cellular Antenna Replacement', 'Replace damaged or underperforming cellular antenna.', $3, 1.0)
        `, [
                JSON.stringify([{ name: '230Ah 24V Battery', quantity: 1 }]),
                JSON.stringify([{ name: 'Oil Filter', quantity: 1 }, { name: 'Spark Plug', quantity: 1 }]),
                JSON.stringify([{ name: 'Cellular Antenna', quantity: 1 }]),
            ]);
            console.log('  ✓ Default issue templates seeded');
        }

        // ============================================================
        // Rental & Billing tables (trailer rental lifecycle)
        // ============================================================

        // Trailers as first-class assets (decoupled from VRM installation IDs)
        await client.query(`
      CREATE TABLE IF NOT EXISTS trailers (
        id SERIAL PRIMARY KEY,
        unit_number TEXT NOT NULL UNIQUE,
        vin TEXT,
        vrm_site_id INTEGER UNIQUE,
        ic2_device_id INTEGER,
        status TEXT DEFAULT 'available',
        home_base_job_site_id INTEGER REFERENCES job_sites(id) ON DELETE SET NULL,
        purchase_date DATE,
        condition_notes TEXT,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_trailers_status ON trailers(status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_trailers_vrm_site ON trailers(vrm_site_id) WHERE vrm_site_id IS NOT NULL`);

        // Rentals: one row per trailer per rental engagement (commercial truth)
        await client.query(`
      CREATE TABLE IF NOT EXISTS rentals (
        id SERIAL PRIMARY KEY,
        trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE CASCADE,
        job_site_id INTEGER REFERENCES job_sites(id) ON DELETE SET NULL,
        company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        po_number TEXT,
        reserved_at DATE,
        delivered_at DATE,
        billing_start DATE,
        calloff_at DATE,
        billing_stop DATE,
        picked_up_at DATE,
        returned_at DATE,
        rate_amount NUMERIC(10,2),
        rate_period TEXT DEFAULT 'month',
        status TEXT DEFAULT 'reserved',
        notes TEXT,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        updated_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_rentals_trailer ON rentals(trailer_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_rentals_job_site ON rentals(job_site_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_rentals_status ON rentals(status)`);
        // One open rental per trailer at a time
        await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rentals_one_open_per_trailer
      ON rentals(trailer_id) WHERE status NOT IN ('closed', 'cancelled')
    `);

        // Immutable event log: who started/stopped billing and when
        await client.query(`
      CREATE TABLE IF NOT EXISTS rental_events (
        id SERIAL PRIMARY KEY,
        rental_id INTEGER NOT NULL REFERENCES rentals(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        event_date DATE NOT NULL,
        actor TEXT,
        notes TEXT,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)
      )
    `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_rental_events_rental ON rental_events(rental_id)`);
        console.log('  ✓ Rental & billing tables ready');

        // ============================================================
        // Pricing: rate cards + enterprise volume tiers
        // ============================================================

        // Base rate per product per commitment term
        await client.query(`
      CREATE TABLE IF NOT EXISTS rate_cards (
        id SERIAL PRIMARY KEY,
        product_code TEXT NOT NULL,
        commitment_term TEXT NOT NULL,
        billing_cycle TEXT NOT NULL,
        base_rate NUMERIC(10,2) NOT NULL,
        active BOOLEAN DEFAULT TRUE,
        created_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000),
        UNIQUE(product_code, commitment_term)
      )
    `);

        // Enterprise Agreement volume discount tiers (applied off base rate,
        // resolved per customer at the opening of each billing cycle)
        await client.query(`
      CREATE TABLE IF NOT EXISTS volume_tiers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        min_units INTEGER NOT NULL,
        max_units INTEGER,
        discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0
      )
    `);

        // Seed the BV1305 commercial rate structure (FY2026 pricing guide)
        await client.query(`
      INSERT INTO rate_cards (product_code, commitment_term, billing_cycle, base_rate) VALUES
        ('BV1305', 'monthly', 'calendar_month', 2250.00),
        ('BV1305', '6_month', '28_day', 2050.00),
        ('BV1305', '1_year', '28_day', 1923.00)
      ON CONFLICT (product_code, commitment_term) DO NOTHING
    `);
        await client.query(`
      INSERT INTO volume_tiers (name, min_units, max_units, discount_pct) VALUES
        ('Standard', 1, 9, 0),
        ('Bronze', 10, 24, 7.25),
        ('Silver', 25, 49, 10.00),
        ('Gold', 50, NULL, 12.50)
      ON CONFLICT (name) DO NOTHING
    `);

        // Product + pricing columns on existing tables
        await client.query(`ALTER TABLE trailers ADD COLUMN IF NOT EXISTS product_code TEXT DEFAULT 'BV1305'`);
        await client.query(`ALTER TABLE rentals ADD COLUMN IF NOT EXISTS commitment_term TEXT DEFAULT 'monthly'`);
        await client.query(`ALTER TABLE rentals ADD COLUMN IF NOT EXISTS rollback_amount NUMERIC(12,2)`);
        console.log('  ✓ Pricing rate cards ready (BV1305 seeded)');

        // Backfill trailers from existing GPS-derived assignments (idempotent)
        await client.query(`
      INSERT INTO trailers (unit_number, vrm_site_id, ic2_device_id)
      SELECT ta.site_name, ta.site_id, ta.ic2_device_id
      FROM trailer_assignments ta
      WHERE NOT EXISTS (SELECT 1 FROM trailers t WHERE t.vrm_site_id = ta.site_id)
      ON CONFLICT (unit_number) DO NOTHING
    `);

        // One-time rental backfill: open a rental for every trailer currently
        // deployed on a customer job site, seeded from the site's lifecycle dates
        const rentalsBackfilled = await client.query(`SELECT value FROM settings WHERE key = 'rentals_backfilled'`);
        if (rentalsBackfilled.rows.length === 0) {
            await client.query(`
        INSERT INTO rentals (trailer_id, job_site_id, company_id, delivered_at, billing_start, calloff_at, status, notes)
        SELECT t.id, js.id, js.company_id,
               js.delivery_date,
               COALESCE(js.active_date, js.delivery_date, to_timestamp(ta.assigned_at / 1000)::date),
               js.calloff_date,
               CASE
                 WHEN js.status = 'active' THEN 'billing'
                 WHEN js.status = 'standby' THEN 'delivered'
                 ELSE 'awaiting_pickup'
               END,
               'Backfilled from job site assignment'
        FROM trailers t
        JOIN trailer_assignments ta ON ta.site_id = t.vrm_site_id
        JOIN job_sites js ON js.id = ta.job_site_id
        WHERE js.is_headquarters IS NOT TRUE
          AND NOT EXISTS (
            SELECT 1 FROM rentals r
            WHERE r.trailer_id = t.id AND r.status NOT IN ('closed', 'cancelled')
          )
      `);
            await client.query(`
        UPDATE trailers SET status = 'on_rent'
        WHERE id IN (SELECT trailer_id FROM rentals WHERE status NOT IN ('closed', 'cancelled'))
      `);
            await client.query(`INSERT INTO settings (key, value) VALUES ('rentals_backfilled', '1') ON CONFLICT (key) DO NOTHING`);
            console.log('  ✓ Rentals backfilled from current trailer assignments');
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

export async function getSetting(key, defaultValue = null) {
    if (!pool) return defaultValue;
    const result = await pool.query("SELECT value FROM settings WHERE key=$1", [key]);
    if (result.rows.length === 0) return defaultValue;
    return result.rows[0].value;
}

export async function setSetting(key, value) {
    if (!pool) return;
    await pool.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
        [key, String(value)]
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

    // Get active/recent maintenance logs with context
    const maintenance = await pool.query(`
        SELECT m.*, j.name AS job_site_name,
               ta.site_name AS trailer_name,
               u.display_name AS assigned_technician_name
        FROM maintenance_logs m
        LEFT JOIN job_sites j ON m.job_site_id = j.id
        LEFT JOIN trailer_assignments ta ON m.site_id = ta.site_id
        LEFT JOIN users u ON m.assigned_technician_id = u.id
        WHERE m.status != 'cancelled'
        ORDER BY m.updated_at DESC
        LIMIT 200
    `);

    // Get all job sites with trailer counts
    const jobSites = await pool.query(`
        SELECT js.*, COUNT(ta.id) AS trailer_count
        FROM job_sites js
        LEFT JOIN trailer_assignments ta ON ta.job_site_id = js.id
        GROUP BY js.id
        ORDER BY js.status, js.name
    `);

    return {
        sites: sites.rows,
        devices: devices.rows,
        maintenance: maintenance.rows,
        jobSites: jobSites.rows,
    };
}

// ============================================================
// Job Sites
// ============================================================

export async function getJobSites() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM job_sites ORDER BY
            CASE WHEN status = 'active' THEN 0 WHEN status = 'standby' THEN 1 ELSE 2 END, name`
    );
    return result.rows;
}

export async function getJobSite(id) {
    if (!pool) return null;
    const result = await pool.query(`SELECT * FROM job_sites WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function getJobSiteByPhone(phone) {
    if (!pool || !phone) return null;
    const cleanPhone = phone.replace(/\D/g, '');
    if (!cleanPhone) return null;
    // Search CRM contacts linked to job sites via site_contacts
    const result = await pool.query(`
        SELECT js.* FROM job_sites js
        JOIN site_contacts sc ON sc.job_site_id = js.id
        JOIN contacts c ON c.id = sc.contact_id
        WHERE regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE '%' || $1 || '%'
        LIMIT 1
    `, [cleanPhone.slice(-10)]);
    return result.rows[0] || null;
}

export async function insertJobSite(site) {
    if (!pool) return null;

    // Collision-safe UID generation with retry loop
    let uid = site.uid;
    if (!uid) {
        for (let attempt = 0; attempt < 5; attempt++) {
            uid = `SITE-${Math.floor(Math.random() * 90000) + 10000}`;
            const existing = await pool.query(`SELECT id FROM job_sites WHERE uid = $1`, [uid]);
            if (existing.rows.length === 0) break;
            if (attempt === 4) uid = `SITE-${Date.now().toString(36).toUpperCase()}`; // fallback guaranteed unique
        }
    }

    const result = await pool.query(
        `INSERT INTO job_sites (
            name, latitude, longitude, address, status, notes, uid,
            created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING *`,
        [
            site.name,
            site.latitude,
            site.longitude,
            site.address || null,
            site.status || 'active',
            site.notes || null,
            uid,
            Date.now()
        ]
    );
    return result.rows[0];
}

export async function updateJobSite(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (['name', 'latitude', 'longitude', 'address', 'status', 'notes', 'is_headquarters', 'delivery_date', 'active_date', 'calloff_date', 'pickup_date', 'geofence_radius_m', 'uid', 'company_id'].includes(key)) {
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

export async function deleteJobSite(id) {
    if (!pool) return null;
    const result = await pool.query('DELETE FROM job_sites WHERE id = $1 RETURNING *', [id]);
    return result.rows[0] || null;
}

// ============================================================
// Site Notes
// ============================================================
export async function getSiteNotes(jobSiteId, { limit = 50, offset = 0, search, tag, author } = {}) {
    if (!pool) return { notes: [], total: 0 };
    const conditions = ['sn.job_site_id = $1', 'sn.parent_id IS NULL'];
    const params = [jobSiteId];
    let paramIdx = 2;
    if (search) {
        conditions.push(`sn.note ILIKE $${paramIdx++}`);
        params.push(`%${search}%`);
    }
    if (tag) {
        conditions.push(`sn.tags @> $${paramIdx++}::jsonb`);
        params.push(JSON.stringify([{ label: tag }]));
    }
    if (author) {
        conditions.push(`sn.author = $${paramIdx++}`);
        params.push(author);
    }
    const where = 'WHERE ' + conditions.join(' AND ');
    const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM site_notes sn ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);
    const dataParams = [...params, limit, offset];
    const result = await pool.query(
        `SELECT sn.*, (SELECT COUNT(*) FROM site_notes r WHERE r.parent_id = sn.id) as reply_count
         FROM site_notes sn
         ${where}
         ORDER BY sn.pinned DESC NULLS LAST, sn.created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        dataParams
    );
    return { notes: result.rows, total };
}

export async function getReplies(noteId) {
    if (!pool) return [];
    const result = await pool.query(
        'SELECT * FROM site_notes WHERE parent_id = $1 ORDER BY created_at ASC',
        [noteId]
    );
    return result.rows;
}

export async function getAllSiteNotes({ limit = 100, offset = 0, siteId, author, search, dateFrom, dateTo } = {}) {
    if (!pool) return { notes: [], total: 0 };
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (siteId) {
        conditions.push(`sn.job_site_id = $${paramIdx++}`);
        params.push(siteId);
    }
    if (author) {
        conditions.push(`sn.author ILIKE $${paramIdx++}`);
        params.push(`%${author}%`);
    }
    if (search) {
        conditions.push(`sn.note ILIKE $${paramIdx++}`);
        params.push(`%${search}%`);
    }
    if (dateFrom) {
        conditions.push(`sn.created_at >= $${paramIdx++}`);
        params.push(dateFrom);
    }
    if (dateTo) {
        conditions.push(`sn.created_at <= $${paramIdx++}`);
        params.push(dateTo);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM site_notes sn ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    const dataParams = [...params, limit, offset];
    const result = await pool.query(
        `SELECT sn.*, js.name as site_name, js.address as site_address
         FROM site_notes sn
         LEFT JOIN job_sites js ON sn.job_site_id = js.id
         ${where}
         ORDER BY sn.created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        dataParams
    );
    return { notes: result.rows, total };
}

export async function getSiteNote(noteId) {
    if (!pool) return null;
    const result = await pool.query('SELECT * FROM site_notes WHERE id = $1', [noteId]);
    return result.rows[0] || null;
}

export async function insertSiteNote(jobSiteId, noteText, author = 'system', mentions = [], parentId = null, tags = []) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO site_notes (job_site_id, note, author, mentions, parent_id, tags, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [jobSiteId, noteText, author, JSON.stringify(mentions), parentId, JSON.stringify(tags), Date.now()]
    );
    return result.rows[0];
}

export async function updateSiteNote(noteId, newText) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE site_notes SET note = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
        [newText, Date.now(), noteId]
    );
    return result.rows[0];
}

export async function deleteSiteNote(noteId) {
    if (!pool) return;
    await pool.query('DELETE FROM site_notes WHERE id = $1', [noteId]);
}

export async function togglePinNote(noteId, pinned) {
    if (!pool) return null;
    const result = await pool.query(
        'UPDATE site_notes SET pinned = $1 WHERE id = $2 RETURNING *',
        [pinned, noteId]
    );
    return result.rows[0];
}

export async function markNoteRead(noteId, userId) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO note_reads (note_id, user_id, read_at) VALUES ($1, $2, $3)
         ON CONFLICT (note_id, user_id) DO NOTHING`,
        [noteId, userId, Date.now()]
    );
}

export async function getNoteReaders(noteIds) {
    if (!pool || !noteIds.length) return {};
    const result = await pool.query(
        `SELECT nr.note_id, nr.read_at, u.id as user_id, u.display_name
         FROM note_reads nr
         JOIN users u ON u.id = nr.user_id
         WHERE nr.note_id = ANY($1)
         ORDER BY nr.read_at ASC`,
        [noteIds]
    );
    const grouped = {};
    for (const row of result.rows) {
        if (!grouped[row.note_id]) grouped[row.note_id] = [];
        grouped[row.note_id].push({ user_id: row.user_id, display_name: row.display_name, read_at: row.read_at });
    }
    return grouped;
}

export async function getNotesByTrailer(siteId, { limit = 20, offset = 0 } = {}) {
    if (!pool) return { notes: [], total: 0 };
    const tagFilter = `EXISTS (
        SELECT 1 FROM jsonb_array_elements(sn.tags) tag
        WHERE tag->>'type' = 'trailer' AND (tag->>'id')::integer = $1
    ) AND sn.parent_id IS NULL`;
    const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM site_notes sn WHERE ${tagFilter}`,
        [siteId]
    );
    const total = parseInt(countResult.rows[0].total);
    const result = await pool.query(
        `SELECT sn.*, js.name as job_site_name,
                (SELECT COUNT(*) FROM site_notes r WHERE r.parent_id = sn.id) as reply_count
         FROM site_notes sn
         LEFT JOIN job_sites js ON sn.job_site_id = js.id
         WHERE ${tagFilter}
         ORDER BY sn.created_at DESC LIMIT $2 OFFSET $3`,
        [siteId, limit, offset]
    );
    return { notes: result.rows, total };
}

// ============================================================
// Companies
// ============================================================
export async function getCompanies() {
    if (!pool) return [];
    const result = await pool.query(`
        SELECT c.*, 
            (SELECT COUNT(*) FROM job_sites WHERE company_id = c.id) as site_count,
            (SELECT COUNT(*) FROM contacts WHERE company_id = c.id) as contact_count
        FROM companies c ORDER BY c.name
    `);
    return result.rows;
}

export async function getCompany(id) {
    if (!pool) return null;
    const result = await pool.query(`SELECT * FROM companies WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function insertCompany(company) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO companies (name, address, city, state, zip, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
        [company.name, company.address || null, company.city || null, company.state || null, company.zip || null, company.notes || null, Date.now()]
    );
    return result.rows[0];
}

export async function updateCompany(id, data) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const key of ['name', 'address', 'city', 'state', 'zip', 'notes']) {
        if (data[key] !== undefined) {
            fields.push(`${key} = $${idx}`);
            values.push(data[key]);
            idx++;
        }
    }
    if (fields.length === 0) return null;
    fields.push(`updated_at = $${idx}`);
    values.push(Date.now());
    idx++;
    values.push(id);
    const result = await pool.query(
        `UPDATE companies SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0];
}

// ============================================================
// Contacts
// ============================================================
export async function getContacts(companyId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM contacts WHERE company_id = $1 ORDER BY is_primary DESC, name`,
        [companyId]
    );
    return result.rows;
}

export async function insertContact(contact) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO contacts (company_id, name, title, phone, email, is_primary, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [contact.company_id, contact.name, contact.title || null, contact.phone || null, contact.email || null, contact.is_primary || false, Date.now()]
    );
    return result.rows[0];
}

export async function updateContact(id, data) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const key of ['name', 'title', 'phone', 'email', 'is_primary']) {
        if (data[key] !== undefined) {
            fields.push(`${key} = $${idx}`);
            values.push(data[key]);
            idx++;
        }
    }
    if (fields.length === 0) return null;
    values.push(id);
    const result = await pool.query(
        `UPDATE contacts SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0];
}

export async function deleteContact(id) {
    if (!pool) return;
    await pool.query(`DELETE FROM contacts WHERE id = $1`, [id]);
}

export async function getContactById(id) {
    if (!pool) return null;
    const result = await pool.query(`SELECT * FROM contacts WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function getContactSiteIds(contactId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT DISTINCT job_site_id FROM site_contacts WHERE contact_id = $1`, [contactId]
    );
    return result.rows.map(r => r.job_site_id);
}

export async function setContactPortalUserId(contactId, userId) {
    if (!pool) return;
    await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS portal_user_id INTEGER`);
    await pool.query(`UPDATE contacts SET portal_user_id = $1 WHERE id = $2`, [userId, contactId]);
}

// ============================================================
// Site Contacts (junction)
// ============================================================
export async function getSiteContacts(jobSiteId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT sc.id, sc.role, c.id as contact_id, c.name, c.title, c.phone, c.email, c.is_primary, co.name as company_name
         FROM site_contacts sc
         JOIN contacts c ON sc.contact_id = c.id
         LEFT JOIN companies co ON c.company_id = co.id
         WHERE sc.job_site_id = $1
         ORDER BY c.is_primary DESC, c.name`,
        [jobSiteId]
    );
    return result.rows;
}

export async function assignContactToSite(jobSiteId, contactId, role = 'on-site') {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO site_contacts (job_site_id, contact_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (job_site_id, contact_id) DO UPDATE SET role = $3
         RETURNING *`,
        [jobSiteId, contactId, role]
    );
    return result.rows[0];
}

export async function removeContactFromSite(jobSiteId, contactId) {
    if (!pool) return;
    await pool.query(`DELETE FROM site_contacts WHERE job_site_id = $1 AND contact_id = $2`, [jobSiteId, contactId]);
}

// ============================================================
// Audit Log
// ============================================================
export async function insertAuditLog(entityType, entityId, action, details = {}, actor = 'system') {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO audit_log (entity_type, entity_id, action, details, actor, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [entityType, entityId, action, JSON.stringify(details), actor, Date.now()]
    );
    return result.rows[0];
}

export async function getAuditLog({ entityType, entityId, limit = 50, offset = 0 } = {}) {
    if (!pool) return { entries: [], total: 0 };
    let where = 'WHERE 1=1';
    const params = [];
    let idx = 1;

    if (entityType) {
        where += ` AND entity_type = $${idx}`;
        params.push(entityType);
        idx++;
    }
    if (entityId) {
        where += ` AND entity_id = $${idx}`;
        params.push(entityId);
        idx++;
    }

    const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM audit_log ${where}`,
        params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await pool.query(
        `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        params
    );
    return { entries: result.rows, total };
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

export async function upsertTrailerAssignment(siteId, siteName, latitude, longitude, jobSiteId = null, ic2DeviceId = null) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO trailer_assignments (site_id, site_name, latitude, longitude, job_site_id, ic2_device_id, assigned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (site_id) DO UPDATE SET
           site_name = $2,
           latitude = COALESCE($3, trailer_assignments.latitude),
           longitude = COALESCE($4, trailer_assignments.longitude),
           job_site_id = CASE WHEN trailer_assignments.manual_override THEN trailer_assignments.job_site_id ELSE COALESCE($5, trailer_assignments.job_site_id) END,
           ic2_device_id = COALESCE($6, trailer_assignments.ic2_device_id),
           assigned_at = $7
         RETURNING *`,
        [siteId, siteName, latitude, longitude, jobSiteId, ic2DeviceId, Date.now()]
    );
    return result.rows[0];
}

export async function linkIc2Device(siteId, ic2DeviceId) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE trailer_assignments SET ic2_device_id = $1, assigned_at = $2 WHERE site_id = $3 RETURNING *`,
        [ic2DeviceId, Date.now(), siteId]
    );
    return result.rows[0] || null;
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

/**
 * Updates trailer GPS tracking data (last known position)
 * Used for GPS change detection
 */
export async function updateTrailerGps(siteId, latitude, longitude) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE trailer_assignments
         SET last_gps_lat = $2,
             last_gps_lon = $3,
             last_gps_update = $4
         WHERE site_id = $1
         RETURNING *`,
        [siteId, latitude, longitude, Date.now()]
    );
    return result.rows[0] || null;
}

/**
 * Gets GPS change suggestions filtered by status
 */
export async function getGpsSuggestions(status = 'pending') {
    if (!pool) return [];
    const result = await pool.query(
        'SELECT * FROM gps_change_suggestions WHERE status = $1 ORDER BY created_at DESC',
        [status]
    );
    return result.rows;
}

/**
 * Updates GPS suggestion status (approve/reject)
 */
export async function updateGpsSuggestionStatus(suggestionId, status, resolvedBy) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE gps_change_suggestions
         SET status = $2, resolved_at = $3, resolved_by = $4
         WHERE id = $1
         RETURNING *`,
        [suggestionId, status, Date.now(), resolvedBy]
    );
    return result.rows[0] || null;
}

// ============================================================
// Maintenance Logs
// ============================================================

export async function getMaintenanceLogs(filters = {}) {
    if (!pool) return [];
    let query = `SELECT ml.*, js.name as job_site_name, ta.site_name as trailer_name,
                        u.display_name as assigned_technician_name
                 FROM maintenance_logs ml
                 LEFT JOIN job_sites js ON ml.job_site_id = js.id
                 LEFT JOIN trailer_assignments ta ON ml.site_id = ta.site_id
                 LEFT JOIN users u ON ml.assigned_technician_id = u.id
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
        `SELECT ml.*, js.name as job_site_name, ta.site_name as trailer_name,
                u.display_name as assigned_technician_name
         FROM maintenance_logs ml
         LEFT JOIN job_sites js ON ml.job_site_id = js.id
         LEFT JOIN trailer_assignments ta ON ml.site_id = ta.site_id
         LEFT JOIN users u ON ml.assigned_technician_id = u.id
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
         (job_site_id, site_id, visit_type, status, title, description, technician, assigned_technician_id,
          scheduled_date, completed_date, labor_hours, labor_cost_cents, parts_cost_cents, parts_used,
          recurrence_rule, recurrence_end_date, parent_log_id,
          created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)
         RETURNING *`,
        [
            log.job_site_id || null, log.site_id || null, log.visit_type, log.status || 'scheduled',
            log.title, log.description || null, log.technician || null, log.assigned_technician_id || null,
            log.scheduled_date || null, log.completed_date || null,
            log.labor_hours || null, log.labor_cost_cents || 0, log.parts_cost_cents || 0,
            log.parts_used ? JSON.stringify(log.parts_used) : null,
            log.recurrence_rule || null, log.recurrence_end_date || null, log.parent_log_id || null,
            now
        ]
    );
    return result.rows[0];
}

export async function updateMaintenanceLog(id, updates) {
    if (!pool) return null;
    const allowedFields = [
        'job_site_id', 'site_id', 'visit_type', 'status', 'title', 'description',
        'technician', 'assigned_technician_id', 'scheduled_date', 'completed_date',
        'labor_hours', 'labor_cost_cents', 'parts_cost_cents', 'parts_used',
        'recurrence_rule', 'recurrence_end_date', 'parent_log_id'
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

export async function getMaintenanceCostsByJobSite(days = 30) {
    if (!pool) return [];
    const cutoffMs = Date.now() - days * 86400000;
    const result = await pool.query(
        `SELECT
            js.id as job_site_id,
            js.name as job_site_name,
            COUNT(ml.id) as log_count,
            COALESCE(SUM(ml.labor_cost_cents), 0) as labor_cost_cents,
            COALESCE(SUM(ml.parts_cost_cents), 0) as parts_cost_cents,
            COALESCE(SUM(ml.labor_cost_cents + ml.parts_cost_cents), 0) as total_cost_cents
         FROM job_sites js
         INNER JOIN maintenance_logs ml ON ml.job_site_id = js.id
            AND ml.created_at >= $1
            AND ml.status != 'cancelled'
         WHERE js.status = 'active'
         GROUP BY js.id, js.name
         HAVING SUM(ml.labor_cost_cents + ml.parts_cost_cents) > 0
         ORDER BY total_cost_cents DESC`,
        [cutoffMs]
    );
    return result.rows;
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

// ============================================================
// Daily Energy Summary (persistent)
// ============================================================

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

export async function createUser(username, passwordHash, displayName, role) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO users (username, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4) RETURNING id, username, display_name, role, active, created_at`,
        [username, passwordHash, displayName, role]
    );
    return result.rows[0];
}

export async function getUserByUsername(username) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT * FROM users WHERE username = $1 AND active = TRUE`,
        [username]
    );
    return result.rows[0] || null;
}

export async function getUserById(id) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT id, username, display_name, role, active, created_at FROM users WHERE id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

export async function getUserByGoogleId(googleId) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT * FROM users WHERE google_id = $1 AND active = TRUE`,
        [googleId]
    );
    return result.rows[0] || null;
}

export async function getUserByEmail(email) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT * FROM users WHERE email = $1 AND active = TRUE`,
        [email]
    );
    return result.rows[0] || null;
}

export async function createGoogleUser(googleId, email, displayName, role = 'viewer') {
    if (!pool) return null;
    const username = email.split('@')[0];
    const result = await pool.query(
        `INSERT INTO users (username, password_hash, display_name, role, google_id, email)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, display_name, role, active, created_at, email`,
        [username, 'google-sso-no-password', displayName, role, googleId, email]
    );
    return result.rows[0];
}

export async function getUsers() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT id, username, display_name, role, active, created_at, updated_at, email, google_id, last_login, digest_enabled FROM users ORDER BY created_at ASC`
    );
    return result.rows;
}

export async function updateUser(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
        if (['display_name', 'role', 'active', 'password_hash', 'google_id', 'email', 'last_login', 'digest_enabled'].includes(key)) {
            fields.push(`${key} = $${idx++}`);
            values.push(val);
        }
    }
    if (fields.length === 0) return null;
    fields.push(`updated_at = $${idx++}`);
    values.push(Date.now());
    values.push(id);
    const result = await pool.query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, username, display_name, role, active`,
        values
    );
    return result.rows[0] || null;
}

export async function deleteUser(id) {
    if (!pool) return;
    await pool.query(`UPDATE users SET active = FALSE, updated_at = $2 WHERE id = $1`, [id, Date.now()]);
}

// ============================================================
// Action Queue Acknowledgements
// ============================================================

export async function getAcknowledgedActions() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT a.action_key, a.acknowledged_at, a.notes, u.display_name AS acknowledged_by_name
         FROM action_queue_acks a LEFT JOIN users u ON a.acknowledged_by = u.id`
    );
    return result.rows;
}

export async function acknowledgeAction(actionKey, userId, notes) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO action_queue_acks (action_key, acknowledged_by, acknowledged_at, notes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (action_key) DO UPDATE SET acknowledged_by = $2, acknowledged_at = $3, notes = $4
         RETURNING *`,
        [actionKey, userId, Date.now(), notes || null]
    );
    return result.rows[0];
}

export async function unacknowledgeAction(actionKey) {
    if (!pool) return;
    await pool.query(`DELETE FROM action_queue_acks WHERE action_key = $1`, [actionKey]);
}

// ============================================================
// Checklist Templates
// ============================================================

export async function getChecklistTemplates() {
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM checklist_templates WHERE active = TRUE ORDER BY name`);
    return result.rows;
}

export async function insertChecklistTemplate(template) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO checklist_templates (name, visit_type, items)
         VALUES ($1, $2, $3) RETURNING *`,
        [template.name, template.visit_type, JSON.stringify(template.items)]
    );
    return result.rows[0];
}

export async function updateChecklistTemplate(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
        if (['name', 'visit_type', 'active'].includes(key)) {
            fields.push(`${key} = $${idx++}`);
            values.push(val);
        } else if (key === 'items') {
            fields.push(`items = $${idx++}`);
            values.push(JSON.stringify(val));
        }
    }
    if (fields.length === 0) return null;
    fields.push(`updated_at = $${idx++}`);
    values.push(Date.now());
    values.push(id);
    const result = await pool.query(
        `UPDATE checklist_templates SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

// ============================================================
// Completed Checklists
// ============================================================

export async function getCompletedChecklists(maintenanceLogId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT c.*, u.display_name AS completed_by_name
         FROM completed_checklists c LEFT JOIN users u ON c.completed_by = u.id
         WHERE c.maintenance_log_id = $1 ORDER BY c.completed_at DESC`,
        [maintenanceLogId]
    );
    return result.rows;
}

export async function insertCompletedChecklist(checklist) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO completed_checklists (maintenance_log_id, template_id, template_name, completed_by, items)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [checklist.maintenance_log_id, checklist.template_id, checklist.template_name,
        checklist.completed_by, JSON.stringify(checklist.items)]
    );
    return result.rows[0];
}

// ============================================================
// Issue Templates
// ============================================================

export async function getIssueTemplates() {
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM issue_templates WHERE active = TRUE ORDER BY name`);
    return result.rows;
}

export async function insertIssueTemplate(template) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO issue_templates (name, visit_type, title, description, expected_parts, estimated_hours)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [template.name, template.visit_type, template.title, template.description,
        JSON.stringify(template.expected_parts || []), template.estimated_hours || null]
    );
    return result.rows[0];
}

export async function updateIssueTemplate(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
        if (['name', 'visit_type', 'title', 'description', 'estimated_hours', 'active'].includes(key)) {
            fields.push(`${key} = $${idx++}`);
            values.push(val);
        } else if (key === 'expected_parts') {
            fields.push(`expected_parts = $${idx++}`);
            values.push(JSON.stringify(val));
        }
    }
    if (fields.length === 0) return null;
    fields.push(`updated_at = $${idx++}`);
    values.push(Date.now());
    values.push(id);
    const result = await pool.query(
        `UPDATE issue_templates SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

// ============================================================
// Maintenance Calendar
// ============================================================

export async function getMaintenanceCalendar(startMs, endMs, technicianId) {
    if (!pool) return [];
    let query = `
        SELECT m.*, j.name AS job_site_name, u.display_name AS assigned_technician_name
        FROM maintenance_logs m
        LEFT JOIN job_sites j ON m.job_site_id = j.id
        LEFT JOIN users u ON m.assigned_technician_id = u.id
        WHERE m.status != 'cancelled'
    `;
    const params = [];
    let idx = 1;
    if (startMs) {
        query += ` AND (m.scheduled_date >= $${idx} OR m.completed_date >= $${idx})`;
        params.push(startMs);
        idx++;
    }
    if (endMs) {
        query += ` AND (m.scheduled_date <= $${idx} OR m.completed_date <= $${idx})`;
        params.push(endMs);
        idx++;
    }
    if (technicianId) {
        query += ` AND m.assigned_technician_id = $${idx}`;
        params.push(technicianId);
        idx++;
    }
    query += ` ORDER BY COALESCE(m.scheduled_date, m.created_at) ASC`;
    const result = await pool.query(query, params);
    return result.rows;
}

// ============================================================
// Customer Site Access (portal)
// ============================================================

export async function getCustomerSiteAccess(userId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT csa.*, js.name as job_site_name, js.status, js.address
         FROM customer_site_access csa
         JOIN job_sites js ON csa.job_site_id = js.id
         WHERE csa.user_id = $1
         ORDER BY js.name`,
        [userId]
    );
    return result.rows;
}

export async function upsertCustomerSiteAccess(userId, jobSiteIds) {
    if (!pool) return;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM customer_site_access WHERE user_id = $1`, [userId]);
        for (const jsId of jobSiteIds) {
            await client.query(
                `INSERT INTO customer_site_access (user_id, job_site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [userId, jsId]
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ============================================================
// Notifications
// ============================================================
let notificationsTableReady = false;

async function ensureNotificationsTable() {
    if (notificationsTableReady || !pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL DEFAULT 'mention',
            title TEXT NOT NULL,
            body TEXT,
            link TEXT,
            read BOOLEAN NOT NULL DEFAULT FALSE,
            created_at BIGINT NOT NULL
        )
    `);
    notificationsTableReady = true;
}

export async function insertNotification(userId, type, title, body, link) {
    if (!pool) return null;
    await ensureNotificationsTable();
    const result = await pool.query(
        `INSERT INTO notifications (user_id, type, title, body, link, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [userId, type, title, body || null, link || null, Date.now()]
    );
    return result.rows[0];
}

export async function getUserNotifications(userId, { limit = 20, unreadOnly = false } = {}) {
    if (!pool) return [];
    await ensureNotificationsTable();
    const where = unreadOnly ? 'AND read = FALSE' : '';
    const result = await pool.query(
        `SELECT * FROM notifications WHERE user_id = $1 ${where} ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
    );
    return result.rows;
}

export async function getUnreadNotificationCount(userId) {
    if (!pool) return 0;
    await ensureNotificationsTable();
    const result = await pool.query(
        `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = FALSE`, [userId]
    );
    return parseInt(result.rows[0].count) || 0;
}

export async function markNotificationRead(notifId) {
    if (!pool) return;
    await pool.query(`UPDATE notifications SET read = TRUE WHERE id = $1`, [notifId]);
}

export async function markAllNotificationsRead(userId) {
    if (!pool) return;
    await pool.query(`UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE`, [userId]);
}

// ============================================================
// Trailers (rental fleet assets)
// ============================================================

const TRAILER_STATUSES = ['available', 'reserved', 'on_rent', 'in_transit', 'maintenance', 'retired'];
const OPEN_RENTAL_STATUSES = ['reserved', 'delivered', 'billing', 'called_off', 'awaiting_pickup'];

export async function getTrailers({ status } = {}) {
    if (!pool) return [];
    const params = [];
    let where = '';
    if (status) {
        params.push(status);
        where = `WHERE t.status = $1`;
    }
    const result = await pool.query(`
        SELECT t.*,
               ta.job_site_id AS current_job_site_id,
               js.name AS current_job_site_name,
               js.is_headquarters AS at_headquarters,
               r.id AS open_rental_id,
               r.status AS open_rental_status
        FROM trailers t
        LEFT JOIN trailer_assignments ta ON ta.site_id = t.vrm_site_id
        LEFT JOIN job_sites js ON js.id = ta.job_site_id
        LEFT JOIN rentals r ON r.trailer_id = t.id AND r.status NOT IN ('closed', 'cancelled')
        ${where}
        ORDER BY t.unit_number
    `, params);
    return result.rows;
}

export async function getTrailer(id) {
    if (!pool) return null;
    const result = await pool.query(`SELECT * FROM trailers WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function insertTrailer(t) {
    if (!pool) return null;
    const result = await pool.query(`
        INSERT INTO trailers (unit_number, vin, vrm_site_id, ic2_device_id, status, home_base_job_site_id, purchase_date, condition_notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
    `, [
        t.unit_number,
        t.vin || null,
        t.vrm_site_id || null,
        t.ic2_device_id || null,
        TRAILER_STATUSES.includes(t.status) ? t.status : 'available',
        t.home_base_job_site_id || null,
        t.purchase_date || null,
        t.condition_notes || null,
    ]);
    return result.rows[0];
}

export async function updateTrailer(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, value] of Object.entries(updates)) {
        if (['unit_number', 'vin', 'vrm_site_id', 'ic2_device_id', 'status', 'home_base_job_site_id', 'purchase_date', 'condition_notes'].includes(key)) {
            if (key === 'status' && !TRAILER_STATUSES.includes(value)) continue;
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
        `UPDATE trailers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

// ============================================================
// Rentals & billing lifecycle
// ============================================================

const RENTAL_JOIN = `
    SELECT r.*,
           t.unit_number, t.vrm_site_id, t.status AS trailer_status, t.product_code,
           js.name AS job_site_name,
           c.name AS company_name
    FROM rentals r
    JOIN trailers t ON t.id = r.trailer_id
    LEFT JOIN job_sites js ON js.id = r.job_site_id
    LEFT JOIN companies c ON c.id = r.company_id
`;

export async function getRentals({ status, trailerId, jobSiteId, companyId, open } = {}) {
    if (!pool) return [];
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`r.status = $${params.length}`); }
    if (trailerId) { params.push(trailerId); conditions.push(`r.trailer_id = $${params.length}`); }
    if (jobSiteId) { params.push(jobSiteId); conditions.push(`r.job_site_id = $${params.length}`); }
    if (companyId) { params.push(companyId); conditions.push(`r.company_id = $${params.length}`); }
    if (open) conditions.push(`r.status NOT IN ('closed', 'cancelled')`);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(`
        ${RENTAL_JOIN}
        ${where}
        ORDER BY
            CASE r.status
                WHEN 'billing' THEN 0 WHEN 'called_off' THEN 1 WHEN 'awaiting_pickup' THEN 2
                WHEN 'delivered' THEN 3 WHEN 'reserved' THEN 4 ELSE 5
            END,
            t.unit_number
    `, params);
    return result.rows;
}

export async function getRental(id) {
    if (!pool) return null;
    const result = await pool.query(`${RENTAL_JOIN} WHERE r.id = $1`, [id]);
    return result.rows[0] || null;
}

export async function insertRental(r) {
    if (!pool) return null;
    const result = await pool.query(`
        INSERT INTO rentals (trailer_id, job_site_id, company_id, po_number, reserved_at, rate_amount, rate_period, commitment_term, status, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
    `, [
        r.trailer_id,
        r.job_site_id || null,
        r.company_id || null,
        r.po_number || null,
        r.reserved_at || new Date().toISOString().slice(0, 10),
        r.rate_amount || null,
        ['day', 'week', 'month'].includes(r.rate_period) ? r.rate_period : 'month',
        ['monthly', '6_month', '1_year'].includes(r.commitment_term) ? r.commitment_term : 'monthly',
        'reserved',
        r.notes || null,
    ]);
    return result.rows[0];
}

export async function updateRental(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, value] of Object.entries(updates)) {
        if (['job_site_id', 'company_id', 'po_number', 'reserved_at', 'delivered_at', 'billing_start', 'calloff_at', 'billing_stop', 'picked_up_at', 'returned_at', 'rate_amount', 'rate_period', 'commitment_term', 'rollback_amount', 'status', 'notes'].includes(key)) {
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
        `UPDATE rentals SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

export async function insertRentalEvent(rentalId, eventType, eventDate, actor = 'system', notes = null) {
    if (!pool) return null;
    const result = await pool.query(`
        INSERT INTO rental_events (rental_id, event_type, event_date, actor, notes)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
    `, [rentalId, eventType, eventDate, actor, notes]);
    return result.rows[0];
}

export async function getRentalEvents(rentalId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM rental_events WHERE rental_id = $1 ORDER BY event_date, created_at`,
        [rentalId]
    );
    return result.rows;
}

// ============================================================
// Billing: revenue-leakage alert queries
// ============================================================

// Rentals still accruing past their calloff date (billing or called_off —
// both accrue until billing_stop is stamped)
export async function getBillingPastCalloff() {
    if (!pool) return [];
    const result = await pool.query(`
        ${RENTAL_JOIN}
        WHERE r.status IN ('billing', 'called_off')
          AND r.billing_stop IS NULL
          AND r.calloff_at IS NOT NULL
          AND r.calloff_at < CURRENT_DATE
        ORDER BY r.calloff_at
    `);
    return result.rows;
}

// Trailers physically at HQ (per GPS assignment) but with billing still running
export async function getBillingAtHeadquarters() {
    if (!pool) return [];
    const result = await pool.query(`
        SELECT r.*, t.unit_number, js.name AS hq_name
        FROM rentals r
        JOIN trailers t ON t.id = r.trailer_id
        JOIN trailer_assignments ta ON ta.site_id = t.vrm_site_id
        JOIN job_sites js ON js.id = ta.job_site_id
        WHERE js.is_headquarters = TRUE
          AND r.status IN ('billing', 'called_off')
          AND r.billing_stop IS NULL
        ORDER BY t.unit_number
    `);
    return result.rows;
}

// Trailers deployed on an active customer site with no open rental (unbilled units)
export async function getUnbilledDeployedTrailers() {
    if (!pool) return [];
    const result = await pool.query(`
        SELECT t.id AS trailer_id, t.unit_number, js.id AS job_site_id, js.name AS job_site_name
        FROM trailers t
        JOIN trailer_assignments ta ON ta.site_id = t.vrm_site_id
        JOIN job_sites js ON js.id = ta.job_site_id
        WHERE js.is_headquarters IS NOT TRUE
          AND js.status = 'active'
          AND t.status != 'retired'
          AND NOT EXISTS (
            SELECT 1 FROM rentals r
            WHERE r.trailer_id = t.id AND r.status NOT IN ('closed', 'cancelled')
          )
        ORDER BY t.unit_number
    `);
    return result.rows;
}

// ============================================================
// Pricing: rate cards, volume tiers, on-rent windows
// ============================================================

export async function getRateCards(productCode = null) {
    if (!pool) return [];
    const params = [];
    let where = 'WHERE active = TRUE';
    if (productCode) {
        params.push(productCode);
        where += ` AND product_code = $1`;
    }
    const result = await pool.query(`SELECT * FROM rate_cards ${where} ORDER BY product_code, base_rate DESC`, params);
    return result.rows;
}

export async function getVolumeTiers() {
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM volume_tiers ORDER BY min_units`);
    return result.rows;
}

// Billing windows for every rental that ever billed, grouped by company —
// used to resolve each customer's EA volume tier at any cycle-open date
export async function getCompanyRentalWindows() {
    if (!pool) return [];
    const result = await pool.query(`
        SELECT company_id, billing_start, billing_stop
        FROM rentals
        WHERE company_id IS NOT NULL
          AND billing_start IS NOT NULL
          AND status != 'cancelled'
    `);
    return result.rows;
}

export { OPEN_RENTAL_STATUSES };

export function getPool() {
    return pool;
}
