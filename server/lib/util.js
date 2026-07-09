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

export function getPepwaveForTrailer(trailer) {
    let pw = pepwaveCache.get(trailer.site_name);
    if (pw) return pw;
    if (trailer.ic2_device_id) {
        const name = ic2DeviceIdToName.get(trailer.ic2_device_id);
        if (name) pw = pepwaveCache.get(name);
    }
    return pw || null;
}
