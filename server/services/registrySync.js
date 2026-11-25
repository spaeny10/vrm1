// ============================================================
// Keeps the trailer registry in step with what VRM and InControl
// actually report: registers new units, re-points rows whose link
// has gone stale, removes untouched duplicate rows, and moves a job
// site assignment off an id the trailer no longer reports under.
//
// The repairs come from the roster. They are only applied from a
// complete picture of both systems, because a half-loaded cache
// would make healthy links look broken.
// ============================================================
import { dbAvailable, sitesCache, snapshotCache, ic2DeviceIdToSiteId } from '../state.js';
import { applyRosterRepair, insertAuditLog } from '../db.js';
import { refreshRoster, telemetryReady } from './roster.js';

const ORDER = { remove_duplicate: 0, relink: 1, merge_assignment: 2, register: 3 };

const describe = (r) => ({
    remove_duplicate: `removed duplicate registry row "${r.unit}"`,
    relink: `re-linked "${r.unit}" from VRM ${r.from ?? 'none'} to ${r.to}`,
    merge_assignment: `moved "${r.unit}" site assignment from id ${r.from} to ${r.to}`,
    register: `registered "${r.unit}"`,
}[r.type]);

// Complete = both pollers have run and every VRM installation has a reading.
// One failed installation is enough to wait for the next poll.
export function telemetryComplete() {
    if (!telemetryReady()) return false;
    const vrmIds = (sitesCache?.records || []).map(s => s.idSite);
    return vrmIds.length > 0 && vrmIds.every(id => snapshotCache.has(id));
}

// Set REGISTRY_AUTO_REPAIR=false to stop the automatic repairs. The roster still
// shows one row per trailer and lists what it would have fixed under Records to fix.
const AUTO_REPAIR = process.env.REGISTRY_AUTO_REPAIR !== 'false';

export async function reconcileRegistry() {
    if (!dbAvailable) return null;
    if (!AUTO_REPAIR || !telemetryComplete()) { await refreshRoster(); return null; }

    const roster = await refreshRoster();
    let repairs = [...roster.repairs].sort((a, b) => ORDER[a.type] - ORDER[b.type]);
    // Sanity check: duplicates are rare. If a pass wants to remove a large share
    // of the registry, something upstream is wrong, so remove nothing.
    const registrySize = roster.units.reduce((n, u) => n + (u.trailer ? 1 : 0) + u.duplicates.length, 0);
    const removals = repairs.filter(r => r.type === 'remove_duplicate').length;
    if (removals > Math.max(10, registrySize * 0.2)) {
        console.warn(`  Registry: ${removals} of ${registrySize} rows look like duplicates, which is implausible. Skipping removals.`);
        repairs = repairs.filter(r => r.type !== 'remove_duplicate');
    }
    let applied = 0;
    for (const r of repairs) {
        try {
            if (!(await applyRosterRepair(r))) continue;
            applied++;
            // Keep the router pointed at the id its trailer reports under now
            if (r.type === 'merge_assignment' && r.router_id != null) ic2DeviceIdToSiteId.set(r.router_id, r.to);
            console.log(`  Registry: ${describe(r)}`);
            insertAuditLog('trailer', r.trailer_id ?? r.keep ?? null, `registry_${r.type}`, r, 'system').catch(() => { });
        } catch (err) {
            console.warn(`  Registry repair failed (${r.type} ${r.unit}): ${err.message}`);
        }
    }
    if (applied) await refreshRoster();
    return { applied };
}
