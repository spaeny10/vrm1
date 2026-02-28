import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import {
    initDb, insertSnapshot, getHistory, getLatestSnapshots,
    getRetentionDays, setRetentionDays, pruneOldData, getDbStats,
    insertPepwaveSnapshot, getPepwaveHistory, getPepwaveDailyUsage,
    upsertEmbedding, semanticSearch, getEmbeddingStats, getAllContentForEmbedding,
    getJobSites, getJobSite, insertJobSite, updateJobSite,
    getTrailerAssignments, getTrailersByJobSite, upsertTrailerAssignment,
    assignTrailerToJobSite, getTrailersWithGps,
    getMaintenanceLogs, getMaintenanceLog, insertMaintenanceLog,
    updateMaintenanceLog, deleteMaintenanceLog, getMaintenanceStats, getMaintenanceCostsByJobSite,
    getUpcomingMaintenance,
    getComponents, insertComponent, updateComponent,
    computeDailyMetrics, getFleetAnalyticsSummary, getJobSiteRankings,
    getAnalyticsByJobSite, getAnalyticsByTrailer, getAnalyticsDateRange
} from './db.js';
import {
    generateQueryEmbedding, embedSiteSnapshots, embedPepwaveDevices,
    embedAlerts, isConfigured as isEmbeddingsConfigured
} from './embeddings.js';
import { runClustering } from './clustering.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const VRM_TOKEN = process.env.VRM_API_TOKEN;
const VRM_USER_ID = process.env.VRM_USER_ID;
const VRM_BASE = 'https://vrmapi.victronenergy.com/v2';

// InControl2 credentials
const IC2_CLIENT_ID = process.env.IC2_CLIENT_ID;
const IC2_CLIENT_SECRET = process.env.IC2_CLIENT_SECRET;
const IC2_BASE = 'https://api.ic.peplink.com';
const IC2_ORG_ID = 'VdYVxn';
const IC2_GROUP_ID = 1;

// Claude API for natural language queries
const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;

app.use(cors());
app.use(express.json());

// --- In production, serve the built React frontend ---
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));

// --- VRM API helper ---
const vrmHeaders = { 'x-authorization': `Token ${VRM_TOKEN}` };

async function vrmFetch(endpoint) {
    const res = await fetch(`${VRM_BASE}${endpoint}`, { headers: vrmHeaders });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`VRM API ${res.status}: ${text}`);
    }
    return res.json();
}

// ============================================================
// InControl2 OAuth2 Token Management
// ============================================================
let ic2Token = null;
let ic2TokenExpiry = 0;
let ic2RefreshToken = null;

async function getIc2Token() {
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

async function ic2Fetch(endpoint, retryOn401 = true) {
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

// --- Caches ---
let sitesCache = null;
let sitesCacheTime = 0;
const SITES_CACHE_TTL = 5 * 60 * 1000;

// In-memory snapshot cache: siteId -> latest snapshot data
const snapshotCache = new Map();
let dbAvailable = false;

// Pepwave device cache: deviceName -> device data
const pepwaveCache = new Map();
let lastIc2Poll = 0;
let dbPool = null;

// GPS cache: siteId -> { latitude, longitude, updatedAt }
const gpsCache = new Map();
let initialClusteringDone = false;

// ============================================================
// Daily energy tracker: siteId -> { [dateStr]: { yield_wh, consumed_wh, site_name } }
// Keeps up to 14 days of data in memory
// ============================================================
const dailyEnergy = new Map();

function todayStr() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function updateDailyEnergy(siteId, siteName, yieldToday, consumedAh, voltage) {
    const date = todayStr();
    if (!dailyEnergy.has(siteId)) {
        dailyEnergy.set(siteId, {});
    }
    const siteData = dailyEnergy.get(siteId);

    const yieldWh = yieldToday !== null ? yieldToday * 1000 : null;
    const consumedWh = (consumedAh !== null && voltage !== null)
        ? Math.abs(consumedAh) * voltage
        : null;

    siteData[date] = {
        site_name: siteName,
        yield_wh: yieldWh,
        consumed_wh: consumedWh,
        updated: Date.now(),
    };

    // Prune entries older than 14 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (const d of Object.keys(siteData)) {
        if (d < cutoffStr) delete siteData[d];
    }
}

// ============================================================
// Alert logic: yield < consumed for 2+ consecutive days
// ============================================================
function computeAlerts() {
    const alerts = [];
    const today = todayStr();

    for (const [siteId, days] of dailyEnergy.entries()) {
        const dates = Object.keys(days)
            .filter(d => d < today)
            .sort()
            .reverse();

        let streak = 0;
        const siteName = Object.values(days)[0]?.site_name || `Site ${siteId}`;

        for (const date of dates) {
            const { yield_wh, consumed_wh } = days[date];
            if (yield_wh !== null && consumed_wh !== null && yield_wh < consumed_wh) {
                streak++;
            } else {
                break;
            }
        }

        if (streak >= 2) {
            const deficitDays = dates.slice(0, streak).map(d => ({
                date: d,
                yield_wh: days[d].yield_wh,
                consumed_wh: days[d].consumed_wh,
                deficit_wh: days[d].consumed_wh - days[d].yield_wh,
            }));

            alerts.push({
                site_id: siteId,
                site_name: siteName,
                streak_days: streak,
                deficit_days: deficitDays,
                severity: streak >= 5 ? 'critical' : streak >= 3 ? 'warning' : 'caution',
            });
        }
    }

    alerts.sort((a, b) => b.streak_days - a.streak_days);
    return alerts;
}

// ============================================================
// IC2 data extraction helpers
// ============================================================
function extractCellularInfo(device) {
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

function extractWanInterfaces(device) {
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

// --- API routes ---

app.get('/api/sites', async (req, res) => {
    try {
        if (!sitesCache || Date.now() - sitesCacheTime >= SITES_CACHE_TTL) {
            const data = await vrmFetch(`/users/${VRM_USER_ID}/installations`);
            sitesCache = data;
            sitesCacheTime = Date.now();
        }
        // Augment with IC2-only devices (those without VRM)
        const vrmNames = new Set((sitesCache.records || []).map(r => r.name));
        const ic2Only = [];
        for (const [name, dev] of pepwaveCache.entries()) {
            if (!vrmNames.has(name)) {
                ic2Only.push({
                    idSite: -dev.id,
                    name: name,
                    identifier: name,
                    ic2_only: true,
                });
            }
        }
        const augmented = {
            ...sitesCache,
            records: [...(sitesCache.records || []), ...ic2Only],
        };
        res.json(augmented);
    } catch (err) {
        console.error('Error fetching sites:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sites/:id/diagnostics', async (req, res) => {
    try {
        const data = await vrmFetch(`/installations/${req.params.id}/diagnostics?count=200`);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sites/:id/alarms', async (req, res) => {
    try {
        const data = await vrmFetch(`/installations/${req.params.id}/alarms?count=50`);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sites/:id/system', async (req, res) => {
    try {
        const data = await vrmFetch(`/installations/${req.params.id}/system-overview`);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sites/:id/stats', async (req, res) => {
    try {
        const { start, end } = req.query;
        const data = await vrmFetch(
            `/installations/${req.params.id}/stats?start=${start}&end=${end}&type=live_feed&attributeCodes[]=bs&attributeCodes[]=bv&attributeCodes[]=Pdc&attributeCodes[]=total_solar_yield`
        );
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/history/:id', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: true, records: [] });
        }
        const { start, end } = req.query;
        const rows = await getHistory(
            parseInt(req.params.id),
            parseInt(start) || 0,
            parseInt(end) || Date.now()
        );
        res.json({ success: true, records: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Latest snapshots
app.get('/api/fleet/latest', async (req, res) => {
    try {
        if (dbAvailable) {
            const rows = await getLatestSnapshots();
            if (rows.length > 0) {
                return res.json({ success: true, records: rows });
            }
        }
        const records = Array.from(snapshotCache.values());
        res.json({ success: true, records });
    } catch (err) {
        const records = Array.from(snapshotCache.values());
        res.json({ success: true, records });
    }
});

// Fleet energy
app.get('/api/fleet/energy', (req, res) => {
    const result = [];
    for (const [siteId, days] of dailyEnergy.entries()) {
        const siteName = Object.values(days)[0]?.site_name || `Site ${siteId}`;
        const dailyData = Object.entries(days)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, info]) => ({
                date,
                yield_wh: info.yield_wh,
                consumed_wh: info.consumed_wh,
            }));
        result.push({ site_id: siteId, site_name: siteName, days: dailyData });
    }
    result.sort((a, b) => a.site_name.localeCompare(b.site_name, undefined, { numeric: true }));
    res.json({ success: true, records: result });
});

// Fleet alerts
app.get('/api/fleet/alerts', (req, res) => {
    const alerts = computeAlerts();
    res.json({ success: true, alerts });
});

// ============================================================
// Fleet network: Pepwave device data
// ============================================================
app.get('/api/fleet/network', (req, res) => {
    const records = Array.from(pepwaveCache.values());
    records.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    res.json({
        success: true,
        records,
        last_poll: lastIc2Poll,
        device_count: records.length,
    });
});

// Debug: list all IC2 groups and device counts
app.get('/api/debug/ic2-groups', async (req, res) => {
    try {
        const groupsResult = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g`);
        const groups = groupsResult.data || [];
        const details = [];
        for (const g of groups) {
            const devResult = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g/${g.id}/d?has_status=true`);
            const devs = devResult.data || [];
            details.push({
                id: g.id,
                name: g.name,
                device_count: devs.length,
                device_names: devs.map(d => d.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
            });
        }
        res.json({ success: true, org: IC2_ORG_ID, current_group: IC2_GROUP_ID, groups: details });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/fleet/network/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const device = pepwaveCache.get(name);
    if (!device) {
        return res.status(404).json({ error: 'Device not found' });
    }
    res.json({ success: true, data: device });
});

// ============================================================
// Fleet combined: VRM snapshots + Pepwave data merged by name
// ============================================================
app.get('/api/fleet/combined', (req, res) => {
    // Build a pepwave lookup by device name
    const pepwaveMap = {};
    for (const [name, device] of pepwaveCache.entries()) {
        pepwaveMap[name] = {
            online: device.online,
            status: device.status,
            signal_bar: device.cellular?.signal_bar ?? null,
            rsrp: device.cellular?.signal?.rsrp ?? null,
            carrier: device.cellular?.carrier || null,
            technology: device.cellular?.technology || null,
            client_count: device.client_count || 0,
            usage_mb: device.usage_mb || 0,
            uptime: device.uptime || 0,
            model: device.model,
            wan_ip: device.wan_ip,
        };
    }
    res.json({ success: true, pepwave: pepwaveMap, last_poll: lastIc2Poll });
});

// Pepwave device history (time-series)
app.get('/api/fleet/network/:name/history', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: true, records: [] });
        }
        const name = decodeURIComponent(req.params.name);
        const { start, end } = req.query;
        const rows = await getPepwaveHistory(
            name,
            parseInt(start) || 0,
            parseInt(end) || Date.now()
        );
        res.json({ success: true, records: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Pepwave daily usage aggregation
app.get('/api/fleet/network/:name/daily', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: true, records: [] });
        }
        const name = decodeURIComponent(req.params.name);
        const days = parseInt(req.query.days) || 30;
        const rows = await getPepwaveDailyUsage(name, days);
        res.json({ success: true, records: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Settings
app.get('/api/settings', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({
                retention_days: 90,
                db_size_bytes: 0,
                snapshot_count: snapshotCache.size,
                db_status: 'disconnected',
            });
        }
        const stats = await getDbStats();
        res.json({
            retention_days: await getRetentionDays(),
            db_size_bytes: stats.size,
            snapshot_count: stats.count,
            db_status: 'connected',
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/settings', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: false, error: 'Database not connected' });
        }
        const { retention_days } = req.body;
        if (retention_days) {
            await setRetentionDays(parseInt(retention_days, 10));
        }
        res.json({ success: true, retention_days: await getRetentionDays() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/purge', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: false, error: 'Database not connected' });
        }
        await pruneOldData();
        const stats = await getDbStats();
        res.json({
            success: true,
            db_size_bytes: stats.size,
            snapshot_count: stats.count,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Job Sites API
// ============================================================

// GET all job sites with aggregated live metrics
app.get('/api/job-sites', async (req, res) => {
    try {
        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

        // Group assignments by job_site_id
        const assignmentsByJobSite = new Map();
        for (const a of assignments) {
            if (!assignmentsByJobSite.has(a.job_site_id)) {
                assignmentsByJobSite.set(a.job_site_id, []);
            }
            assignmentsByJobSite.get(a.job_site_id).push(a);
        }

        const result = jobSites.map(js => {
            const trailers = assignmentsByJobSite.get(js.id) || [];
            let totalSoc = 0, socCount = 0, minSoc = Infinity;
            let totalSolar = 0, trailersOnline = 0;
            let netOnline = 0, netTotal = 0;
            let worstStatus = 'healthy';

            for (const t of trailers) {
                const snap = snapshotCache.get(t.site_id);
                const pw = pepwaveCache.get(t.site_name);
                const isIc2Only = t.site_id < 0;

                if (isIc2Only) {
                    // IC2-only trailer — count as online if Pepwave is online
                    if (pw?.online) trailersOnline++;
                } else if (snap) {
                    trailersOnline++;
                    if (snap.battery_soc != null) {
                        totalSoc += snap.battery_soc;
                        socCount++;
                        if (snap.battery_soc < minSoc) minSoc = snap.battery_soc;
                        if (snap.battery_soc < 20) worstStatus = 'critical';
                        else if (snap.battery_soc < 50 && worstStatus !== 'critical') worstStatus = 'warning';
                    }
                    totalSolar += snap.solar_watts || 0;
                } else {
                    worstStatus = 'critical';
                }

                if (pw) {
                    netTotal++;
                    if (pw.online) netOnline++;
                }
            }

            return {
                ...js,
                trailer_count: trailers.length,
                trailers_online: trailersOnline,
                avg_soc: socCount > 0 ? +(totalSoc / socCount).toFixed(1) : null,
                min_soc: minSoc === Infinity ? null : +minSoc.toFixed(1),
                total_solar_watts: +totalSolar.toFixed(0),
                worst_status: trailers.length === 0 ? 'unknown' : worstStatus,
                net_online: netOnline,
                net_total: netTotal,
                trailers: trailers.map(t => {
                    const snap = snapshotCache.get(t.site_id);
                    const pw = pepwaveCache.get(t.site_name);
                    const isIc2Only = t.site_id < 0;
                    return {
                        site_id: t.site_id,
                        site_name: t.site_name,
                        battery_soc: snap?.battery_soc ?? null,
                        solar_watts: snap?.solar_watts ?? null,
                        solar_yield_today: snap?.solar_yield_today ?? null,
                        charge_state: snap?.charge_state ?? null,
                        online: isIc2Only ? (pw?.online ?? false) : !!snap,
                        ic2_only: isIc2Only,
                        network_online: pw?.online ?? false,
                    };
                }),
            };
        });

        res.json({ success: true, job_sites: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET single job site with full details
app.get('/api/job-sites/:id', async (req, res) => {
    try {
        const jobSite = await getJobSite(parseInt(req.params.id));
        if (!jobSite) return res.status(404).json({ success: false, error: 'Job site not found' });

        const trailers = await getTrailersByJobSite(jobSite.id);
        const enrichedTrailers = trailers.map(t => {
            const snap = snapshotCache.get(t.site_id);
            const pw = pepwaveCache.get(t.site_name);
            return {
                ...t,
                snapshot: snap || null,
                pepwave: pw || null,
            };
        });

        res.json({ success: true, job_site: { ...jobSite, trailers: enrichedTrailers } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT update job site (rename, address, status, notes)
app.put('/api/job-sites/:id', async (req, res) => {
    try {
        const updated = await updateJobSite(parseInt(req.params.id), req.body);
        if (!updated) return res.status(404).json({ success: false, error: 'Job site not found' });
        res.json({ success: true, job_site: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST manually assign a trailer to a job site
app.post('/api/job-sites/:id/assign', async (req, res) => {
    try {
        const { site_id } = req.body;
        if (!site_id) return res.status(400).json({ success: false, error: 'site_id required' });

        const result = await assignTrailerToJobSite(site_id, parseInt(req.params.id), true);
        if (!result) return res.status(404).json({ success: false, error: 'Trailer assignment not found' });
        res.json({ success: true, assignment: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST force reclustering
app.post('/api/job-sites/recluster', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: false, error: 'Database not connected' });
        }
        const threshold = parseInt(req.body?.threshold) || 200;
        const result = await runClustering(threshold);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET map data (lightweight for markers)
app.get('/api/map/sites', async (req, res) => {
    try {
        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

        const assignmentsByJobSite = new Map();
        for (const a of assignments) {
            if (!assignmentsByJobSite.has(a.job_site_id)) {
                assignmentsByJobSite.set(a.job_site_id, []);
            }
            assignmentsByJobSite.get(a.job_site_id).push(a);
        }

        const markers = jobSites
            .filter(js => js.latitude != null && js.longitude != null)
            .map(js => {
                const trailers = assignmentsByJobSite.get(js.id) || [];
                let worstStatus = 'healthy';
                let trailersOnline = 0;
                let totalSoc = 0, socCount = 0;

                for (const t of trailers) {
                    const snap = snapshotCache.get(t.site_id);
                    if (snap) {
                        trailersOnline++;
                        if (snap.battery_soc != null) {
                            totalSoc += snap.battery_soc;
                            socCount++;
                            if (snap.battery_soc < 20) worstStatus = 'critical';
                            else if (snap.battery_soc < 50 && worstStatus !== 'critical') worstStatus = 'warning';
                        }
                    } else {
                        worstStatus = 'critical';
                    }
                }

                return {
                    id: js.id,
                    name: js.name,
                    latitude: js.latitude,
                    longitude: js.longitude,
                    status: js.status,
                    trailer_count: trailers.length,
                    trailers_online: trailersOnline,
                    avg_soc: socCount > 0 ? +(totalSoc / socCount).toFixed(1) : null,
                    worst_status: trailers.length === 0 ? 'unknown' : worstStatus,
                };
            });

        res.json({ success: true, markers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Maintenance API
// ============================================================

app.get('/api/maintenance', async (req, res) => {
    try {
        const filters = {};
        if (req.query.job_site_id) filters.job_site_id = parseInt(req.query.job_site_id);
        if (req.query.site_id) filters.site_id = parseInt(req.query.site_id);
        if (req.query.status) filters.status = req.query.status;
        if (req.query.limit) filters.limit = parseInt(req.query.limit);
        const logs = await getMaintenanceLogs(filters);
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/maintenance/stats', async (req, res) => {
    try {
        const stats = await getMaintenanceStats();
        res.json({ success: true, stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/maintenance/costs-by-site', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const costs = await getMaintenanceCostsByJobSite(days);
        res.json({ success: true, costs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/maintenance/upcoming', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const logs = await getUpcomingMaintenance(days);
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/maintenance/:id', async (req, res) => {
    try {
        const log = await getMaintenanceLog(parseInt(req.params.id));
        if (!log) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/maintenance', async (req, res) => {
    try {
        const { visit_type, title } = req.body;
        if (!visit_type || !title) {
            return res.status(400).json({ success: false, error: 'visit_type and title are required' });
        }
        const log = await insertMaintenanceLog(req.body);
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/maintenance/:id', async (req, res) => {
    try {
        const log = await updateMaintenanceLog(parseInt(req.params.id), req.body);
        if (!log) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/maintenance/:id', async (req, res) => {
    try {
        const log = await deleteMaintenanceLog(parseInt(req.params.id));
        if (!log) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Trailer Components API
// ============================================================

app.get('/api/components/:siteId', async (req, res) => {
    try {
        const components = await getComponents(parseInt(req.params.siteId));
        res.json({ success: true, components });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/components', async (req, res) => {
    try {
        const { site_id, component_type } = req.body;
        if (!site_id || !component_type) {
            return res.status(400).json({ success: false, error: 'site_id and component_type are required' });
        }
        const component = await insertComponent(req.body);
        res.json({ success: true, component });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/components/:id', async (req, res) => {
    try {
        const component = await updateComponent(parseInt(req.params.id), req.body);
        if (!component) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, component });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Analytics API
// ============================================================

// Lazy daily metrics computation — call after VRM poll
let lastMetricsDate = null;
async function computeYesterdayMetrics() {
    if (!dbAvailable) return;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (lastMetricsDate === yesterday) return; // already computed today
    try {
        const count = await computeDailyMetrics(yesterday);
        if (count > 0) {
            lastMetricsDate = yesterday;
            console.log(`  ✓ Analytics: computed ${count} daily metrics for ${yesterday}`);
        }
    } catch (err) {
        console.error('  Analytics computation error:', err.message);
    }
}

app.get('/api/analytics/fleet-summary', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const daily = await getFleetAnalyticsSummary(days);
        const dateRange = await getAnalyticsDateRange();
        res.json({ success: true, daily, date_range: dateRange });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/analytics/rankings', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        const rankings = await getJobSiteRankings(days);
        res.json({ success: true, rankings });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/analytics/job-site/:id', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const data = await getAnalyticsByJobSite(parseInt(req.params.id), days);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/analytics/trailer/:id', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const data = await getAnalyticsByTrailer(parseInt(req.params.id), days);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Backfill: compute metrics for past N days
app.post('/api/analytics/backfill', async (req, res) => {
    try {
        const days = parseInt(req.body?.days) || 7;
        let totalRows = 0;
        for (let i = 1; i <= days; i++) {
            const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
            const count = await computeDailyMetrics(date);
            totalRows += count;
        }
        res.json({ success: true, days_processed: days, rows_computed: totalRows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Helper: extract values from diagnostics records ---
function extractDiagValue(records, code) {
    const match = records.find(r => r.code === code && r.Device !== 'Gateway');
    if (!match) return null;
    const val = match.rawValue;
    if (val === undefined || val === null || val === '') return null;
    const num = Number(val);
    return isNaN(num) ? val : num;
}

// --- Background polling: VRM ---
let isPolling = false;

async function pollAllSites() {
    if (isPolling) return;
    isPolling = true;
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] Polling VRM sites...`);

    try {
        if (!sitesCache) {
            const data = await vrmFetch(`/users/${VRM_USER_ID}/installations`);
            sitesCache = data;
            sitesCacheTime = Date.now();
        }

        const sites = sitesCache.records || [];
        let successCount = 0;
        let errorCount = 0;

        for (let i = 0; i < sites.length; i += 3) {
            const batch = sites.slice(i, i + 3);
            const promises = batch.map(async (site) => {
                try {
                    const diagRes = await vrmFetch(
                        `/installations/${site.idSite}/diagnostics?count=200`
                    );
                    const records = diagRes?.records || [];

                    const yieldToday = extractDiagValue(records, 'YT');
                    const yieldYesterday = extractDiagValue(records, 'YY');
                    const consumedAh = extractDiagValue(records, 'CE');
                    const batteryVoltage = extractDiagValue(records, 'V') ?? extractDiagValue(records, 'bv');

                    // Extract GPS coordinates
                    const latitude = extractDiagValue(records, 'lt') ?? site.latitude ?? null;
                    const longitude = extractDiagValue(records, 'lg') ?? site.longitude ?? null;

                    if (latitude != null && longitude != null) {
                        gpsCache.set(site.idSite, { latitude, longitude, updatedAt: Date.now() });
                    }

                    const snapshot = {
                        site_id: site.idSite,
                        site_name: site.name,
                        timestamp: Date.now(),
                        battery_soc: extractDiagValue(records, 'SOC') ?? extractDiagValue(records, 'bs'),
                        battery_voltage: batteryVoltage,
                        battery_current: extractDiagValue(records, 'I') ?? extractDiagValue(records, 'bc'),
                        battery_temp: extractDiagValue(records, 'BT') ?? extractDiagValue(records, 'bT'),
                        battery_power: extractDiagValue(records, 'P') ?? extractDiagValue(records, 'Pdc'),
                        solar_watts: extractDiagValue(records, 'ScW') ?? extractDiagValue(records, 'Pdc'),
                        solar_yield_today: yieldToday,
                        solar_yield_yesterday: yieldYesterday,
                        charge_state: extractDiagValue(records, 'ScS'),
                        consumed_ah: consumedAh,
                    };

                    snapshotCache.set(site.idSite, snapshot);
                    updateDailyEnergy(site.idSite, site.name, yieldToday, consumedAh, batteryVoltage);

                    if (yieldYesterday !== null) {
                        const yesterday = new Date();
                        yesterday.setDate(yesterday.getDate() - 1);
                        const yestStr = yesterday.toISOString().slice(0, 10);
                        if (!dailyEnergy.has(site.idSite)) dailyEnergy.set(site.idSite, {});
                        const siteData = dailyEnergy.get(site.idSite);
                        if (!siteData[yestStr]) {
                            siteData[yestStr] = {
                                site_name: site.name,
                                yield_wh: yieldYesterday * 1000,
                                consumed_wh: null,
                                updated: Date.now(),
                            };
                        }
                    }

                    if (dbAvailable) {
                        try {
                            await insertSnapshot({ ...snapshot, raw_battery: null, raw_solar: null });
                        } catch (dbErr) { /* in memory */ }
                        // Persist GPS + trailer assignment
                        try {
                            await upsertTrailerAssignment(site.idSite, site.name, latitude, longitude);
                        } catch (dbErr) { /* non-critical */ }
                    }

                    successCount++;
                } catch (err) {
                    errorCount++;
                    console.error(`  Error polling site ${site.name}: ${err.message}`);
                }
            });
            await Promise.all(promises);
            if (i + 3 < sites.length) {
                await new Promise(r => setTimeout(r, 1200));
            }
        }

        if (dbAvailable) {
            try { await pruneOldData(); } catch (e) { /* ignore */ }
        }

        const alertCount = computeAlerts().length;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  VRM poll complete: ${successCount} ok, ${errorCount} errors in ${elapsed}s (cache: ${snapshotCache.size} sites, energy alerts: ${alertCount})`);

        // Auto-generate embeddings for new data (async, don't block)
        if (dbAvailable && isEmbeddingsConfigured() && snapshotCache.size > 0) {
            generateEmbeddingsAsync().catch(err =>
                console.error('  Background embedding generation failed:', err.message)
            );
        }

        // Run GPS clustering on first poll (async, don't block)
        if (dbAvailable && !initialClusteringDone && gpsCache.size > 0) {
            initialClusteringDone = true;
            runClustering().catch(err =>
                console.error('  Initial clustering failed:', err.message)
            );
        }

        // Lazy analytics: compute yesterday's daily metrics
        computeYesterdayMetrics();
    } catch (err) {
        console.error('  VRM poll error:', err.message);
    } finally {
        isPolling = false;
    }
}

// --- Background polling: InControl2 ---
let isPollingIc2 = false;

async function pollIc2Devices() {
    if (isPollingIc2 || !IC2_CLIENT_ID || !IC2_CLIENT_SECRET) return;
    isPollingIc2 = true;
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] Polling InControl2 devices...`);

    try {
        // Fetch devices from ALL groups in the organization
        const groupsResult = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g`);
        const groups = groupsResult.data || [];
        let devices = [];
        for (const g of groups) {
            try {
                const result = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g/${g.id}/d?has_status=true`);
                const groupDevices = (result.data || []).map(d => ({ ...d, _groupId: g.id }));
                devices.push(...groupDevices);
            } catch (e) {
                console.log(`  IC2: failed to fetch group ${g.id} (${g.name}): ${e.message}`);
            }
        }

        let onlineCount = 0;
        let offlineCount = 0;

        for (const dev of devices) {
            const cellular = extractCellularInfo(dev);
            const wanInterfaces = extractWanInterfaces(dev);

            const record = {
                id: dev.id,
                name: dev.name,
                sn: dev.sn,
                status: dev.status,
                online: dev.status === 'online',
                model: dev.product_name || dev.model || 'Unknown',
                firmware: dev.fw_ver || 'Unknown',
                client_count: dev.client_count || 0,
                uptime: dev.uptime || 0,
                usage_mb: dev.usage || 0,
                tx_mb: dev.tx || 0,
                rx_mb: dev.rx || 0,
                wan_ip: dev.wtp_ip || cellular?.ip || null,
                last_online: dev.last_online || null,
                tags: dev.tags || [],
                gps_support: dev.gps_support || false,
                gps_exist: dev.gps_exist || false,
                latitude: dev.latitude || null,
                longitude: dev.longitude || null,
                address: dev.address || null,
                cellular,
                wan_interfaces: wanInterfaces,
                timestamp: Date.now(),
            };

            pepwaveCache.set(dev.name, record);

            // Persist to PostgreSQL for historical tracking
            if (dbAvailable) {
                try {
                    await insertPepwaveSnapshot({
                        device_name: dev.name,
                        timestamp: record.timestamp,
                        online: record.online,
                        signal_bar: cellular?.signal_bar ?? null,
                        rsrp: cellular?.signal?.rsrp ?? null,
                        rsrq: cellular?.signal?.rsrq ?? null,
                        rssi: cellular?.signal?.rssi ?? null,
                        sinr: cellular?.signal?.sinr ?? null,
                        carrier: cellular?.carrier || null,
                        technology: cellular?.technology || null,
                        usage_mb: record.usage_mb,
                        tx_mb: record.tx_mb,
                        rx_mb: record.rx_mb,
                        client_count: record.client_count,
                        uptime: record.uptime,
                        wan_ip: record.wan_ip,
                    });
                } catch (dbErr) { /* continue - in-memory still works */ }
            }

            if (dev.status === 'online') onlineCount++;
            else offlineCount++;
        }

        // Fetch GPS locations from per-device /loc endpoint for devices with gps_exist
        if (sitesCache) {
            const vrmSites = sitesCache.records || [];
            const gpsDevices = devices.filter(d => d.gps_exist || d.gps_support);
            let gpsMatched = 0;

            // Batch in groups of 5 to avoid rate limits
            for (let i = 0; i < gpsDevices.length; i += 5) {
                const batch = gpsDevices.slice(i, i + 5);
                const locPromises = batch.map(async (dev) => {
                    try {
                        const gId = dev._groupId || IC2_GROUP_ID;
                        const locData = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g/${gId}/d/${dev.id}/loc`);
                        const loc = (locData.data || [])[0];
                        if (loc && loc.la && loc.lo) {
                            // Update pepwaveCache with GPS
                            const cached = pepwaveCache.get(dev.name);
                            if (cached) {
                                cached.latitude = loc.la;
                                cached.longitude = loc.lo;
                            }
                            // Match to VRM trailer by name
                            const vrmSite = vrmSites.find(s => s.name === dev.name);
                            if (vrmSite) {
                                gpsCache.set(vrmSite.idSite, { latitude: loc.la, longitude: loc.lo, updatedAt: Date.now() });
                                gpsMatched++;
                                if (dbAvailable) {
                                    try {
                                        await upsertTrailerAssignment(vrmSite.idSite, vrmSite.name, loc.la, loc.lo);
                                    } catch (e) { /* non-critical */ }
                                }
                            } else if (dbAvailable) {
                                // IC2-only device (no VRM match) — use negative IC2 device ID
                                const syntheticId = -dev.id;
                                gpsCache.set(syntheticId, { latitude: loc.la, longitude: loc.lo, updatedAt: Date.now() });
                                try {
                                    await upsertTrailerAssignment(syntheticId, dev.name, loc.la, loc.lo);
                                } catch (e) { /* non-critical */ }
                            }
                        }
                    } catch (e) { /* skip device on error */ }
                });
                await Promise.all(locPromises);
                if (i + 5 < gpsDevices.length) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            if (gpsMatched > 0) {
                console.log(`  IC2 GPS: fetched locations for ${gpsMatched} VRM-matched devices`);
            }
        }

        // Ensure IC2-only devices without GPS also get trailer_assignments
        if (dbAvailable && sitesCache) {
            const vrmSites = sitesCache.records || [];
            for (const dev of devices) {
                const vrmSite = vrmSites.find(s => s.name === dev.name);
                if (!vrmSite) {
                    const syntheticId = -dev.id;
                    // Only insert if not already covered by GPS section above
                    if (!gpsCache.has(syntheticId)) {
                        try {
                            await upsertTrailerAssignment(syntheticId, dev.name, null, null);
                        } catch (e) { /* non-critical */ }
                    }
                }
            }
        }

        // Run clustering if we have GPS data and haven't clustered yet
        if (dbAvailable && !initialClusteringDone && gpsCache.size > 0) {
            initialClusteringDone = true;
            runClustering().catch(err =>
                console.error('  IC2-triggered clustering failed:', err.message)
            );
        }

        lastIc2Poll = Date.now();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  IC2 poll complete: ${devices.length} devices (${onlineCount} online, ${offlineCount} offline) in ${elapsed}s`);
    } catch (err) {
        console.error('  IC2 poll error:', err.message);
    } finally {
        isPollingIc2 = false;
    }
}

// ============================================================
// Background Embedding Generation
// ============================================================
async function generateEmbeddingsAsync() {
    if (!isEmbeddingsConfigured() || !dbAvailable) return;

    try {
        // Get current sites from snapshot cache
        const sites = Array.from(snapshotCache.values()).filter(s => s.site_name);
        if (sites.length > 0) {
            const siteEmbeddings = await embedSiteSnapshots(sites);
            for (const emb of siteEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
        }

        // Get current devices from pepwave cache
        const devices = Array.from(pepwaveCache.values()).filter(d => d.name);
        if (devices.length > 0) {
            const deviceEmbeddings = await embedPepwaveDevices(devices);
            for (const emb of deviceEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
        }

        // Embed current alerts
        const alerts = computeAlerts();
        if (alerts.length > 0) {
            const alertEmbeddings = await embedAlerts(alerts);
            for (const emb of alertEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
        }

        console.log(`  Background embeddings updated: ${sites.length} sites, ${devices.length} devices, ${alerts.length} alerts`);
    } catch (err) {
        console.error('  Background embedding error:', err.message);
    }
}

// ============================================================
// Natural Language Query (Claude-powered)
// ============================================================
const FLEET_SCHEMA = `
You are a fleet data assistant for a solar-powered trailer monitoring system.
The system tracks ~63 trailers across ~15 construction job sites (1-6 trailers per site).
"Site" = construction job site. "Trailer" = individual VRM solar installation.

Database tables:

1. site_snapshots — VRM power data (one row per trailer per 5-min poll)
   Columns: id SERIAL, site_id INTEGER, site_name TEXT, timestamp BIGINT (ms),
   battery_soc REAL (0-100%), battery_voltage REAL (V), battery_current REAL (A),
   battery_temp REAL (°C), battery_power REAL (W), solar_watts REAL (W),
   solar_yield_today REAL (kWh), solar_yield_yesterday REAL (kWh), charge_state TEXT

2. pepwave_snapshots — Pepwave network data (one row per device per 5-min poll)
   Columns: id SERIAL, device_name TEXT, timestamp BIGINT (ms),
   online BOOLEAN, signal_bar INTEGER (0-5), rsrp REAL (dBm, good > -90, fair > -105, poor < -105),
   rsrq REAL (dB), rssi REAL (dBm), sinr REAL (dB, higher=better),
   carrier TEXT, technology TEXT (LTE/5G/etc), usage_mb REAL (cumulative MB),
   tx_mb REAL, rx_mb REAL, client_count INTEGER, uptime INTEGER (seconds), wan_ip TEXT

3. job_sites — Construction locations (one row per physical location)
   Columns: id SERIAL, name TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
   address TEXT, status TEXT ('active'|'standby'|'completed'), notes TEXT,
   created_at BIGINT (ms), updated_at BIGINT (ms)

4. trailer_assignments — Links trailers to job sites
   Columns: id SERIAL, site_id INTEGER (VRM idSite, UNIQUE), site_name TEXT,
   job_site_id INTEGER REFERENCES job_sites(id), latitude DOUBLE PRECISION,
   longitude DOUBLE PRECISION, manual_override BOOLEAN, assigned_at BIGINT (ms)

5. maintenance_logs — Service/repair tracking
   Columns: id SERIAL, job_site_id INTEGER REFERENCES job_sites(id), site_id INTEGER (trailer, nullable),
   visit_type TEXT ('inspection'|'repair'|'scheduled'|'emergency'|'installation'|'decommission'),
   status TEXT ('scheduled'|'in_progress'|'completed'|'cancelled'),
   title TEXT, description TEXT, technician TEXT,
   scheduled_date BIGINT (ms), completed_date BIGINT (ms),
   labor_hours REAL, labor_cost_cents INTEGER, parts_cost_cents INTEGER,
   parts_used JSONB, created_at BIGINT (ms), updated_at BIGINT (ms)

6. analytics_daily_metrics — Pre-computed daily aggregates per trailer
   Columns: id SERIAL, date DATE, site_id INTEGER, avg_soc REAL, min_soc REAL, max_soc REAL,
   solar_yield_kwh REAL, avg_voltage REAL, avg_signal_bar REAL, data_usage_mb REAL,
   uptime_percent REAL, created_at BIGINT (ms). UNIQUE(site_id, date)

IMPORTANT:
- site_snapshots.site_name matches pepwave_snapshots.device_name (they share trailer names)
- trailer_assignments.site_id matches site_snapshots.site_id
- trailer_assignments.site_name matches pepwave_snapshots.device_name
- To find trailers at a job site: JOIN trailer_assignments ta ON ta.job_site_id = job_sites.id
- Timestamps are epoch milliseconds. Use to_timestamp(timestamp/1000) for date ops.
- Costs in maintenance_logs are in cents (divide by 100 for dollars).
- Always LIMIT results to 50 rows max.
- Only generate SELECT queries. Never INSERT, UPDATE, DELETE, DROP, ALTER, or any DDL/DML.
- For "latest" queries, use DISTINCT ON or subqueries with MAX(timestamp).
- For daily aggregations, group by DATE(to_timestamp(timestamp/1000)).
- PostgreSQL REAL columns: cast to numeric for round(): round(column::numeric, 2)

Examples:
- "trailers at Downtown site" → JOIN trailer_assignments + job_sites WHERE js.name ILIKE '%downtown%'
- "which sites have most maintenance costs" → SUM(labor_cost_cents + parts_cost_cents) from maintenance_logs GROUP BY job_site_id
- "low battery trailers" → DISTINCT ON site_snapshots for latest where battery_soc < 30
- "site rankings by SOC" → analytics_daily_metrics AVG(avg_soc) GROUP BY site_id, JOIN job_sites
- "data usage this week" → aggregate pepwave_snapshots usage_mb grouped by device_name
`;

app.post('/api/query', async (req, res) => {
    if (!anthropic) {
        return res.status(501).json({ error: 'Claude API key not configured' });
    }

    const { question } = req.body;
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
        return res.status(400).json({ error: 'Question is required' });
    }

    try {
        // Build real-time context from in-memory caches
        const deviceSummary = [];
        for (const [name, device] of pepwaveCache.entries()) {
            deviceSummary.push(`${name}: ${device.online ? 'online' : 'offline'}, signal=${device.cellular?.signal_bar ?? '?'}/5, rsrp=${device.cellular?.signal?.rsrp ?? '?'}dBm, clients=${device.client_count}, usage=${device.usage_mb}MB`);
        }
        const snapshotSummary = [];
        for (const [siteId, snap] of snapshotCache.entries()) {
            snapshotSummary.push(`${snap.site_name || 'Site ' + siteId}: SOC=${snap.battery_soc}%, ${snap.battery_voltage}V, solar=${snap.solar_watts}W, charge=${snap.charge_state}`);
        }

        const liveContext = `\nCurrent live data (${new Date().toISOString()}):\n` +
            `Pepwave devices (${deviceSummary.length} total):\n${deviceSummary.slice(0, 20).join('\n')}${deviceSummary.length > 20 ? '\n...(truncated)' : ''}\n\n` +
            `VRM sites (${snapshotSummary.length} total):\n${snapshotSummary.slice(0, 20).join('\n')}${snapshotSummary.length > 20 ? '\n...(truncated)' : ''}`;

        const systemPrompt = FLEET_SCHEMA + liveContext + `\n\nRespond in this JSON format:\n{\n  "answer": "<human-readable answer to the question>",\n  "sql": "<optional SQL query if database lookup would help, or null>",\n  "data": null\n}\n\nIf you can answer from the live context alone, set sql to null and answer directly.\nIf a SQL query would give better/more complete data, include it. The system will execute it and ask you to refine the answer.\nAlways respond with valid JSON only, no markdown fences.`;

        const msg = await anthropic.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 1500,
            messages: [{ role: 'user', content: question }],
            system: systemPrompt,
        });

        let parsed;
        try {
            let text = msg.content[0].text;
            // Strip markdown code blocks if present
            const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (codeBlockMatch) {
                text = codeBlockMatch[1];
            }
            parsed = JSON.parse(text);
        } catch {
            // If Claude didn't return valid JSON, wrap the text as an answer
            parsed = { answer: msg.content[0].text, sql: null, data: null };
        }

        // If Claude generated a SQL query and DB is available, execute it
        if (parsed.sql && dbAvailable) {
            const sqlLower = parsed.sql.toLowerCase().trim();
            // Safety: only allow SELECT (including CTEs starting with WITH)
            if (!sqlLower.startsWith('select') && !sqlLower.startsWith('with')) {
                parsed.answer += '\n⚠️ Query was blocked for safety (non-SELECT detected).';
                parsed.sql = null;
            } else if (dbPool) {
                try {
                    const result = await dbPool.query(parsed.sql);
                    parsed.data = result.rows.slice(0, 50);

                    // Ask Claude to refine the answer with the actual data
                    const refinement = await anthropic.messages.create({
                        model: 'claude-sonnet-4-5-20250929',
                        max_tokens: 1000,
                        messages: [{
                            role: 'user',
                            content: `Original question: "${question}"\n\nSQL query returned ${result.rows.length} rows:\n${JSON.stringify(result.rows.slice(0, 20), null, 2)}\n\nProvide a clear, concise answer summarizing these results. Format as plain text, use bullet points if listing items. Keep it brief.`
                        }],
                        system: 'You are a fleet data assistant. Provide clear, concise answers about trailer fleet data. Use bullet points for lists. Include numbers and specifics. Keep answers under 200 words.',
                    });
                    parsed.answer = refinement.content[0].text;
                } catch (dbErr) {
                    parsed.answer += `\n⚠️ SQL execution failed: ${dbErr.message}`;
                    parsed.data = null;
                }
            }
        }

        res.json({
            success: true,
            question,
            answer: parsed.answer,
            sql: parsed.sql,
            data: parsed.data,
        });
    } catch (err) {
        console.error('Query error:', err.message);
        res.status(500).json({ error: `Query failed: ${err.message}` });
    }
});

// ============================================================
// Semantic Search Endpoint
// ============================================================
app.post('/api/search/semantic', async (req, res) => {
    if (!isEmbeddingsConfigured()) {
        return res.status(501).json({ error: 'Voyage API key not configured' });
    }

    if (!dbAvailable) {
        return res.status(503).json({ error: 'Database not available' });
    }

    const { query, contentTypes, limit } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ error: 'Query is required' });
    }

    try {
        // Generate embedding for the search query
        const queryEmbedding = await generateQueryEmbedding(query);

        // Perform vector similarity search
        const results = await semanticSearch(
            queryEmbedding,
            contentTypes || null,
            limit || 20
        );

        // Use Claude to synthesize results into a natural answer
        let answer = '';
        if (anthropic && results.length > 0) {
            try {
                const resultsContext = results.slice(0, 10).map((r, i) =>
                    `${i + 1}. [${r.content_type}] ${r.content_text} (similarity: ${(r.similarity * 100).toFixed(1)}%)`
                ).join('\n');

                const msg = await anthropic.messages.create({
                    model: 'claude-sonnet-4-5-20250929',
                    max_tokens: 800,
                    messages: [{
                        role: 'user',
                        content: `User query: "${query}"\n\nMost relevant fleet data:\n${resultsContext}\n\nProvide a clear, concise answer based on these search results. Use bullet points if listing items. Keep it under 150 words.`
                    }],
                    system: 'You are a fleet data assistant. Provide clear answers about trailer fleet data based on semantic search results.',
                });
                answer = msg.content[0].text;
            } catch (claudeErr) {
                console.error('Claude synthesis failed:', claudeErr.message);
                // Fall back to raw results
                answer = `Found ${results.length} relevant results for "${query}".`;
            }
        } else {
            answer = results.length > 0
                ? `Found ${results.length} relevant results for "${query}".`
                : `No results found for "${query}".`;
        }

        res.json({
            success: true,
            query,
            answer,
            results: results.map(r => ({
                type: r.content_type,
                id: r.content_id,
                text: r.content_text,
                similarity: r.similarity,
                metadata: r.metadata,
            })),
            count: results.length,
        });
    } catch (err) {
        console.error('Semantic search error:', err.message);
        res.status(500).json({ error: `Search failed: ${err.message}` });
    }
});

// ============================================================
// Embeddings Management Endpoints
// ============================================================

// Get embedding stats
app.get('/api/embeddings/stats', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: true, stats: [] });
        }
        const stats = await getEmbeddingStats();
        res.json({ success: true, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate embeddings for all current data
app.post('/api/embeddings/generate', async (req, res) => {
    if (!isEmbeddingsConfigured()) {
        return res.status(501).json({ error: 'Voyage API key not configured' });
    }

    if (!dbAvailable) {
        return res.status(503).json({ error: 'Database not available' });
    }

    try {
        const data = await getAllContentForEmbedding();
        let siteCount = 0;
        let deviceCount = 0;

        // Embed sites
        if (data.sites.length > 0) {
            const siteEmbeddings = await embedSiteSnapshots(data.sites);
            for (const emb of siteEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
            siteCount = data.sites.length;
        }

        // Embed devices
        if (data.devices.length > 0) {
            const deviceEmbeddings = await embedPepwaveDevices(data.devices);
            for (const emb of deviceEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
            deviceCount = data.devices.length;
        }

        // Embed current alerts
        const alerts = computeAlerts();
        if (alerts.length > 0) {
            const alertEmbeddings = await embedAlerts(alerts);
            for (const emb of alertEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
        }

        res.json({
            success: true,
            sites_embedded: siteCount,
            devices_embedded: deviceCount,
            alerts_embedded: alerts.length,
        });
    } catch (err) {
        console.error('Embedding generation error:', err.message);
        res.status(500).json({ error: `Failed to generate embeddings: ${err.message}` });
    }
});

// --- SPA fallback ---
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(distPath, 'index.html'));
    }
});

// --- Start ---
async function start() {
    try {
        dbPool = await initDb();
        dbAvailable = true;
        console.log('PostgreSQL database connected');
    } catch (err) {
        dbAvailable = false;
        console.warn('PostgreSQL not available — using in-memory cache only');
        console.warn('Set DATABASE_URL to enable persistent history');
        console.error('Database connection error:', err.message);
    }

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });

    // Initial VRM poll after 3 seconds
    setTimeout(pollAllSites, 3000);
    setInterval(pollAllSites, 5 * 60 * 1000);

    // Initial IC2 poll after 5 seconds (stagger from VRM)
    if (IC2_CLIENT_ID && IC2_CLIENT_SECRET) {
        setTimeout(pollIc2Devices, 5000);
        setInterval(pollIc2Devices, 5 * 60 * 1000);
        console.log('InControl2 polling enabled');
    } else {
        console.warn('IC2_CLIENT_ID / IC2_CLIENT_SECRET not set — Pepwave polling disabled');
    }
}

start().catch(console.error);
