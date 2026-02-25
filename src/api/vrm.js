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

export async function fetchFleetCombined() {
    const res = await fetch(`${API_BASE}/fleet/combined`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchPepwaveHistory(name, start, end) {
    const res = await fetch(`${API_BASE}/fleet/network/${encodeURIComponent(name)}/history?start=${start}&end=${end}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchPepwaveDaily(name, days = 30) {
    const res = await fetch(`${API_BASE}/fleet/network/${encodeURIComponent(name)}/daily?days=${days}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchQuery(question) {
    const res = await fetch(`${API_BASE}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function semanticSearch(query, contentTypes = null, limit = 20) {
    const res = await fetch(`${API_BASE}/search/semantic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, contentTypes, limit }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function generateEmbeddings() {
    const res = await fetch(`${API_BASE}/embeddings/generate`, { method: 'POST' });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function getEmbeddingStats() {
    const res = await fetch(`${API_BASE}/embeddings/stats`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// ============================================================
// Job Sites
// ============================================================

export async function fetchJobSites() {
    const res = await fetch(`${API_BASE}/job-sites`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchJobSite(id) {
    const res = await fetch(`${API_BASE}/job-sites/${id}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function updateJobSite(id, data) {
    const res = await fetch(`${API_BASE}/job-sites/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function assignTrailer(jobSiteId, siteId) {
    const res = await fetch(`${API_BASE}/job-sites/${jobSiteId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site_id: siteId }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function reclusterJobSites() {
    const res = await fetch(`${API_BASE}/job-sites/recluster`, { method: 'POST' });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchMapSites() {
    const res = await fetch(`${API_BASE}/map/sites`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// ============================================================
// Maintenance
// ============================================================

export async function fetchMaintenanceLogs(filters = {}) {
    const params = new URLSearchParams();
    if (filters.job_site_id) params.set('job_site_id', filters.job_site_id);
    if (filters.site_id) params.set('site_id', filters.site_id);
    if (filters.status) params.set('status', filters.status);
    if (filters.limit) params.set('limit', filters.limit);
    const qs = params.toString();
    const res = await fetch(`${API_BASE}/maintenance${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchMaintenanceStats() {
    const res = await fetch(`${API_BASE}/maintenance/stats`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function createMaintenanceLog(data) {
    const res = await fetch(`${API_BASE}/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function updateMaintenanceLog(id, data) {
    const res = await fetch(`${API_BASE}/maintenance/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function deleteMaintenanceLog(id) {
    const res = await fetch(`${API_BASE}/maintenance/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// ============================================================
// Analytics
// ============================================================

export async function fetchFleetAnalytics(days = 30) {
    const res = await fetch(`${API_BASE}/analytics/fleet-summary?days=${days}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchAnalyticsRankings(days = 7) {
    const res = await fetch(`${API_BASE}/analytics/rankings?days=${days}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchJobSiteAnalytics(id, days = 30) {
    const res = await fetch(`${API_BASE}/analytics/job-site/${id}?days=${days}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchTrailerAnalytics(id, days = 30) {
    const res = await fetch(`${API_BASE}/analytics/trailer/${id}?days=${days}`);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function backfillAnalytics(days = 7) {
    const res = await fetch(`${API_BASE}/analytics/backfill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}
