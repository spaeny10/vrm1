// Run: node --test --experimental-test-module-mocks server/services/board.test.js
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const HOUR = 3600 * 1000;
const now = Date.now();

// Registry as it looks in production: Trailer 619 was registered from its
// router (synthetic id -156) before its Cerbo (VRM 1004498) existed.
const registry = [
    { id: 179, unit_number: 'Trailer 619', vrm_site_id: -156, status: 'available' },
    { id: 200, unit_number: 'Trailer 572', vrm_site_id: 810619, status: 'on_rent' },
    // Not-deployed cases
    { id: 301, unit_number: 'Trailer 700', vrm_site_id: 700700, status: 'available' },     // at HQ
    { id: 302, unit_number: 'Trailer 560-BAD', vrm_site_id: null, status: 'on_rent' },    // name says shop
    { id: 303, unit_number: 'Trailer 710', vrm_site_id: 710710, status: 'available' },     // at a customer site
    { id: 304, unit_number: 'Trailer 720', vrm_site_id: 720720, status: 'retired' },
    // Registry id is stale (no such VRM install); the live one is named "Trailer 730"
    { id: 305, unit_number: '730', vrm_site_id: 999999, status: 'on_rent' },
];
mock.module('../db.js', {
    namedExports: {
        getTrailers: async () => registry,
        getTrailerAssignments: async () => [
            { site_id: -156, job_site_id: 7, latitude: 30.2, longitude: -97.7 },
            { site_id: 700700, job_site_id: 9 },
            { site_id: 710710, job_site_id: 7 },
        ],
        getJobSites: async () => [
            { id: 7, name: 'Austin, Texas #2', company_id: null },
            { id: 9, name: 'Big View HQ', company_id: null, is_headquarters: true },
        ],
        getCompanies: async () => [],
        getRentals: async () => [],
        getSetting: async () => null, getDailyEnergy: async () => [], getMaintenanceStatsBySite: async () => [],
    },
});
mock.module('./alerts.js', { namedExports: { computeAlerts: () => [] } });

const { snapshotCache, pepwaveCache } = await import('../state.js');
const { buildTrailerBoard, summarize } = await import('./board.js');
const { silentTelemetryStatus, computeTechStatus } = await import('./intelligence.js');

const snap = (id, name, ageMs, soc = 80) => ({
    site_id: id, site_name: name, timestamp: now, vrm_timestamp: now - ageMs,
    battery_soc: soc, battery_voltage: 26.4, solar_watts: 100,
});
const router = (id, name, online, extra = {}) => ({ id, name, online, timestamp: now, ...extra });

snapshotCache.set(1004498, snap(1004498, 'Trailer 619', 23 * 24 * HOUR, 4));
snapshotCache.set(810619, snap(810619, 'Trailer 572', 5 * 60 * 1000));
snapshotCache.set(798561, snap(798561, 'Trailer 574', 21 * HOUR));
snapshotCache.set(983021, snap(983021, 'Trailer 617', 70 * 60 * 1000, 6));
snapshotCache.set(755841, snap(755841, 'Trailer 548', 11 * 24 * HOUR, 46));
pepwaveCache.set('Trailer 619', router(156, 'Trailer 619', true));
pepwaveCache.set('Trailer 572', router(96, 'Trailer 572', true));
pepwaveCache.set('trailer 574 ', router(89, 'trailer 574 ', true)); // sloppy name in IC2
pepwaveCache.set('Trailer 617', router(120, 'Trailer 617', true));
pepwaveCache.set('Trailer 548', router(60, 'Trailer 548', false, { last_online: '2026-10-30 06:40:00' }));
pepwaveCache.set('Trailer 502', router(8, 'Trailer 502', true));
snapshotCache.set(700700, snap(700700, 'Trailer 700', 5 * 24 * HOUR));
snapshotCache.set(710710, snap(710710, 'Trailer 710', 5 * 24 * HOUR));
snapshotCache.set(720720, snap(720720, 'Trailer 720', 5 * 24 * HOUR));
snapshotCache.set(730730, snap(730730, 'Trailer 730', 5 * 60 * 1000));
pepwaveCache.set('Trailer 700', router(70, 'Trailer 700', false));
pepwaveCache.set('Trailer 710', router(71, 'Trailer 710', false));
pepwaveCache.set('Trailer 560-BAD', router(56, 'Trailer 560-BAD', false));

const rows = await buildTrailerBoard();
const byUnit = u => rows.filter(r => r.unit.trim().toLowerCase() === u.toLowerCase());

test('router and Cerbo of one trailer are one row, keeping its job site', () => {
    const r = byUnit('Trailer 619');
    assert.equal(r.length, 1);
    assert.equal(r[0].site_id, 1004498);
    assert.equal(r[0].trailer_id, 179);
    assert.equal(r[0].site?.name, 'Austin, Texas #2');
});

test('silent Cerbo behind an online router needs attention, not healthy', () => {
    const r = byUnit('Trailer 619')[0];
    assert.equal(r.health, 'attention');
    assert.match(r.diagnosis, /Cerbo silent 23d — router online/);
    assert.match(r.diagnosis, /last SOC 4%/);
});

test('loose name match finds the router, and does not add a duplicate row', () => {
    const r = byUnit('Trailer 574');
    assert.equal(r.length, 1);
    assert.equal(r[0].online, true);
    assert.equal(r[0].health, 'attention');
});

test('briefly late Cerbo is watch, unless the last SOC was critical', () => {
    assert.equal(silentTelemetryStatus(snap(1, 'x', 70 * 60 * 1000), { online: true }).status, 'watch');
    assert.equal(byUnit('Trailer 617')[0].health, 'attention');
});

test('live trailers and router-only trailers are unaffected', () => {
    assert.equal(byUnit('Trailer 572')[0].health, 'good');
    const r502 = byUnit('Trailer 502')[0];
    assert.equal(r502.health, 'good');
    assert.equal(r502.diagnosis, 'Network only — no Cerbo in VRM');
});

test('router and Cerbo both down is offline, and last_seen is the Cerbo time, not poll time', () => {
    const r = byUnit('Trailer 548')[0];
    assert.equal(r.health, 'offline');
    assert.ok(now - r.last_seen > 10 * 24 * HOUR);
});

test('offline router-only device reports its last check-in, not the poll time', async () => {
    pepwaveCache.set('Trailer 501', router(1, 'Trailer 501', false, { last_online: '2026-01-10 12:00:00' }));
    const r = (await buildTrailerBoard()).find(x => x.unit === 'Trailer 501');
    assert.equal(r.health, 'offline');
    assert.ok(now - r.last_seen > 24 * HOUR);
});

test('a unit at HQ that goes dark is not deployed, not offline', () => {
    const r = byUnit('Trailer 700')[0];
    assert.equal(r.health, 'inactive');
    assert.equal(r.not_deployed, true);
});

test('a BAD/RMA-named unit with no site is not deployed', () => {
    assert.equal(byUnit('Trailer 560-BAD')[0].health, 'inactive');
});

test('an "available" unit sitting at a customer site still shows offline', () => {
    const r = byUnit('Trailer 710')[0];
    assert.equal(r.health, 'offline');
    assert.equal(r.not_deployed, false);
});

test('retired units are left off the board', () => {
    assert.equal(byUnit('Trailer 720').length, 0);
});

test('a stale registry id adopts the live VRM install with the same unit number', () => {
    const r = rows.filter(x => x.trailer_id === 305 || x.site_id === 730730);
    assert.equal(r.length, 1);
    assert.equal(r[0].site_id, 730730);
    assert.equal(r[0].trailer_id, 305);
    assert.equal(r[0].health, 'good');
});

test('fleet totals exclude units that are not deployed', () => {
    const s = summarize(rows);
    assert.equal(s.inactive, 2);
    assert.equal(s.total, rows.length - 2);
});

test('a long deficit streak on a full battery is watch, not attention', () => {
    snapshotCache.set(840840, snap(840840, 'Trailer 840', 5 * 60 * 1000, 85));
    pepwaveCache.set('Trailer 840', router(84, 'Trailer 840', true));
    const full = computeTechStatus(840840, { 840840: 6 });
    assert.equal(full.status, 'watch');
    assert.match(full.reason, /Energy deficit: 6 day streak/);
    snapshotCache.set(840840, snap(840840, 'Trailer 840', 5 * 60 * 1000, 60));
    assert.equal(computeTechStatus(840840, { 840840: 6 }).status, 'attention');
});
