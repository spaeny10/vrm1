// ============================================================
// Demo database seeder. Builds a realistic business on top of the
// simulated fleet: customers, sites, trailers, rentals in every
// lifecycle state, maintenance, notes, persona logins, and two weeks
// of telemetry history so charts, analytics and alerts have data.
//
//   DATABASE_URL=postgresql://... node scripts/demo/seed.js
//
// DESTRUCTIVE: wipes the target database's app tables first. It
// refuses to run unless DEMO_SEED_CONFIRM=yes is set, and refuses
// any DATABASE_URL that isn't on localhost.
// ============================================================
import bcrypt from 'bcryptjs'
import { initDb, getPool, computeDailyMetrics } from '../../server/db.js'
import { COMPANIES, SITES, TRAILERS, telemetry, cellular, trailerPosition, siteByKey } from './fleet.js'

// Demo-only logins (local demo database). Each maps to a persona.
export const DEMO_USERS = [
    { username: 'admin', password: 'demo-admin', display: 'Shawn (Admin)', role: 'admin' },
    { username: 'fleet', password: 'demo-fleet', display: 'Jordan Fleet Manager', role: 'technician' },
    { username: 'billing', password: 'demo-billing', display: 'Casey Billing Manager', role: 'technician' },
    { username: 'tech', password: 'demo-tech', display: 'Riley Technical Manager', role: 'technician' },
    { username: 'acme', password: 'demo-customer', display: 'Dana Ruiz (Acme)', role: 'customer' },
]

const DAY = 86400000

function guard() {
    const url = process.env.DATABASE_URL || ''
    if (process.env.DEMO_SEED_CONFIRM !== 'yes') {
        console.error('Refusing to run: set DEMO_SEED_CONFIRM=yes (this wipes the database).')
        process.exit(1)
    }
    if (url && !/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
        console.error('Refusing to run: DATABASE_URL is not a localhost database.')
        process.exit(1)
    }
}

const dateStr = (ms) => new Date(ms).toISOString().slice(0, 10)

async function main() {
    guard()
    await initDb()
    const db = getPool()

    console.log('Wiping app tables...')
    await db.query(`
        TRUNCATE rental_events, rentals, trailers, gps_change_suggestions, note_reads, site_notes,
                 site_contacts, contacts, customer_site_access, completed_checklists, maintenance_logs,
                 trailer_components, trailer_assignments, job_sites, companies, site_snapshots,
                 pepwave_snapshots, daily_energy_summary, analytics_daily_metrics, alert_history,
                 action_queue_acks, audit_log
        RESTART IDENTITY CASCADE
    `)
    await db.query(`DELETE FROM users`)
    await db.query(`INSERT INTO settings (key, value) VALUES ('rentals_backfilled', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`)

    // ---------- Users ----------
    const userIds = {}
    for (const u of DEMO_USERS) {
        const hash = await bcrypt.hash(u.password, 10)
        const r = await db.query(
            `INSERT INTO users (username, password_hash, display_name, role, must_change_password) VALUES ($1,$2,$3,$4,false) RETURNING id`,
            [u.username, hash, u.display, u.role])
        userIds[u.username] = r.rows[0].id
    }

    // ---------- Companies + contacts ----------
    const companyIds = {}
    const contactIds = {}
    for (const c of COMPANIES) {
        const r = await db.query(`INSERT INTO companies (name, city, state) VALUES ($1,$2,$3) RETURNING id`, [c.name, c.city, c.state])
        companyIds[c.key] = r.rows[0].id
        const ct = await db.query(
            `INSERT INTO contacts (company_id, name, title, phone, email, is_primary) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
            [r.rows[0].id, c.contact.name, c.contact.title, c.contact.phone, c.contact.email])
        contactIds[c.key] = ct.rows[0].id
    }

    // ---------- Job sites ----------
    const siteIds = {}
    let uidN = 10400
    for (const s of SITES) {
        const r = await db.query(
            `INSERT INTO job_sites (name, latitude, longitude, address, status, uid, company_id, is_headquarters, geofence_radius_m)
             VALUES ($1,$2,$3,$4,'active',$5,$6,$7,300) RETURNING id`,
            [s.name, s.lat, s.lon, s.address, `SITE-${uidN++}`, s.company ? companyIds[s.company] : null, !!s.hq])
        siteIds[s.key] = r.rows[0].id
        if (s.company) {
            await db.query(`INSERT INTO site_contacts (job_site_id, contact_id, role) VALUES ($1,$2,'project-manager')`, [r.rows[0].id, contactIds[s.company]])
        }
    }
    // Customer portal: Acme's contact sees Acme's sites
    for (const s of SITES.filter(s => s.company === 'acme')) {
        await db.query(`INSERT INTO customer_site_access (user_id, job_site_id) VALUES ($1,$2)`, [userIds.acme, siteIds[s.key]])
    }

    // ---------- Trailers, assignments, rentals ----------
    const now = Date.now()
    for (const [i, t] of TRAILERS.entries()) {
        const pos = trailerPosition(t)
        const site = siteByKey(t.site)
        const trailerStatus = { billing: 'on_rent', called_off: 'on_rent', delivered: 'on_rent', reserved: 'reserved', none: 'available' }[t.rental]
        const tr = await db.query(
            `INSERT INTO trailers (unit_number, vin, vrm_site_id, ic2_device_id, status, product_code, purchase_date)
             VALUES ($1,$2,$3,$4,$5,'BV1305',$6) RETURNING id`,
            [t.unit, `1BV1305${String(t.vrmId).slice(-5)}`, t.vrmId, t.ic2Id, trailerStatus, dateStr(now - (400 + i * 9) * DAY)])
        const trailerId = tr.rows[0].id

        await db.query(
            `INSERT INTO trailer_assignments (site_id, site_name, job_site_id, latitude, longitude, ic2_device_id, last_gps_lat, last_gps_lon, last_gps_update, assigned_at)
             VALUES ($1,$2,$3,$4,$5,$6,$4,$5,$7,$8)`,
            [t.vrmId, t.unit, siteIds[t.site], pos.lat, pos.lon, t.ic2Id, now, now - 30 * DAY])

        if (t.rental === 'none') continue
        const companyId = site.company ? companyIds[site.company] : null
        const startDaysAgo = 25 + Math.round(t.seed * 110)
        const ev = []  // [type, daysAgo, extras]
        const r = {
            reserved_at: null, delivered_at: null, billing_start: null, calloff_at: null, status: t.rental,
        }
        if (t.rental === 'reserved') {
            // Reserved for a customer job, waiting at HQ for delivery
            r.reserved_at = dateStr(now - 1 * DAY)
            ev.push(['reserved', 1])
        } else if (t.rental === 'delivered') {
            r.reserved_at = dateStr(now - 12 * DAY)
            r.delivered_at = dateStr(now - 9 * DAY)
            ev.push(['reserved', 12], ['deliver', 9, { transport_company: 'Lone Star Hotshot', transport_cost: 640 }])
        } else {
            r.reserved_at = dateStr(now - (startDaysAgo + 3) * DAY)
            r.delivered_at = dateStr(now - (startDaysAgo + 1) * DAY)
            r.billing_start = dateStr(now - startDaysAgo * DAY)
            ev.push(['reserved', startDaysAgo + 3], ['deliver', startDaysAgo + 1, { transport_company: 'Rapid Hotshot LLC', transport_cost: 475 + Math.round(t.seed * 300) }], ['start_billing', startDaysAgo])
            if (t.rental === 'called_off') {
                r.calloff_at = dateStr(now - 3 * DAY)
                ev.push(['calloff', 3])
            }
        }
        const rental = await db.query(
            `INSERT INTO rentals (trailer_id, job_site_id, company_id, po_number, reserved_at, delivered_at, billing_start, calloff_at, commitment_term, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [trailerId, t.site === 'hq' ? siteIds.okc : siteIds[t.site], t.site === 'hq' ? companyIds.heartland : companyId,
             `PO-${7000 + i}`, r.reserved_at, r.delivered_at, r.billing_start, r.calloff_at, t.term, r.status])
        for (const [type, daysAgo, extras = {}] of ev) {
            await db.query(
                `INSERT INTO rental_events (rental_id, event_type, event_date, actor, transport_company, transport_cost)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [rental.rows[0].id, type, dateStr(now - daysAgo * DAY), type === 'start_billing' ? 'Casey Billing Manager' : 'Jordan Fleet Manager',
                 extras.transport_company || null, extras.transport_cost || null])
        }
    }

    // ---------- Telemetry history (7 days hourly snapshots) ----------
    console.log('Writing telemetry history...')
    for (const t of TRAILERS) {
        const rows = []
        for (let hAgo = 7 * 24; hAgo >= 1; hAgo--) {
            const when = new Date(now - hAgo * 3600000)
            const v = telemetry(t, when)
            if (t.scenario === 'offline' && hAgo < 48) continue  // router went dark two days ago
            rows.push([t.vrmId, t.unit, when.getTime(), v.soc, v.voltage, v.current, v.temp, v.battPower, v.solarW, v.yieldToday, v.yieldYesterday, String(v.mppt), v.consumedAh, v.load, String(v.mppt)])
        }
        for (let i = 0; i < rows.length; i += 200) {
            const chunk = rows.slice(i, i + 200)
            const vals = chunk.map((_, j) => `(${Array.from({ length: 15 }, (_, k) => `$${j * 15 + k + 1}`).join(',')})`).join(',')
            await db.query(
                `INSERT INTO site_snapshots (site_id, site_name, timestamp, battery_soc, battery_voltage, battery_current, battery_temp, battery_power, solar_watts, solar_yield_today, solar_yield_yesterday, charge_state, consumed_ah, dc_load_watts, mppt_state)
                 VALUES ${vals}`, chunk.flat())
        }

        // Cellular history every 2 hours
        const c = cellular(t)
        for (let hAgo = 7 * 24; hAgo >= 2; hAgo -= 2) {
            const online = !(t.scenario === 'offline' && hAgo < 48)
            await db.query(
                `INSERT INTO pepwave_snapshots (device_name, timestamp, online, signal_bar, rsrp, rsrq, rssi, sinr, carrier, technology, usage_mb, tx_mb, rx_mb, client_count, uptime)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'5G NSA',$10,$11,$12,$13,$14)`,
                [t.unit, now - hAgo * 3600000, online, online ? c.signal_bar : 0, online ? c.rsrp : null, online ? c.rsrq : null, online ? c.rssi : null, online ? c.sinr : null,
                 c.carrier, c.usageMbToday, c.usageMbToday * 0.7, c.usageMbToday * 0.3, online ? 4 : 0, online ? 86400 * 5 : 0])
        }
    }

    // ---------- Daily energy (14 days) ----------
    console.log('Writing daily energy history...')
    for (const t of TRAILERS) {
        for (let d = 14; d >= 1; d--) {
            const date = dateStr(now - d * DAY)
            const full = telemetry(t, new Date(now - d * DAY)).yieldYesterday * 1000
            const noise = 0.88 + ((t.seed * 13 + d * 7) % 10) / 40
            let yieldWh = Math.round(full * noise)
            let consumedWh = Math.round((58 + t.seed * 14) * 24 * (0.95 + (d % 3) * 0.03))
            let socEod = 72 + t.seed * 20
            let mpptEod = 3
            if (t.scenario === 'low_battery' && d <= 6) { yieldWh = 1050 + d * 20; consumedWh = 2300; socEod = 11 + d }
            if (t.scenario === 'dirty_panels' && d <= 3) { yieldWh = 1250; consumedWh = 1520; socEod = 38 }
            if (t.scenario === 'throttled') { yieldWh = 620; consumedWh = 1450; socEod = 100; mpptEod = 5 }
            if (t.scenario === 'offline' && d <= 2) continue
            const expected = Math.round(1305 * (5.6 + t.seed) * 0.70)
            await db.query(
                `INSERT INTO daily_energy_summary (site_id, date, site_name, yield_wh, consumed_wh, expected_yield_wh, consumption_source, soc_start_of_day, battery_soc_eod, mppt_state_eod, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,'CE diagnostic',$7,$8,$9,$10)`,
                [t.vrmId, date, t.unit, yieldWh, consumedWh, expected, socEod - 4, socEod, mpptEod, now - d * DAY])
        }
    }
    for (let d = 7; d >= 1; d--) {
        try { await computeDailyMetrics(dateStr(now - d * DAY)) } catch (e) { console.warn('  metrics', e.message) }
    }

    // ---------- Maintenance ----------
    const tId = (unit) => TRAILERS.find(t => t.unit === unit).vrmId
    const maint = [
        ['permian', 'BV-112', 'inspection', 'scheduled', 'Clean solar panels — output at 40% of expected', 'Dust buildup suspected; yield down 60% vs weather-adjusted expectation.', now - 2 * DAY, null, 1.5, 0, 0],
        ['dtc', 'BV-107', 'repair', 'scheduled', 'Battery service — SOC critical', 'Six-day energy deficit; battery at 11%. Check BMS and connections.', now + 1 * DAY, null, 3, 0, 0],
        ['okc', 'BV-115', 'repair', 'in_progress', 'Router offline — dispatch tech', 'No telemetry for 48h. Check power to router and SIM.', now - 1 * DAY, null, 2, 0, 0],
        ['phoenix', 'BV-118', 'inspection', 'scheduled', 'Battery temperature check', 'Battery temp above 45°C during afternoons; inspect ventilation.', now + 3 * DAY, null, 1, 0, 0],
        ['dallas', 'BV-102', 'repair', 'completed', 'Replaced cellular antenna', 'Signal restored to -86 dBm.', now - 9 * DAY, now - 8 * DAY, 1.5, 13500, 8900],
        ['aurora', 'BV-109', 'inspection', 'completed', 'Quarterly inspection', 'All systems nominal.', now - 20 * DAY, now - 20 * DAY, 1, 9000, 0],
    ]
    for (const [site, unit, type, status, title, desc, sched, done, hours, labor, parts] of maint) {
        await db.query(
            `INSERT INTO maintenance_logs (job_site_id, site_id, visit_type, status, title, description, technician, scheduled_date, completed_date, labor_hours, labor_cost_cents, parts_cost_cents)
             VALUES ($1,$2,$3,$4,$5,$6,'Field Service Team',$7,$8,$9,$10,$11)`,
            [siteIds[site], tId(unit), type, status, title, desc, sched, done, hours, labor, parts])
    }

    // ---------- Site notes ----------
    const notes = [
        ['dallas', 'Customer asked to keep BV-103 through end of Q1 — expect a renewal on PO-7002.', 'Casey Billing Manager'],
        ['dtc', 'Gate code changed to 4417. Updated for hotshot drivers.', 'Jordan Fleet Manager'],
        ['permian', 'Heavy dust storms this week — panel cleaning scheduled for BV-112.', 'Riley Technical Manager'],
        ['okc', 'BV-115 router dark since Tuesday; site super says power is on. Tech dispatched.', 'Riley Technical Manager'],
    ]
    for (const [site, text, author] of notes) {
        await db.query(`INSERT INTO site_notes (job_site_id, note, author, created_at) VALUES ($1,$2,$3,$4)`, [siteIds[site], text, author, now - Math.round(Math.random() * 4) * DAY - 3600000])
    }

    // ---------- A pending relocation for the Fleet Manager ----------
    await db.query(
        `INSERT INTO gps_change_suggestions (site_id, site_name, old_latitude, old_longitude, new_latitude, new_longitude, distance_km, current_job_site_id, current_job_site_name, suggested_job_site_id, suggested_job_site_name, suggestion_type, status)
         VALUES ($1,'BV-108',$2,$3,$4,$5,14.2,$6,'Denver Tech Center Tower',$7,'Aurora Logistics Park','reassign_existing','pending')`,
        [tId('BV-108'), siteByKey('dtc').lat, siteByKey('dtc').lon, siteByKey('aurora').lat, siteByKey('aurora').lon, siteIds.dtc, siteIds.aurora])

    console.log(`Seeded: ${COMPANIES.length} customers, ${SITES.length} sites, ${TRAILERS.length} trailers, ${DEMO_USERS.length} users.`)
    await db.end()
}

main().catch(err => { console.error(err); process.exit(1) })
