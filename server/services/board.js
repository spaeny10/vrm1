// ============================================================
// Fleet board: one complete row per physical trailer — health,
// diagnosis, telemetry, network, location, customer, rental.
//
// Identity and "is it in service?" come from the roster; health is
// decided here and nowhere else. The trailer list, site list, home
// pages, map, morning digest and action queue all read these rows,
// so they can never disagree about the state of a trailer.
// ============================================================
import { dailyEnergy } from '../state.js';
import { getCompanies, getRentals } from '../db.js';
import { hasVrmData, todayStr, formatAge, parseDeviceTime } from '../lib/util.js';
import { computeAlerts } from './alerts.js';
import { computeTechStatus, computeHealthGrade, silentTelemetryStatus } from './intelligence.js';
import { refreshRoster, getRoster } from './roster.js';

// Sort order: things to act on first, the yard last
const SEVERITY = { offline: 0, attention: 1, watch: 2, unknown: 3, good: 4, inactive: 5 };

// When the trailer last sent anything. VRM time if there is a Cerbo (stale or
// not, so a silent Cerbo shows how long it has been silent); otherwise the
// router's last check-in. An offline router's poll time is not "last seen".
function lastSeenFor(snap, pw) {
    if (snap?.vrm_timestamp) return snap.vrm_timestamp;
    if (pw?.online) return pw.timestamp || null;
    return parseDeviceTime(pw?.last_online) ?? snap?.timestamp ?? null;
}

// A unit in the yard is never an outage. What matters there is whether it
// could ship today.
function yardState(u, live, lastSeen) {
    const status = u.trailer?.status;
    if (u.placement === 'shop') return { ready: false, note: 'Out of service' };
    if (status === 'maintenance') return { ready: false, note: 'In maintenance' };
    if (live) {
        // No energy-deficit judgement here: panels in the yard may be covered, indoors or on shore power
        const ts = computeTechStatus(u.site_id, {}) || {};
        return ts.status === 'attention' ? { ready: false, note: ts.reason } : { ready: true, note: 'Reporting normally' };
    }
    if (u.router?.online) {
        return u.snap ? { ready: false, note: 'Router online, Cerbo not reporting' } : { ready: true, note: 'Router online' };
    }
    if (!u.snap && !u.router) return { ready: false, note: 'No Cerbo or router linked' };
    return { ready: false, note: lastSeen ? `Powered down — last data ${formatAge(Date.now() - lastSeen)} ago` : 'Powered down' };
}

function assess(u, alertsMap, live, lastSeen, warming) {
    // Just restarted: a trailer with no data yet simply hasn't been polled
    if (warming && !live) return { health: 'unknown', diagnosis: 'Waiting for data after a restart', yard: u.in_service ? null : { ready: false, note: 'Waiting for data' } };
    if (!u.in_service) {
        const yard = yardState(u, live, lastSeen);
        return { health: 'inactive', diagnosis: yard.ready && yard.note === 'Reporting normally' ? 'Ready to deploy' : yard.note, yard };
    }
    if (!u.snap && !u.router) return { health: 'unknown', diagnosis: "No Cerbo or router linked — can't be monitored", yard: null };
    if (!live) {
        const s = silentTelemetryStatus(u.snap, u.router);
        return { health: s.status, diagnosis: s.reason, yard: null };
    }
    const ts = computeTechStatus(u.site_id, alertsMap) || {};
    return { health: ts.status || 'good', diagnosis: ts.reason || null, yard: null };
}

export async function buildTrailerBoard() {
    const [roster, companies] = await Promise.all([refreshRoster(), getCompanies()]);
    const companyById = new Map(companies.map(c => [c.id, c]));
    const today = todayStr();

    const alertsMap = {};
    for (const alert of computeAlerts()) alertsMap[alert.site_id] = alert.streak_days;

    const out = [];
    for (const u of roster.units) {
        if (u.hidden) continue;   // retired units aren't part of the fleet
        const { snap, router: pw, rental, site } = u;
        const live = hasVrmData(snap);
        const lastSeen = lastSeenFor(snap, pw);
        const { health, diagnosis, yard } = assess(u, alertsMap, live, lastSeen, roster.warming);
        const customerId = rental?.company_id || site?.company_id || null;
        const customer = customerId ? companyById.get(customerId) : null;
        const energyToday = u.site_id != null ? (dailyEnergy.get(u.site_id) || {})[today] : null;
        const grade = live ? computeHealthGrade(u.site_id) : null;

        out.push({
            key: u.key,
            site_id: u.site_id,
            // Every telemetry id this trailer has been known by, so old links still find it
            site_ids: u.site_ids,
            trailer_id: u.trailer?.id ?? null,
            unit: u.unit,
            product_code: u.trailer?.product_code || null,
            asset_status: u.trailer?.status || null,
            vin: u.trailer?.vin || null,
            health,
            diagnosis,
            in_service: u.in_service,
            not_deployed: !u.in_service,
            placement: u.placement,
            yard,
            grade: grade?.grade || null,
            deficit_streak: u.in_service ? (alertsMap[u.site_id] || 0) : 0,
            soc: live ? snap.battery_soc : null,
            battery_temp: live ? snap.battery_temp : null,
            solar_w: live ? snap.solar_watts : null,
            load_w: live ? snap.dc_load_watts : null,
            yield_today_kwh: live ? snap.solar_yield_today : null,
            expected_yield_kwh: energyToday?.expected_yield_wh != null ? energyToday.expected_yield_wh / 1000 : null,
            has_cerbo: !!snap,
            has_router: !!pw,
            router_name: pw?.name || null,
            online: !!pw?.online,
            signal_bars: pw?.cellular?.signal_bar ?? null,
            rsrp: pw?.cellular?.signal?.rsrp ?? null,
            carrier: pw?.cellular?.carrier || null,
            last_seen: lastSeen,
            latitude: u.latitude,
            longitude: u.longitude,
            site: site ? { id: site.id, name: site.name, is_hq: !!site.is_headquarters, source: u.site_source } : null,
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

// total = trailers in service; the yard is counted separately.
export function summarize(rows) {
    const s = { total: 0, offline: 0, attention: 0, watch: 0, good: 0, unknown: 0, inactive: 0, yard_ready: 0, yard_not_ready: 0 };
    for (const r of rows) {
        s[r.health] = (s[r.health] || 0) + 1;
        if (r.health !== 'inactive') s.total++;
        else if (r.yard?.ready) s.yard_ready++;
        else s.yard_not_ready++;
    }
    return s;
}

// Per-site rollup for the sites list
export async function buildSiteBoard(rows) {
    const trailerRows = rows || await buildTrailerBoard();
    const roster = getRoster();
    const [companies, openRentals] = await Promise.all([getCompanies(), getRentals({ open: true })]);
    const companyById = new Map(companies.map(c => [c.id, c]));
    return (roster.jobSites || []).map(js => {
        const trailers = trailerRows.filter(r => r.site?.id === js.id);
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
            trailers: trailers.length,
            health: s,
            worst: s.offline ? 'offline' : s.attention ? 'attention' : s.watch ? 'watch' : s.unknown ? 'unknown' : s.total ? 'good' : s.inactive ? 'inactive' : 'empty',
            rentals_open: rentals.length,
            rentals_billing: rentals.filter(r => r.status === 'billing' || r.status === 'called_off').length,
        };
    }).sort((a, b) => (a.is_hq - b.is_hq) || a.name.localeCompare(b.name));
}
