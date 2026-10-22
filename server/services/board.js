// ============================================================
// Fleet board: one complete row per trailer — health, diagnosis,
// telemetry, network, location, customer, rental — merged from the
// live caches and the database. The trailer list, site list and the
// workspace home pages all read from this so they never disagree.
// ============================================================
import { snapshotCache, pepwaveCache, dailyEnergy } from '../state.js';
import { getTrailers, getTrailerAssignments, getJobSites, getCompanies, getRentals } from '../db.js';
import { hasVrmData, todayStr } from '../lib/util.js';
import { computeAlerts } from './alerts.js';
import { computeTechStatus, computeHealthGrade } from './intelligence.js';

const SEVERITY = { offline: 0, attention: 1, watch: 2, good: 3, unknown: 4 };

function healthFor(siteId, alertsMap, snap, pw) {
    if (siteId == null) return { health: 'unknown', diagnosis: 'No telemetry linked' };
    const live = hasVrmData(snap);
    if (!live) {
        if (pw?.online) return { health: 'good', diagnosis: 'Network only — no battery telemetry' };
        return { health: 'offline', diagnosis: snap ? 'No data from trailer — router and Cerbo silent' : 'Never reported' };
    }
    const ts = computeTechStatus(siteId, alertsMap) || {};
    return { health: ts.status || 'good', diagnosis: ts.reason || null };
}

export async function buildTrailerBoard() {
    const [registry, assignments, jobSites, companies, openRentals] = await Promise.all([
        getTrailers(), getTrailerAssignments(), getJobSites(), getCompanies(), getRentals({ open: true }),
    ]);
    const siteById = new Map(jobSites.map(s => [s.id, s]));
    const companyById = new Map(companies.map(c => [c.id, c]));
    const assignmentBySite = new Map(assignments.map(a => [a.site_id, a]));
    const rentalByTrailer = new Map(openRentals.map(r => [r.trailer_id, r]));
    const today = todayStr();

    const alertsMap = {};
    for (const alert of computeAlerts()) alertsMap[alert.site_id] = alert.streak_days;

    // Union of identities: registry trailers, VRM installations, IC2-only devices
    const rows = new Map();
    const vrmByName = new Map([...snapshotCache.values()].map(s => [s.site_name, s.site_id]));

    for (const t of registry) {
        const key = t.vrm_site_id != null ? String(t.vrm_site_id) : `t${t.id}`;
        rows.set(key, { key, site_id: t.vrm_site_id, trailer: t, unit: t.unit_number });
    }
    for (const [siteId, snap] of snapshotCache) {
        if (!rows.has(String(siteId))) rows.set(String(siteId), { key: String(siteId), site_id: siteId, trailer: null, unit: snap.site_name });
    }
    for (const [name, dev] of pepwaveCache) {
        if (vrmByName.has(name)) continue;
        const already = [...rows.values()].some(r => r.unit === name);
        if (!already) rows.set(String(-dev.id), { key: String(-dev.id), site_id: -dev.id, trailer: null, unit: name });
    }

    const out = [];
    for (const r of rows.values()) {
        const snap = r.site_id != null ? snapshotCache.get(r.site_id) : null;
        const pw = pepwaveCache.get(r.unit) || null;
        const live = hasVrmData(snap);
        const { health, diagnosis } = healthFor(r.site_id, alertsMap, snap, pw);
        const assignment = r.site_id != null ? assignmentBySite.get(r.site_id) : null;
        const site = assignment?.job_site_id ? siteById.get(assignment.job_site_id) : null;
        const rental = r.trailer ? rentalByTrailer.get(r.trailer.id) : null;
        const customerId = rental?.company_id || site?.company_id || null;
        const customer = customerId ? companyById.get(customerId) : null;
        const energyToday = r.site_id != null ? (dailyEnergy.get(r.site_id) || {})[today] : null;
        const grade = live ? computeHealthGrade(r.site_id) : null;

        out.push({
            key: r.key,
            site_id: r.site_id,
            trailer_id: r.trailer?.id ?? null,
            unit: r.unit,
            product_code: r.trailer?.product_code || null,
            asset_status: r.trailer?.status || null,
            vin: r.trailer?.vin || null,
            health,
            diagnosis,
            grade: grade?.grade || null,
            deficit_streak: alertsMap[r.site_id] || 0,
            soc: live ? snap.battery_soc : null,
            battery_temp: live ? snap.battery_temp : null,
            solar_w: live ? snap.solar_watts : null,
            load_w: live ? snap.dc_load_watts : null,
            yield_today_kwh: live ? snap.solar_yield_today : null,
            expected_yield_kwh: energyToday?.expected_yield_wh != null ? energyToday.expected_yield_wh / 1000 : null,
            online: !!pw?.online,
            signal_bars: pw?.cellular?.signal_bar ?? null,
            rsrp: pw?.cellular?.signal?.rsrp ?? null,
            carrier: pw?.cellular?.carrier || null,
            last_seen: (snap?.vrm_timestamp || snap?.timestamp || null) ?? (pw?.timestamp || null),
            latitude: assignment?.latitude ?? null,
            longitude: assignment?.longitude ?? null,
            site: site ? { id: site.id, name: site.name, is_hq: !!site.is_headquarters } : null,
            customer: customer ? { id: customer.id, name: customer.name } : null,
            rental: rental ? {
                id: rental.id, status: rental.status, job_site_id: rental.job_site_id, job_site_name: rental.job_site_name,
                company_name: rental.company_name, po_number: rental.po_number, commitment_term: rental.commitment_term,
                reserved_at: rental.reserved_at, delivered_at: rental.delivered_at, billing_start: rental.billing_start,
                calloff_at: rental.calloff_at, picked_up_at: rental.picked_up_at,
            } : null,
        });
    }

    out.sort((a, b) => (SEVERITY[a.health] - SEVERITY[b.health]) || a.unit.localeCompare(b.unit, undefined, { numeric: true }));
    return out;
}

export function summarize(rows) {
    const s = { total: rows.length, offline: 0, attention: 0, watch: 0, good: 0, unknown: 0 };
    for (const r of rows) s[r.health] = (s[r.health] || 0) + 1;
    return s;
}

// Per-site rollup for the sites list
export async function buildSiteBoard() {
    const [rows, jobSites, companies, openRentals] = await Promise.all([
        buildTrailerBoard(), getJobSites(), getCompanies(), getRentals({ open: true }),
    ]);
    const companyById = new Map(companies.map(c => [c.id, c]));
    return jobSites.map(js => {
        const trailers = rows.filter(r => r.site?.id === js.id);
        const rentals = openRentals.filter(r => r.job_site_id === js.id);
        const s = summarize(trailers);
        return {
            id: js.id,
            uid: js.uid,
            name: js.name,
            address: js.address,
            latitude: js.latitude,
            longitude: js.longitude,
            is_hq: !!js.is_headquarters,
            customer: js.company_id && companyById.get(js.company_id) ? { id: js.company_id, name: companyById.get(js.company_id).name } : null,
            trailers: s.total,
            health: s,
            worst: s.offline ? 'offline' : s.attention ? 'attention' : s.watch ? 'watch' : s.total ? 'good' : 'empty',
            rentals_open: rentals.length,
            rentals_billing: rentals.filter(r => r.status === 'billing' || r.status === 'called_off').length,
        };
    }).sort((a, b) => (a.is_hq - b.is_hq) || a.name.localeCompare(b.name));
}
