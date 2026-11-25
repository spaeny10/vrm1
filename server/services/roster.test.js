// Run: npm test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module('../db.js', {
    namedExports: {
        getTrailers: async () => [], getTrailerAssignments: async () => [], getJobSites: async () => [],
        getRentals: async () => [], getRentalCountsByTrailer: async () => new Map(),
    },
});
const { resolveFleet, setRoster, isMonitored, isCurrentIdentity } = await import('./roster.js');

const DAY = 86400000;
const now = Date.now();
const snap = (id, name, ageMs = 60000) => ({ site_id: id, site_name: name, vrm_timestamp: now - ageMs, battery_soc: 80, battery_voltage: 26 });
const router = (id, name, online = true, extra = {}) => ({ id, name, online, timestamp: now, ...extra });
const trailer = (id, unit, vrm = null, extra = {}) => ({ id, unit_number: unit, vrm_site_id: vrm, ic2_device_id: null, status: 'available', vin: null, purchase_date: null, condition_notes: null, ...extra });
const SITES = [
    { id: 1, name: 'Big View HQ', is_headquarters: true },
    { id: 7, name: 'Austin, Texas #2', is_headquarters: false },
];
const unitNamed = (res, name) => res.units.filter(u => u.unit === name);
const repairsOf = (res, type) => res.repairs.filter(r => r.type === type);
const issuesOf = (res, type) => res.issues.filter(i => i.type === type);

test('a trailer linked by id with a router of the same name is one unit', () => {
    const res = resolveFleet({
        registry: [trailer(1, 'Trailer 572', 810619, { status: 'on_rent' })],
        snapshots: [snap(810619, 'Trailer 572')], routers: [router(96, 'Trailer 572')],
        assignments: [{ site_id: 810619, job_site_id: 7, latitude: 30.2, longitude: -97.7 }], jobSites: SITES,
    });
    assert.equal(res.units.length, 1);
    const u = res.units[0];
    assert.equal(u.site_id, 810619);
    assert.equal(u.router.id, 96);
    assert.equal(u.site.name, 'Austin, Texas #2');
    assert.equal(u.in_service, true);
    assert.equal(res.repairs.length, 0);
    assert.equal(res.issues.length, 0);
});

test('registered from its router first: joins its Cerbo, keeps its job site, and is repaired', () => {
    const res = resolveFleet({
        registry: [trailer(179, 'Trailer 619', -156)],
        snapshots: [snap(1004498, 'Trailer 619', 23 * DAY)], routers: [router(156, 'Trailer 619')],
        assignments: [{ site_id: -156, job_site_id: 7, latitude: 30.2, longitude: -97.7 }, { site_id: 1004498, job_site_id: null }],
        jobSites: SITES,
    });
    assert.equal(res.units.length, 1);
    const u = res.units[0];
    assert.equal(u.site_id, 1004498);
    assert.equal(u.trailer.id, 179);
    assert.equal(u.site.name, 'Austin, Texas #2');
    assert.equal(u.latitude, 30.2);
    assert.deepEqual(repairsOf(res, 'relink')[0], { type: 'relink', trailer_id: 179, unit: 'Trailer 619', from: -156, to: 1004498, router_id: 156 });
    assert.equal(repairsOf(res, 'merge_assignment')[0].from, -156);
});

test('sloppy naming between systems still joins: case, spaces, missing "Trailer"', () => {
    const res = resolveFleet({
        registry: [trailer(1, '574', null)],
        snapshots: [snap(798561, 'Trailer 574')], routers: [router(89, 'trailer 574 ')],
    });
    assert.equal(res.units.length, 1);
    assert.equal(res.units[0].site_id, 798561);
    assert.equal(res.units[0].router.id, 89);
    assert.equal(res.units[0].unit, '574');
});

test('a replaced Cerbo: two installations with one name are one trailer, the live one', () => {
    const res = resolveFleet({
        registry: [trailer(36, 'BV-215', 300140, { status: 'on_rent' })],   // registry still points at the old one
        snapshots: [snap(300140, 'BV-215', 90 * DAY), snap(300139, 'BV-215')],
        routers: [router(9139, 'BV-215')],
        assignments: [{ site_id: 300140, job_site_id: 7 }, { site_id: 300139, job_site_id: null }],
        rentals: [{ id: 5, trailer_id: 36, job_site_id: 7 }], jobSites: SITES,
    });
    assert.equal(res.units.length, 1);
    const u = res.units[0];
    assert.equal(u.site_id, 300139);
    assert.ok(u.site_ids.includes(300140));
    assert.equal(u.site.id, 7);
    assert.equal(issuesOf(res, 'duplicate_vrm').length, 1);
    assert.equal(repairsOf(res, 'relink')[0].to, 300139);
    assert.equal(repairsOf(res, 'merge_assignment')[0].from, 300140);
    // The dead installation must not raise alerts or appear as a second trailer
    setRoster(res);
    assert.equal(isMonitored(300139), true);
    assert.equal(isMonitored(300140), false);
    assert.equal(isCurrentIdentity(300140), false);
    assert.equal(isMonitored(424242), true, 'unknown ids fail open');
});

test('two Cerbos that are both reporting under one name are two trailers, never merged', () => {
    const res = resolveFleet({
        registry: [trailer(1, 'Spare', 801)],
        snapshots: [snap(801, 'Spare'), snap(802, 'Spare', 10 * 60000)],
        routers: [router(81, 'Spare'), router(82, 'Spare')],
    });
    assert.equal(res.units.length, 2);
    assert.deepEqual(res.units.map(u => u.site_id).sort(), [801, 802]);
    assert.equal(issuesOf(res, 'same_name').length, 1);
    assert.equal(issuesOf(res, 'duplicate_vrm').length, 0);
    assert.equal(repairsOf(res, 'merge_assignment').length, 0);
    setRoster(res);
    assert.equal(isCurrentIdentity(801), true);
    assert.equal(isCurrentIdentity(802), true);
});

test('two registry rows for one trailer: the untouched auto-created one is removed', () => {
    const res = resolveFleet({
        registry: [trailer(10, 'Trailer 574', 798561, { status: 'on_rent', vin: '1BV' }), trailer(11, 'trailer 574 ', -89)],
        snapshots: [snap(798561, 'Trailer 574')], routers: [router(89, 'trailer 574 ')],
        rentals: [{ id: 1, trailer_id: 10, job_site_id: 7 }], rentalCounts: new Map([[10, 1]]), jobSites: SITES,
    });
    assert.equal(res.units.length, 1);
    assert.equal(res.units[0].trailer.id, 10);
    assert.deepEqual(repairsOf(res, 'remove_duplicate')[0], { type: 'remove_duplicate', trailer_id: 11, unit: 'trailer 574 ', keep: 10 });
    assert.equal(issuesOf(res, 'duplicate_registry').length, 0);
});

test('two registry rows that both carry history are reported, not deleted; the rented one leads', () => {
    const res = resolveFleet({
        registry: [trailer(10, 'Trailer 574', 798561, { vin: '1BV' }), trailer(11, 'trailer 574 ', -89, { status: 'on_rent' })],
        snapshots: [snap(798561, 'Trailer 574')], routers: [router(89, 'trailer 574 ')],
        rentals: [{ id: 1, trailer_id: 11, job_site_id: 7 }], rentalCounts: new Map([[11, 1]]), jobSites: SITES,
    });
    assert.equal(res.units.length, 1);
    assert.equal(res.units[0].trailer.id, 11);
    assert.equal(res.units[0].rental.id, 1);
    assert.equal(repairsOf(res, 'remove_duplicate').length, 0);
    assert.equal(issuesOf(res, 'duplicate_registry').length, 1);
});

test('a registry id that no longer exists in VRM falls back to the name', () => {
    const res = resolveFleet({
        registry: [trailer(5, 'BV-209', 990035, { status: 'on_rent' })],
        snapshots: [snap(300135, 'BV-209')], routers: [router(9135, 'BV-209')],
    });
    assert.equal(res.units.length, 1);
    assert.equal(res.units[0].site_id, 300135);
    assert.equal(repairsOf(res, 'relink')[0].from, 990035);
});

test('an explicit link wins over a name, and two differently named trailers never collapse', () => {
    const res = resolveFleet({
        registry: [trailer(1, 'BV-300', 500), trailer(2, 'BV-301', null)],
        snapshots: [snap(500, 'BV-301')], routers: [router(30, 'BV-300'), router(31, 'BV-301')],
    });
    assert.equal(res.units.length, 2);
    assert.equal(unitNamed(res, 'BV-300')[0].site_id, 500);
    assert.equal(unitNamed(res, 'BV-301')[0].site_id, -31);
    assert.equal(issuesOf(res, 'link_mismatch').length, 1);
    assert.equal(repairsOf(res, 'remove_duplicate').length, 0);
});

test('a router registered under its own name is the trailer its Cerbo is linked to', () => {
    const res = resolveFleet({
        registry: [trailer(1, 'Trailer 600', 600), trailer(2, 'MAX-BR1-7C2A', -77)],
        snapshots: [snap(600, 'Trailer 600')], routers: [router(77, 'MAX-BR1-7C2A')],
        assignments: [{ site_id: 600, job_site_id: 7, ic2_device_id: 77 }, { site_id: -77, job_site_id: null }],
        jobSites: SITES,
    });
    assert.equal(res.units.length, 1);
    assert.equal(res.units[0].router.id, 77);
    assert.equal(repairsOf(res, 'remove_duplicate')[0].trailer_id, 2);
});

test('telemetry nobody registered becomes a unit and is queued for registration', () => {
    const res = resolveFleet({
        snapshots: [snap(700, 'Trailer 700'), snap(701, 'Trailer 528 - RMA', 60 * DAY)],
        routers: [router(70, 'Trailer 700'), router(8, 'Trailer 502')],
    });
    assert.equal(res.units.length, 3);
    assert.equal(unitNamed(res, 'Trailer 700')[0].router.id, 70);
    assert.equal(unitNamed(res, 'Trailer 502')[0].site_id, -8);
    const reg = repairsOf(res, 'register');
    assert.equal(reg.length, 3);
    assert.equal(reg.find(r => r.unit === 'Trailer 528 - RMA').status, 'maintenance');
    assert.equal(reg.find(r => r.unit === 'Trailer 700').status, 'available');
});

test('in service means on rent or out with a customer; the rest is the yard', () => {
    const res = resolveFleet({
        registry: [
            trailer(1, 'A-rented', 1, { status: 'on_rent' }),
            trailer(2, 'B-customer-site', 2),                       // status still "available"
            trailer(3, 'C-hq', 3),
            trailer(4, 'D-560-BAD', 4),                             // sitting at a customer site, but named BAD
            trailer(5, 'E-retired', 5, { status: 'retired' }),
            trailer(6, 'F-nowhere', 6),
            trailer(7, 'G-reserved-at-hq', 7, { status: 'reserved' }),
            trailer(8, 'H-rented-unlinked', null, { status: 'on_rent' }),
        ],
        snapshots: [1, 2, 3, 4, 5, 6, 7].map(i => snap(i, ['A-rented', 'B-customer-site', 'C-hq', 'D-560-BAD', 'E-retired', 'F-nowhere', 'G-reserved-at-hq'][i - 1])),
        assignments: [
            { site_id: 1, job_site_id: 7 }, { site_id: 2, job_site_id: 7 }, { site_id: 3, job_site_id: 1 },
            { site_id: 4, job_site_id: 7 }, { site_id: 5, job_site_id: 1 }, { site_id: 7, job_site_id: 1 },
        ],
        rentals: [{ id: 1, trailer_id: 1, job_site_id: 7 }, { id: 2, trailer_id: 7, job_site_id: 7 }, { id: 3, trailer_id: 8, job_site_id: 7 }],
        jobSites: SITES,
    });
    const u = (n) => unitNamed(res, n)[0];
    assert.deepEqual([u('A-rented').in_service, u('A-rented').placement], [true, 'on_rent']);
    assert.deepEqual([u('B-customer-site').in_service, u('B-customer-site').placement], [true, 'customer_site']);
    assert.deepEqual([u('C-hq').in_service, u('C-hq').placement], [false, 'yard']);
    assert.deepEqual([u('D-560-BAD').in_service, u('D-560-BAD').placement], [false, 'shop']);
    assert.deepEqual([u('E-retired').in_service, u('E-retired').hidden], [false, true]);
    assert.deepEqual([u('F-nowhere').in_service, u('F-nowhere').placement], [false, 'unplaced']);
    assert.equal(u('G-reserved-at-hq').in_service, true, 'a reserved unit is about to ship');
    // On rent with no telemetry: location comes from the rental, and it is reported
    assert.equal(u('H-rented-unlinked').site.id, 7);
    assert.equal(u('H-rented-unlinked').site_source, 'rental');
    assert.equal(issuesOf(res, 'no_telemetry')[0].unit, 'H-rented-unlinked');
    assert.equal(issuesOf(res, 'shop_by_name')[0].unit, 'D-560-BAD');
    assert.equal(issuesOf(res, 'unplaced')[0].unit, 'F-nowhere');
});

test('a missing headquarters site is reported once', () => {
    const res = resolveFleet({
        registry: [trailer(1, 'X', 1), trailer(2, 'Y', 2)], snapshots: [snap(1, 'X'), snap(2, 'Y')],
        jobSites: [{ id: 7, name: 'Somewhere', is_headquarters: false }],
    });
    assert.equal(issuesOf(res, 'no_hq').length, 1);
});
