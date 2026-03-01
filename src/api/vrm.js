const API_BASE = '/api';

function authHeaders(contentType = false) {
    const headers = {};
    const token = localStorage.getItem('vrm_token');
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (contentType) headers['Content-Type'] = 'application/json';
    return headers;
}

async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
        ...options,
        headers: { ...authHeaders(!!options.body), ...options.headers },
    });
    if (res.status === 401) {
        localStorage.removeItem('vrm_token');
        window.location.reload();
        throw new Error('Session expired');
    }
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

// ============================================================
// Auth
// ============================================================

export async function login(username, password) {
    const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
}

export async function fetchCurrentUser() {
    return apiFetch(`${API_BASE}/auth/me`);
}

export async function changePassword(currentPassword, newPassword) {
    return apiFetch(`${API_BASE}/auth/change-password`, {
        method: 'POST',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
}

// ============================================================
// User Management (admin)
// ============================================================

export async function fetchUsers() {
    return apiFetch(`${API_BASE}/users`);
}

export async function createUserAccount(data) {
    return apiFetch(`${API_BASE}/users`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function updateUserAccount(id, data) {
    return apiFetch(`${API_BASE}/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}

export async function deleteUserAccount(id) {
    return apiFetch(`${API_BASE}/users/${id}`, { method: 'DELETE' });
}

export async function resetUserPassword(id, newPassword) {
    return apiFetch(`${API_BASE}/users/${id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ new_password: newPassword }),
    });
}

// ============================================================
// Sites & Fleet
// ============================================================

export async function fetchSites() {
    return apiFetch(`${API_BASE}/sites`);
}

export async function fetchDiagnostics(siteId) {
    return apiFetch(`${API_BASE}/sites/${siteId}/diagnostics`);
}

export async function fetchAlarms(siteId) {
    return apiFetch(`${API_BASE}/sites/${siteId}/alarms`);
}

export async function fetchSystemOverview(siteId) {
    return apiFetch(`${API_BASE}/sites/${siteId}/system`);
}

export async function fetchHistory(siteId, start, end) {
    return apiFetch(`${API_BASE}/history/${siteId}?start=${start}&end=${end}`);
}

export async function fetchFleetLatest() {
    return apiFetch(`${API_BASE}/fleet/latest`);
}

export async function fetchSettings() {
    return apiFetch(`${API_BASE}/settings`);
}

export async function updateSettings(settings) {
    return apiFetch(`${API_BASE}/settings`, {
        method: 'PUT',
        body: JSON.stringify(settings),
    });
}

export async function purgeData() {
    return apiFetch(`${API_BASE}/settings/purge`, { method: 'POST' });
}

export async function fetchFleetEnergy() {
    return apiFetch(`${API_BASE}/fleet/energy`);
}

export async function fetchFleetAlerts() {
    return apiFetch(`${API_BASE}/fleet/alerts`);
}

export async function fetchFleetNetwork() {
    return apiFetch(`${API_BASE}/fleet/network`);
}

export async function fetchFleetCombined() {
    return apiFetch(`${API_BASE}/fleet/combined`);
}

export async function fetchPepwaveHistory(name, start, end) {
    return apiFetch(`${API_BASE}/fleet/network/${encodeURIComponent(name)}/history?start=${start}&end=${end}`);
}

export async function fetchPepwaveDaily(name, days = 30) {
    return apiFetch(`${API_BASE}/fleet/network/${encodeURIComponent(name)}/daily?days=${days}`);
}

export async function fetchQuery(question) {
    return apiFetch(`${API_BASE}/query`, {
        method: 'POST',
        body: JSON.stringify({ question }),
    });
}

export async function semanticSearch(query, contentTypes = null, limit = 20) {
    return apiFetch(`${API_BASE}/search/semantic`, {
        method: 'POST',
        body: JSON.stringify({ query, contentTypes, limit }),
    });
}

export async function generateEmbeddings() {
    return apiFetch(`${API_BASE}/embeddings/generate`, { method: 'POST' });
}

export async function getEmbeddingStats() {
    return apiFetch(`${API_BASE}/embeddings/stats`);
}

// ============================================================
// Job Sites
// ============================================================

export async function fetchJobSites() {
    return apiFetch(`${API_BASE}/job-sites`);
}

export async function fetchJobSite(id) {
    return apiFetch(`${API_BASE}/job-sites/${id}`);
}

export async function updateJobSite(id, data) {
    return apiFetch(`${API_BASE}/job-sites/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}

export async function assignTrailer(jobSiteId, siteId) {
    return apiFetch(`${API_BASE}/job-sites/${jobSiteId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId }),
    });
}

export async function reclusterJobSites() {
    return apiFetch(`${API_BASE}/job-sites/recluster`, { method: 'POST' });
}

export async function fetchMapSites() {
    return apiFetch(`${API_BASE}/map/sites`);
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
    return apiFetch(`${API_BASE}/maintenance${qs ? '?' + qs : ''}`);
}

export async function fetchMaintenanceStats() {
    return apiFetch(`${API_BASE}/maintenance/stats`);
}

export async function createMaintenanceLog(data) {
    return apiFetch(`${API_BASE}/maintenance`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function updateMaintenanceLog(id, data) {
    return apiFetch(`${API_BASE}/maintenance/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}

export async function deleteMaintenanceLog(id) {
    return apiFetch(`${API_BASE}/maintenance/${id}`, { method: 'DELETE' });
}

// ============================================================
// Analytics
// ============================================================

export async function fetchFleetAnalytics(days = 30) {
    return apiFetch(`${API_BASE}/analytics/fleet-summary?days=${days}`);
}

export async function fetchAnalyticsRankings(days = 7) {
    return apiFetch(`${API_BASE}/analytics/rankings?days=${days}`);
}

export async function fetchJobSiteAnalytics(id, days = 30) {
    return apiFetch(`${API_BASE}/analytics/job-site/${id}?days=${days}`);
}

export async function fetchTrailerAnalytics(id, days = 30) {
    return apiFetch(`${API_BASE}/analytics/trailer/${id}?days=${days}`);
}

export async function backfillAnalytics(days = 7) {
    return apiFetch(`${API_BASE}/analytics/backfill`, {
        method: 'POST',
        body: JSON.stringify({ days }),
    });
}

// ============================================================
// Components
// ============================================================

export async function fetchComponents(siteId) {
    return apiFetch(`${API_BASE}/components/${siteId}`);
}

export async function createComponent(data) {
    return apiFetch(`${API_BASE}/components`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function updateComponent(id, data) {
    return apiFetch(`${API_BASE}/components/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}

// ============================================================
// Maintenance Costs & Alerts
// ============================================================

export async function fetchMaintenanceCostsBySite(days = 30) {
    return apiFetch(`${API_BASE}/maintenance/costs-by-site?days=${days}`);
}

export async function fetchAlertHistory(days = 30) {
    return apiFetch(`${API_BASE}/alerts/history?days=${days}`);
}

export async function fetchFleetDashboard() {
    return apiFetch(`${API_BASE}/fleet/dashboard`);
}

export async function fetchBatteryHealth(siteId, days = 30) {
    return apiFetch(`${API_BASE}/analytics/trailer/${siteId}/battery-health?days=${days}`);
}

export async function fetchSiteMaintenance(jobSiteId) {
    return apiFetch(`${API_BASE}/maintenance?job_site_id=${jobSiteId}&limit=10`);
}

// ============================================================
// Intelligence
// ============================================================

export async function fetchTrailerIntelligence(siteId) {
    return apiFetch(`${API_BASE}/intelligence/trailer/${siteId}`);
}

export async function fetchFleetIntelligence() {
    return apiFetch(`${API_BASE}/fleet/intelligence`);
}

export async function analyzeTrailer(siteId) {
    return apiFetch(`${API_BASE}/analyze/trailer/${siteId}`, { method: 'POST' });
}

// ============================================================
// Action Queue
// ============================================================

export async function fetchActionQueue() {
    return apiFetch(`${API_BASE}/action-queue`);
}

export async function acknowledgeAction(key, notes) {
    return apiFetch(`${API_BASE}/action-queue/${encodeURIComponent(key)}/acknowledge`, {
        method: 'POST',
        body: JSON.stringify({ notes }),
    });
}

export async function unacknowledgeAction(key) {
    return apiFetch(`${API_BASE}/action-queue/${encodeURIComponent(key)}/acknowledge`, {
        method: 'DELETE',
    });
}

// ============================================================
// Health Grades
// ============================================================

export async function fetchHealthGrades() {
    return apiFetch(`${API_BASE}/fleet/health-grades`);
}

// ============================================================
// Checklist & Issue Templates
// ============================================================

export async function fetchChecklistTemplates() {
    return apiFetch(`${API_BASE}/checklist-templates`);
}

export async function createChecklistTemplate(data) {
    return apiFetch(`${API_BASE}/checklist-templates`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function updateChecklistTemplate(id, data) {
    return apiFetch(`${API_BASE}/checklist-templates/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}

export async function fetchCompletedChecklists(maintenanceLogId) {
    return apiFetch(`${API_BASE}/maintenance/${maintenanceLogId}/checklists`);
}

export async function submitChecklist(maintenanceLogId, data) {
    return apiFetch(`${API_BASE}/maintenance/${maintenanceLogId}/checklists`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function fetchIssueTemplates() {
    return apiFetch(`${API_BASE}/issue-templates`);
}

export async function createIssueTemplate(data) {
    return apiFetch(`${API_BASE}/issue-templates`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export async function updateIssueTemplate(id, data) {
    return apiFetch(`${API_BASE}/issue-templates/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
}

// ============================================================
// Maintenance Calendar
// ============================================================

export async function fetchMaintenanceCalendar(start, end, technicianId) {
    const params = new URLSearchParams();
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    if (technicianId) params.set('technician_id', technicianId);
    const qs = params.toString();
    return apiFetch(`${API_BASE}/maintenance/calendar${qs ? '?' + qs : ''}`);
}

// ============================================================
// Reports
// ============================================================

export async function fetchTrailerReport(siteId) {
    return apiFetch(`${API_BASE}/reports/trailer/${siteId}`);
}

export async function fetchSiteReport(jobSiteId) {
    return apiFetch(`${API_BASE}/reports/site/${jobSiteId}`);
}

export async function fetchFleetReport() {
    return apiFetch(`${API_BASE}/reports/fleet`);
}
