import { VRM_STALE_MS } from '../config.js';
import { pepwaveCache, ic2DeviceIdToSiteId, ic2DeviceIdToName } from '../state.js';

// ============================================================
// Helper: does this trailer have actual VRM/Victron data?
// Trailers with only Peplink (no Victron) show 0%/null for everything and should be
// excluded from energy/solar/battery KPIs.
export function hasVrmData(snapshot) {
    if (!snapshot) return false;
    // Must have actual data fields
    const hasData = snapshot.battery_voltage != null || snapshot.solar_watts != null
        || (snapshot.battery_soc != null && snapshot.battery_soc > 0);
    if (!hasData) return false;
    // If we have a VRM timestamp, check staleness (>30 min = stale)
    if (snapshot.vrm_timestamp && (Date.now() - snapshot.vrm_timestamp) > VRM_STALE_MS) return false;
    return true;
}

// ============================================================
// Daily energy tracker: siteId -> { [dateStr]: { yield_wh, consumed_wh, site_name } }
// Keeps up to 14 days of data in memory
// ============================================================
export function todayStr() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export function extractMpptState(snapshot) {
    if (!snapshot) return null;

    const chargeState = snapshot.charge_state || snapshot.mppt_state;

    // Normalize to numeric if string
    if (typeof chargeState === 'string') {
        const csNum = parseInt(chargeState, 10);
        if (!isNaN(csNum)) return csNum;

        // String states
        if (/float/i.test(chargeState)) return 5;
        if (/storage/i.test(chargeState)) return 6;
    }

    return typeof chargeState === 'number' ? chargeState : null;
}

export function mpptStateToString(state) {
    const states = {
        0: 'Off', 1: 'Low power', 2: 'Fault', 3: 'Bulk',
        4: 'Absorption', 5: 'Float', 6: 'Storage', 7: 'Equalize', 252: 'External'
    };
    return states[state] || `Unknown (${state})`;
}

// Unit names are typed by hand in VRM, InControl and the registry
// ("Trailer 619", "trailer 619", "Trailer  619 "), so compare them loosely.
export function normalizeUnitName(name) {
    return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Pepwave record for a unit name: exact key first, then a loose match.
export function findPepwaveByName(name) {
    if (name == null) return null;
    const exact = pepwaveCache.get(name);
    if (exact) return exact;
    const want = normalizeUnitName(name);
    for (const [key, rec] of pepwaveCache) {
        if (normalizeUnitName(key) === want) return rec;
    }
    return null;
}

// Short human age: 45m, 20h, 13d
export function formatAge(ms) {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 90) return `${min}m`;
    const hrs = Math.round(min / 60);
    if (hrs < 48) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
}

export function getPepwaveForTrailer(trailer) {
    let pw = findPepwaveByName(trailer.site_name);
    if (pw) return pw;
    if (trailer.ic2_device_id) {
        const name = ic2DeviceIdToName.get(trailer.ic2_device_id);
        if (name) pw = pepwaveCache.get(name);
    }
    return pw || null;
}
