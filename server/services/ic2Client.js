import { IC2_CLIENT_ID, IC2_CLIENT_SECRET, IC2_BASE } from '../config.js';

// ============================================================
// InControl2 OAuth2 Token Management
// ============================================================
export let ic2Token = null;

export let ic2TokenExpiry = 0;

export let ic2RefreshToken = null;

export async function getIc2Token() {
    // Return cached token if still valid (with 5 min buffer)
    if (ic2Token && Date.now() < ic2TokenExpiry - 300000) {
        return ic2Token;
    }

    // Try refresh first
    if (ic2RefreshToken) {
        try {
            const res = await fetch(`${IC2_BASE}/api/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `client_id=${IC2_CLIENT_ID}&client_secret=${IC2_CLIENT_SECRET}&grant_type=refresh_token&refresh_token=${ic2RefreshToken}`,
            });
            if (res.ok) {
                const data = await res.json();
                ic2Token = data.access_token;
                ic2RefreshToken = data.refresh_token;
                ic2TokenExpiry = Date.now() + data.expires_in * 1000;
                console.log(`  IC2 token refreshed (expires in ${(data.expires_in / 3600).toFixed(0)}h)`);
                return ic2Token;
            }
        } catch (e) { /* fall through to full auth */ }
    }

    // Full client_credentials auth
    const res = await fetch(`${IC2_BASE}/api/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `client_id=${IC2_CLIENT_ID}&client_secret=${IC2_CLIENT_SECRET}&grant_type=client_credentials`,
    });
    if (!res.ok) {
        throw new Error(`IC2 auth failed: ${res.status}`);
    }
    const data = await res.json();
    ic2Token = data.access_token;
    ic2RefreshToken = data.refresh_token;
    ic2TokenExpiry = Date.now() + data.expires_in * 1000;
    console.log(`  IC2 token obtained (expires in ${(data.expires_in / 3600).toFixed(0)}h)`);
    return ic2Token;
}

export async function ic2Fetch(endpoint, retryOn401 = true) {
    const token = await getIc2Token();
    const res = await fetch(`${IC2_BASE}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const text = await res.text();
        // On 401, invalidate token and retry once
        if (res.status === 401 && retryOn401) {
            console.log('  IC2 token invalid, refreshing...');
            ic2Token = null;
            ic2TokenExpiry = 0;
            return ic2Fetch(endpoint, false); // Retry without further recursion
        }
        throw new Error(`IC2 API ${res.status}: ${text}`);
    }
    return res.json();
}

// ============================================================
// IC2 data extraction helpers
// ============================================================
export function extractCellularInfo(device) {
    const ifaces = device.interfaces || [];
    const cell = ifaces.find(i => i.type === 'gobi' || i.virtualType === 'cellular');
    if (!cell) return null;

    return {
        status: cell.status || 'Unknown',
        carrier: cell.carrier_name || 'Unknown',
        ip: cell.ip || null,
        technology: cell.gobi_data_tech || cell.data_technology || cell.s2g3glte || 'Unknown',
        band: cell.gobi_band_class_name || null,
        signal_bar: cell.signal_bar ?? null,
        signal: cell.cellular_signals || null,
        apn: cell.apn || null,
        imei: cell.imei || null,
        sims: (cell.sims || []).map(s => ({
            id: s.id,
            detected: s.simCardDetected,
            active: s.active,
            carrier: s.mtn || null,
            iccid: s.iccid || null,
            imsi: s.imsi || null,
            apn: s.apn || null,
        })),
    };
}

export function extractWanInterfaces(device) {
    const ifaces = device.interfaces || [];
    return ifaces.map(i => ({
        id: i.id,
        name: i.name,
        type: i.virtualType || i.type,
        status: i.status,
        status_led: i.status_led,
        ip: i.ip || null,
        message: i.message || '',
    }));
}
