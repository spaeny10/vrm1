// Run: npm test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

mock.module('../db.js', {
    namedExports: {
        getTrailers: async () => [], getTrailerAssignments: async () => [], getJobSites: async () => [],
        getRentals: async () => [], getRentalCountsByTrailer: async () => new Map(),
        insertAlertHistory: async () => { }, resolveAlert: async () => { }, getActiveAlerts: async () => [], updateActiveAlert: async () => { },
    },
});
mock.module('../email.js', {
    namedExports: {
        sendAlertEmail: async () => { }, sendAlertResolvedEmail: async () => { },
        isEmailConfigured: () => false, checkRateLimit: () => false, markNotified: () => { },
    },
});

const { snapshotCache, dailyEnergy } = await import('../state.js');
const { computeAlerts } = await import('./alerts.js');
const { resolveFleet, setRoster } = await import('./roster.js');

const DAY = 86400000;
const now = Date.now();
const date = (daysAgo) => new Date(now - daysAgo * DAY).toISOString().slice(0, 10);
const snap = (id, name, soc, ageMs = 60000) => ({ site_id: id, site_name: name, vrm_timestamp: now - ageMs, battery_soc: soc, battery_voltage: 26 });
// N days of real deficit ending yesterday
const deficit = (name, days, socEod = 40) => Object.fromEntries(Array.from({ length: days }, (_, i) =>
    [date(i + 1), { site_name: name, yield_wh: 1000, consumed_wh: 2400, battery_soc_eod: socEod, mppt_state_eod: 3 }]));

const SITES = [{ id: 1, name: 'HQ', is_headquarters: true }, { id: 7, name: 'Customer site', is_headquarters: false }];
const trailer = (id, unit, vrm, status = 'on_rent') => ({ id, unit_number: unit, vrm_site_id: vrm, status });

function fleet({ registry, snaps, assignments, energy }) {
    snapshotCache.clear(); dailyEnergy.clear();
    for (const s of snaps) snapshotCache.set(s.site_id, s);
    for (const [id, days] of Object.entries(energy)) dailyEnergy.set(Number(id), days);
    setRoster(resolveFleet({ registry, snapshots: snaps, assignments, jobSites: SITES }));
    return computeAlerts();
}

test('an in-service trailer draining its battery raises a critical alert', () => {
    const alerts = fleet({
        registry: [trailer(1, 'BV-107', 107)], snaps: [snap(107, 'BV-107', 11)],
        assignments: [{ site_id: 107, job_site_id: 7 }], energy: { 107: deficit('BV-107', 6) },
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].severity, 'critical');
    assert.equal(alerts[0].streak_days, 6);
});

test('the same streak on a battery that is holding is a warning, not critical', () => {
    const alerts = fleet({
        registry: [trailer(1, 'BV-213', 213)], snaps: [snap(213, 'BV-213', 85)],
        assignments: [{ site_id: 213, job_site_id: 7 }], energy: { 213: deficit('BV-213', 6, 85) },
    });
    assert.equal(alerts[0].severity, 'warning');
    assert.equal(alerts[0].battery_holding, true);
});

test('a unit in the yard never raises an energy alert (shore power, covered panels)', () => {
    const alerts = fleet({
        registry: [trailer(1, 'BV-207', 207, 'available')], snaps: [snap(207, 'BV-207', 100)],
        assignments: [{ site_id: 207, job_site_id: 1 }], energy: { 207: deficit('BV-207', 14, 100) },
    });
    assert.equal(alerts.length, 0);
    assert.equal(computeAlerts({ all: true }).length, 1, 'still visible when asked for every installation');
});

test('a trailer that has gone dark has no energy alert; the board reports it offline', () => {
    const alerts = fleet({
        registry: [trailer(1, 'BV-115', 115)], snaps: [snap(115, 'BV-115', 30, 2 * DAY)],
        assignments: [{ site_id: 115, job_site_id: 7 }], energy: { 115: deficit('BV-115', 4) },
    });
    assert.equal(alerts.length, 0);
});

test('a superseded VRM installation never raises an alert', () => {
    const alerts = fleet({
        registry: [trailer(1, 'BV-215', 300)],
        snaps: [snap(300, 'BV-215', 70), snap(299, 'BV-215', 20, 90 * DAY)],
        assignments: [{ site_id: 300, job_site_id: 7 }, { site_id: 299, job_site_id: 7 }],
        energy: { 299: deficit('BV-215', 5), 300: {} },
    });
    assert.equal(alerts.length, 0);
});
