import { VRM_TOKEN, VRM_BASE } from '../config.js';

// --- VRM API helper ---
export const vrmHeaders = { 'x-authorization': `Token ${VRM_TOKEN}` };

export async function vrmFetch(endpoint) {
    const res = await fetch(`${VRM_BASE}${endpoint}`, { headers: vrmHeaders });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`VRM API ${res.status}: ${text}`);
    }
    return res.json();
}

// --- Helper: extract values from diagnostics records ---
export function extractDiagValue(records, code) {
    const match = records.find(r => r.code === code && r.Device !== 'Gateway');
    if (!match) return null;
    const val = match.rawValue;
    if (val === undefined || val === null || val === '') return null;
    const num = Number(val);
    return isNaN(num) ? val : num;
}

// Extract the most recent VRM record timestamp (Unix seconds → ms)
export function extractVrmTimestamp(records) {
    let latest = 0;
    for (const r of records) {
        if (r.timestamp && r.timestamp > latest) latest = r.timestamp;
    }
    return latest > 0 ? latest * 1000 : null;  // convert to ms
}
