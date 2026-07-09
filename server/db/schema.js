// All DDL/seed statements, verbatim from the original initDb body.
// ORDER IS LOAD-BEARING: FK dependencies and the rate_cards seed must
// run before the rentals backfill.
export async function applySchema(client) {
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
}
