const API_BASE = '/api';

export async function fetchSites() {
    const res = await fetch(`${API_BASE}/sites`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchDiagnostics(siteId) {
    const res = await fetch(`${API_BASE}/sites/${siteId}/diagnostics`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchAlarms(siteId) {
    const res = await fetch(`${API_BASE}/sites/${siteId}/alarms`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchSystemOverview(siteId) {
    const res = await fetch(`${API_BASE}/sites/${siteId}/system`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchHistory(siteId, start, end) {
    const res = await fetch(`${API_BASE}/history/${siteId}?start=${start}&end=${end}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchFleetLatest() {
    const res = await fetch(`${API_BASE}/fleet/latest`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchSettings() {
    const res = await fetch(`${API_BASE}/settings`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function updateSettings(settings) {
    const res = await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function purgeData() {
    const res = await fetch(`${API_BASE}/settings/purge`, { method: 'POST' });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchFleetEnergy() {
    const res = await fetch(`${API_BASE}/fleet/energy`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchFleetAlerts() {
    const res = await fetch(`${API_BASE}/fleet/alerts`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchFleetNetwork() {
    const res = await fetch(`${API_BASE}/fleet/network`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}
