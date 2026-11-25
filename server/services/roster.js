// ============================================================
// Fleet roster: the single answer to "which physical trailers do we
// have, and is each one in service?"
//
// A trailer shows up in three places that are filled in by hand and
// drift apart: the registry (trailers table), Victron VRM (the Cerbo)
// and InControl (the router). resolveFleet() joins them into one unit
// per physical trailer and records every place it had to guess, so the
// board, alerts, digest and action queue all read the same fleet.
//
// resolveFleet() is pure. refreshRoster() feeds it from the database
// and the live caches and keeps a per-telemetry-id lookup for the
// modules that only know a VRM site id (alerts, action queue).
// ============================================================
import { normalizeUnitName, parseDeviceTime } from '../lib/util.js';
import { getTrailers, getTrailerAssignments, getJobSites, getRentals, getRentalCountsByTrailer } from '../db.js';
import { snapshotCache, pepwaveCache, vrmPollCount, lastIc2Poll } from '../state.js';
import { IC2_CLIENT_ID, IC2_CLIENT_SECRET } from '../config.js';

// Two same-named devices that have both reported this recently are two
// trailers that happen to share a name, not an old device and its replacement
const BOTH_LIVE_MS = 6 * 60 * 60 * 1000;

// Until each poller has finished once after a restart, the caches are partial
// and say nothing reliable about which trailers have telemetry
export function telemetryReady() {
    return vrmPollCount > 0 && (!(IC2_CLIENT_ID && IC2_CLIENT_SECRET) || lastIc2Poll > 0);
}

// Units whose name says they are out of service ("Trailer 560-BAD",
// "Trailer 528 - RMA", "Spare", "tester", "R&D").
const SHOP_NAME = /(?:^|[\s-])(?:BAD|RMA|SPARE)(?:$|[\s-])|\btester\b|\bR&D\b/i;

export const isShopName = (name) => SHOP_NAME.test(name || '');

const ts = (v) => parseDeviceTime(v) || 0;

// A registry row nobody has touched: created by the telemetry backfill,
// never given a VIN, purchase date or notes, never rented.
const isAutoCreated = (t, rentalCounts) =>
    !t.vin && !t.purchase_date && !t.condition_notes && t.status === 'available' && !(rentalCounts.get(t.id) > 0);

/**
 * @param {object} input
 * @param {Array}  input.registry     trailers rows
 * @param {Array}  input.snapshots    latest VRM snapshot per installation
 * @param {Array}  input.routers      latest InControl record per device
 * @param {Array}  input.assignments  trailer_assignments rows
 * @param {Array}  input.rentals      open rentals
 * @param {Array}  input.jobSites     job_sites rows
 * @param {Map}    [input.rentalCounts]  trailer id -> rentals ever (decides which duplicates are safe to remove)
 * @returns {{ units: Array, issues: Array, repairs: Array }}
 */
export function resolveFleet({ registry = [], snapshots = [], routers = [], assignments = [], rentals = [], jobSites = [], rentalCounts = new Map(), now = Date.now() }) {
    const issues = [];
    const repairs = [];
    const norm = normalizeUnitName;

    const sameNameLive = [];   // live installations that share a name with another live one

    // ---- 1. VRM installations: one primary per name ----
    // A replaced Cerbo leaves its old installation in VRM, silent forever,
    // under the same name. The one that reported most recently is the trailer.
    const snapById = new Map(snapshots.map(s => [s.site_id, s]));
    const vrmPrimary = new Map();       // installation id -> primary installation id
    const vrmByName = new Map();        // normalized name -> primary snapshot
    const vrmExtras = new Map();        // primary id -> [superseded snapshots]
    const byName = new Map();
    for (const s of snapshots) {
        const n = norm(s.site_name) || `#${s.site_id}`;
        if (!byName.has(n)) byName.set(n, []);
        byName.get(n).push(s);
    }
    for (const [n, group] of byName) {
        group.sort((a, b) => (ts(b.vrm_timestamp) - ts(a.vrm_timestamp)) || (b.site_id - a.site_id));
        const [primary, ...rest] = group;
        // Others that are also reporting are separate trailers sharing a name: never hide a live trailer
        const alsoLive = rest.filter(x => ts(x.vrm_timestamp) && now - ts(x.vrm_timestamp) < BOTH_LIVE_MS);
        const extras = rest.filter(x => !alsoLive.includes(x));
        vrmByName.set(n, primary);
        vrmPrimary.set(primary.site_id, primary.site_id);
        vrmExtras.set(primary.site_id, extras);
        for (const x of alsoLive) {
            vrmPrimary.set(x.site_id, x.site_id);
            vrmExtras.set(x.site_id, []);
            sameNameLive.push(x);
            issues.push({
                type: 'same_name', unit: x.site_name, site_id: x.site_id,
                detail: `Two VRM installations that are both reporting are named "${x.site_name}" (${primary.site_id} and ${x.site_id}). They are shown as two trailers.`,
                fix: 'Rename one of them in VRM so each trailer has its own name.',
            });
        }
        for (const x of extras) {
            vrmPrimary.set(x.site_id, primary.site_id);
            issues.push({
                type: 'duplicate_vrm', unit: primary.site_name, site_id: primary.site_id,
                detail: `VRM has ${group.length} installations named "${primary.site_name}". Using the one that reported most recently and ignoring installation ${x.site_id}.`,
                fix: 'In VRM, archive or rename the old installation.',
            });
        }
    }

    const sameNameRouters = [];   // online routers that share a name with another online one

    // ---- 2. Routers: one primary per name ----
    const routerById = new Map(routers.map(r => [r.id, r]));
    const routerPrimary = new Map();
    const routerByName = new Map();
    const rByName = new Map();
    for (const r of routers) {
        const n = norm(r.name) || `#${r.id}`;
        if (!rByName.has(n)) rByName.set(n, []);
        rByName.get(n).push(r);
    }
    for (const [n, group] of rByName) {
        group.sort((a, b) => (Number(!!b.online) - Number(!!a.online)) || (ts(b.last_online) - ts(a.last_online)) || (b.id - a.id));
        const [primary, ...rest] = group;
        const alsoOnline = rest.filter(x => x.online);
        const extras = rest.filter(x => !x.online);
        routerByName.set(n, primary);
        routerPrimary.set(primary.id, primary.id);
        for (const x of alsoOnline) { routerPrimary.set(x.id, x.id); sameNameRouters.push(x); }
        for (const x of extras) {
            routerPrimary.set(x.id, primary.id);
            issues.push({
                type: 'duplicate_router', unit: primary.name, site_id: -primary.id,
                detail: `InControl has ${group.length} routers named "${primary.name}". Using the one that is online or was seen most recently.`,
                fix: 'In InControl, remove or rename the old router.',
            });
        }
    }
    const primaryRouter = (id) => routerById.get(routerPrimary.get(id));

    // Explicit Cerbo-to-router links live on the assignment row
    const assignmentById = new Map(assignments.map(a => [a.site_id, a]));
    const linkedRouterFor = (vrmId) => {
        const devId = assignmentById.get(vrmId)?.ic2_device_id;
        return devId != null && routerById.has(devId) ? primaryRouter(devId) : null;
    };

    // ---- 3. Registry rows -> telemetry ----
    const sorted = [...new Map(registry.map(t => [t.id, t])).values()].sort((a, b) => a.id - b.id);
    const resolved = new Map();          // trailer id -> { v, r, how }
    const vrmOwner = new Map();          // primary VRM id -> normalized name of the row that claimed it by id

    // Pass A: rows whose stored VRM id is a real installation
    for (const t of sorted) {
        if (t.vrm_site_id > 0 && snapById.has(t.vrm_site_id)) {
            const v = snapById.get(vrmPrimary.get(t.vrm_site_id));
            resolved.set(t.id, { v, how: v.site_id === t.vrm_site_id ? 'id' : 'superseded' });
            if (!vrmOwner.has(v.site_id)) vrmOwner.set(v.site_id, norm(t.unit_number));
            if (norm(v.site_name) !== norm(t.unit_number)) {
                issues.push({
                    type: 'link_mismatch', unit: t.unit_number, trailer_id: t.id, site_id: v.site_id,
                    detail: `"${t.unit_number}" is linked to the VRM installation named "${v.site_name}".`,
                    fix: 'Check that the link is right, then rename one of them so they match.',
                });
            }
        }
    }
    // Pass B: everything else finds its installation by name
    for (const t of sorted) {
        if (resolved.has(t.id)) continue;
        const n = norm(t.unit_number);
        const v = n ? vrmByName.get(n) : null;
        // Don't take an installation that another, differently named trailer is linked to
        const free = v && (!vrmOwner.has(v.site_id) || vrmOwner.get(v.site_id) === n);
        resolved.set(t.id, { v: free ? v : null, how: free ? 'name' : 'none' });
    }
    // Routers for registry rows
    for (const t of sorted) {
        const res = resolved.get(t.id);
        let r = null;
        if (t.ic2_device_id != null && routerById.has(t.ic2_device_id)) r = primaryRouter(t.ic2_device_id);
        else if (t.vrm_site_id < 0 && routerById.has(-t.vrm_site_id)) r = primaryRouter(-t.vrm_site_id);
        else if (res.v && linkedRouterFor(res.v.site_id)) r = linkedRouterFor(res.v.site_id);
        else r = routerByName.get(norm(t.unit_number)) || (res.v ? routerByName.get(norm(res.v.site_name)) : null) || null;
        res.r = r;
    }

    // ---- 4. Group registry rows into physical units ----
    const groups = new Map();            // group key -> { trailers, v, r }
    const groupKey = (t) => {
        const { v, r } = resolved.get(t.id);
        if (v) return `v${v.site_id}`;
        if (r) return `r${r.id}`;
        return `n${norm(t.unit_number) || `t${t.id}`}`;
    };
    for (const t of sorted) {
        const key = groupKey(t);
        if (!groups.has(key)) groups.set(key, { trailers: [], v: resolved.get(t.id).v, r: null });
        const g = groups.get(key);
        g.trailers.push(t);
        g.r = g.r || resolved.get(t.id).r;
    }
    // A router-only registry row whose router already belongs to a unit with a Cerbo is the same trailer
    const routerUnit = new Map();
    for (const [key, g] of groups) if (g.v && g.r) routerUnit.set(g.r.id, key);
    for (const [key, g] of [...groups]) {
        if (g.v || !g.r || !routerUnit.has(g.r.id)) continue;
        groups.get(routerUnit.get(g.r.id)).trailers.push(...g.trailers);
        groups.delete(key);
    }

    // ---- 5 & 6. Telemetry nobody registered ----
    const usedRouters = new Set([...groups.values()].filter(g => g.r).map(g => g.r.id));
    for (const v of [...vrmByName.values(), ...sameNameLive]) {
        if (groups.has(`v${v.site_id}`)) continue;
        const linked = linkedRouterFor(v.site_id);
        // Same-named live routers pair up with same-named live Cerbos, one each
        const n = norm(v.site_name);
        const named = [routerByName.get(n), ...sameNameRouters.filter(x => norm(x.name) === n)].find(x => x && !usedRouters.has(x.id));
        const r = (linked && !usedRouters.has(linked.id) ? linked : null) || (named && !usedRouters.has(named.id) ? named : null);
        if (r) usedRouters.add(r.id);
        groups.set(`v${v.site_id}`, { trailers: [], v, r });
    }
    for (const r of [...routerByName.values(), ...sameNameRouters]) {
        if (usedRouters.has(r.id)) continue;
        usedRouters.add(r.id);
        groups.set(`r${r.id}`, { trailers: [], v: null, r });
    }

    // ---- Build units ----
    const siteById = new Map(jobSites.map(s => [s.id, s]));
    const rentalByTrailer = new Map();
    for (const r of rentals) if (!rentalByTrailer.has(r.trailer_id)) rentalByTrailer.set(r.trailer_id, r);
    const hasHq = jobSites.some(s => s.is_headquarters);

    const units = [];
    for (const g of groups.values()) {
        const { v, r } = g;
        // Primary registry row: the one carrying the rental, then the correctly linked one, then the oldest
        const rank = (t) => (rentalByTrailer.has(t.id) ? 0 : 4) + (v && t.vrm_site_id === v.site_id ? 0 : 2) + (isAutoCreated(t, rentalCounts) ? 1 : 0);
        const trailers = [...g.trailers].sort((a, b) => (rank(a) - rank(b)) || (a.id - b.id));
        const [trailer = null, ...duplicates] = trailers;
        const unit = (trailer?.unit_number || v?.site_name || r?.name || '').trim();
        const siteId = v ? v.site_id : r ? -r.id : null;

        for (const d of duplicates) {
            if (isAutoCreated(d, rentalCounts)) {
                repairs.push({ type: 'remove_duplicate', trailer_id: d.id, unit: d.unit_number, keep: trailer.id });
            } else {
                issues.push({
                    type: 'duplicate_registry', unit, trailer_id: d.id, site_id: siteId,
                    detail: `The registry has "${trailer.unit_number}" and "${d.unit_number}" for the same trailer.`,
                    fix: `Move anything you need from "${d.unit_number}" to "${trailer.unit_number}", then delete it.`,
                });
            }
        }
        // The registry points somewhere that isn't this trailer's live installation
        if (trailer && v && trailer.vrm_site_id !== v.site_id) {
            repairs.push({ type: 'relink', trailer_id: trailer.id, unit, from: trailer.vrm_site_id ?? null, to: v.site_id, router_id: r?.id ?? null });
        }

        // Every telemetry id this trailer has ever been known by
        const siteIds = [];
        const add = (id) => { if (id != null && !siteIds.includes(id)) siteIds.push(id); };
        add(siteId);
        if (r) add(-r.id);
        for (const t of trailers) add(t.vrm_site_id);
        if (v) for (const x of vrmExtras.get(v.site_id) || []) add(x.site_id);

        // Job site: wherever an assignment for any of those ids says, else where the rental says
        const withSite = siteIds.map(id => assignmentById.get(id)).find(a => a?.job_site_id);
        const withGps = siteIds.map(id => assignmentById.get(id)).find(a => a?.latitude != null && a?.longitude != null);
        const rental = trailers.map(t => rentalByTrailer.get(t.id)).find(Boolean) || null;
        let site = withSite ? siteById.get(withSite.job_site_id) || null : null;
        let siteSource = site ? 'gps' : null;
        if (!site && rental?.job_site_id && siteById.has(rental.job_site_id)) { site = siteById.get(rental.job_site_id); siteSource = 'rental'; }

        // In service = earning or out with a customer. Everything else is the yard.
        const retired = trailer?.status === 'retired';
        const shop = isShopName(unit) || isShopName(v?.site_name) || isShopName(r?.name);
        let inService, placement;
        if (rental) { inService = true; placement = 'on_rent'; }
        else if (retired) { inService = false; placement = 'retired'; }
        else if (shop) { inService = false; placement = 'shop'; }
        else if (site && !site.is_headquarters) { inService = true; placement = 'customer_site'; }
        else { inService = false; placement = site ? 'yard' : 'unplaced'; }

        // Assignment rows left behind on ids this trailer no longer reports under
        // (its router's id from before the Cerbo existed, a replaced Cerbo)
        if (siteId != null) {
            for (const id of siteIds) {
                const a = id === siteId ? null : assignmentById.get(id);
                if (a && (a.job_site_id != null || id < 0)) repairs.push({ type: 'merge_assignment', unit, from: id, to: siteId, router_id: r?.id ?? null });
            }
        }
        // Telemetry nobody has registered yet becomes a registry row
        if (!trailer && siteId != null && unit) {
            repairs.push({ type: 'register', unit, site_id: siteId, router_id: r?.id ?? null, status: shop ? 'maintenance' : 'available' });
        }

        if (inService && !v && !r) {
            issues.push({
                type: 'no_telemetry', unit, trailer_id: trailer?.id ?? null, site_id: null,
                detail: `"${unit}" is ${rental ? 'on rent' : 'at a customer site'} but has no Cerbo or router linked, so it can't be monitored.`,
                fix: 'On the Trailers page, open it and choose its Telemetry, or rename it to match its Cerbo and router.',
            });
        }
        // No rental and no site: we assume the yard, and say so, because a trailer
        // that is really out with a customer would otherwise go unwatched
        if (placement === 'unplaced' && (v || r)) {
            issues.push({
                type: 'unplaced', unit, trailer_id: trailer?.id ?? null, site_id: siteId, minor: true,
                detail: `"${unit}" has no job site and no rental, so it is treated as being in the yard.`,
                fix: 'If it is out with a customer, assign it to that site or create its rental.',
            });
        }
        if (shop && !retired && trailer && trailer.status !== 'maintenance' && !rental) {
            issues.push({
                type: 'shop_by_name', unit, trailer_id: trailer.id, site_id: siteId, minor: true,
                detail: `"${unit}" is treated as out of service because of its name, but its status is "${trailer.status}".`,
                fix: 'Set its status to Maintenance or Retired so this no longer depends on the name.',
            });
        }

        units.push({
            key: siteId != null ? String(siteId) : `t${trailer.id}`,
            unit, site_id: siteId, site_ids: siteIds,
            trailer, duplicates, snap: v || null, router: r || null,
            assignment: withSite || null,
            latitude: withGps?.latitude ?? null, longitude: withGps?.longitude ?? null,
            site, site_source: siteSource, rental,
            in_service: inService, placement,
            hidden: retired && !rental,
        });
    }

    if (!hasHq && jobSites.length > 0) {
        issues.push({
            type: 'no_hq', unit: null, minor: true,
            detail: 'No job site is marked as headquarters, so trailers in your yard can look like they are out with a customer.',
            fix: 'Open your yard on the Sites page, choose Edit site, and tick Headquarters.',
        });
    }

    return { units, issues, repairs };
}

// ------------------------------------------------------------
// Live roster: resolveFleet() fed from the database and the caches
// ------------------------------------------------------------
export async function refreshRoster() {
    const [registry, assignments, jobSites, rentals, rentalCounts] = await Promise.all([
        getTrailers(), getTrailerAssignments(), getJobSites(), getRentals({ open: true }), getRentalCountsByTrailer(),
    ]);
    const result = resolveFleet({
        registry, assignments, jobSites, rentals, rentalCounts,
        snapshots: [...snapshotCache.values()], routers: [...pepwaveCache.values()],
    });
    // While the caches are still filling, missing telemetry means nothing yet
    const warming = !telemetryReady();
    return setRoster({ ...result, issues: warming ? [] : result.issues, repairs: warming ? [] : result.repairs, jobSites, warming });
}

// ------------------------------------------------------------
// Cached roster for modules that only know a telemetry site id
// ------------------------------------------------------------
let current = { units: [], issues: [], repairs: [], bySiteId: new Map(), byRouterId: new Map(), builtAt: 0, warming: true };

export function setRoster(result) {
    const bySiteId = new Map();
    for (const u of result.units) {
        for (const id of u.site_ids) {
            // An id can only be "the" trailer if it is the unit's live telemetry id
            const entry = { unit: u.unit, key: u.key, in_service: u.in_service, hidden: u.hidden, primary: id === u.site_id };
            if (!bySiteId.has(id) || entry.primary) bySiteId.set(id, entry);
        }
    }
    const byRouterId = new Map();
    for (const u of result.units) {
        if (u.router) byRouterId.set(u.router.id, { unit: u.unit, key: u.key, site_id: u.site_id, in_service: u.in_service, hidden: u.hidden });
    }
    current = { ...result, bySiteId, byRouterId, builtAt: Date.now() };
    return current;
}

export const getRoster = () => current;

// Should this telemetry id raise alerts? Unknown ids fail open: a trailer we
// can't place is alerted on rather than silently dropped.
export function isMonitored(siteId) {
    const e = current.bySiteId.get(siteId);
    return e ? (e.in_service && !e.hidden && e.primary) : true;
}

// Is this telemetry id the live identity of a trailer (not a superseded
// duplicate or a retired unit)? Used to keep ghosts out of fleet tables.
export function isCurrentIdentity(siteId) {
    const e = current.bySiteId.get(siteId);
    return e ? (e.primary && !e.hidden) : true;
}

export function rosterEntry(siteId) {
    return current.bySiteId.get(siteId) || null;
}

// The trailer a router belongs to (null for a router the roster superseded)
export function rosterEntryForRouter(routerId) {
    return current.byRouterId.get(routerId) || null;
}
