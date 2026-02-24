import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    initDb, insertSnapshot, getHistory, getLatestSnapshots,
    getRetentionDays, setRetentionDays, pruneOldData, getDbStats
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const VRM_TOKEN = process.env.VRM_API_TOKEN;
const VRM_USER_ID = process.env.VRM_USER_ID;
const VRM_BASE = 'https://vrmapi.victronenergy.com/v2';

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

// --- Caches ---
let sitesCache = null;
let sitesCacheTime = 0;
const SITES_CACHE_TTL = 5 * 60 * 1000;

// In-memory snapshot cache: siteId -> latest snapshot data
const snapshotCache = new Map();
let dbAvailable = false;

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

    // Yield today comes in kWh from VRM — convert to Wh
    const yieldWh = yieldToday !== null ? yieldToday * 1000 : null;

    // Consumed Wh = consumed Ah × battery voltage
    // CE from BMV is cumulative since last full charge, not a daily reset
    // We use it as a running proxy
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
        // Get sorted dates (excluding today since it's still in progress)
        const dates = Object.keys(days)
            .filter(d => d < today)
            .sort()
            .reverse(); // most recent first

        let streak = 0;
        const siteName = Object.values(days)[0]?.site_name || `Site ${siteId}`;

        for (const date of dates) {
            const { yield_wh, consumed_wh } = days[date];
            if (yield_wh !== null && consumed_wh !== null && yield_wh < consumed_wh) {
                streak++;
            } else {
                break; // streak broken
            }
        }

        if (streak >= 2) {
            // Get the deficit details
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

    // Sort by severity (longest streak first)
    alerts.sort((a, b) => b.streak_days - a.streak_days);
    return alerts;
}

// --- API routes ---

app.get('/api/sites', async (req, res) => {
    try {
        if (sitesCache && Date.now() - sitesCacheTime < SITES_CACHE_TTL) {
            return res.json(sitesCache);
        }
        const data = await vrmFetch(`/users/${VRM_USER_ID}/installations`);
        sitesCache = data;
        sitesCacheTime = Date.now();
        res.json(data);
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

// Latest snapshots — uses DB if available, otherwise in-memory cache
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

// ============================================================
// Fleet energy: daily yield vs consumed for all sites
// ============================================================
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

        result.push({
            site_id: siteId,
            site_name: siteName,
            days: dailyData,
        });
    }
    // Sort by site name
    result.sort((a, b) => a.site_name.localeCompare(b.site_name, undefined, { numeric: true }));
    res.json({ success: true, records: result });
});

// Fleet alerts: sites with yield < consumed for 2+ consecutive days
app.get('/api/fleet/alerts', (req, res) => {
    const alerts = computeAlerts();
    res.json({ success: true, alerts });
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

// --- Helper: extract values from diagnostics records ---
function extractDiagValue(records, code) {
    const match = records.find(r => r.code === code && r.Device !== 'Gateway');
    if (!match) return null;
    const val = match.rawValue;
    if (val === undefined || val === null || val === '') return null;
    const num = Number(val);
    return isNaN(num) ? val : num;
}

// --- Background polling ---
let isPolling = false;

async function pollAllSites() {
    if (isPolling) return;
    isPolling = true;
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] Polling all sites...`);

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

                    // Update in-memory snapshot cache
                    snapshotCache.set(site.idSite, snapshot);

                    // Update daily energy tracker
                    updateDailyEnergy(site.idSite, site.name, yieldToday, consumedAh, batteryVoltage);

                    // Also seed yesterday's yield if we have it
                    if (yieldYesterday !== null) {
                        const yesterday = new Date();
                        yesterday.setDate(yesterday.getDate() - 1);
                        const yestStr = yesterday.toISOString().slice(0, 10);
                        if (!dailyEnergy.has(site.idSite)) {
                            dailyEnergy.set(site.idSite, {});
                        }
                        const siteData = dailyEnergy.get(site.idSite);
                        if (!siteData[yestStr]) {
                            siteData[yestStr] = {
                                site_name: site.name,
                                yield_wh: yieldYesterday * 1000,
                                consumed_wh: null, // we don't have yesterday's consumption
                                updated: Date.now(),
                            };
                        }
                    }

                    // Persist to DB if available
                    if (dbAvailable) {
                        try {
                            await insertSnapshot({ ...snapshot, raw_battery: null, raw_solar: null });
                        } catch (dbErr) { /* data is in memory cache */ }
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
        console.log(`  Poll complete: ${successCount} ok, ${errorCount} errors in ${elapsed}s (cache: ${snapshotCache.size} sites, energy alerts: ${alertCount})`);
    } catch (err) {
        console.error('  Poll error:', err.message);
    } finally {
        isPolling = false;
    }
}

// --- SPA fallback ---
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(distPath, 'index.html'));
    }
});

// --- Start ---
async function start() {
    try {
        await initDb();
        dbAvailable = true;
        console.log('PostgreSQL database connected');
    } catch (err) {
        dbAvailable = false;
        console.warn('PostgreSQL not available — using in-memory cache only');
        console.warn('Set DATABASE_URL to enable persistent history');
    }

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });

    // Initial poll after 3 seconds
    setTimeout(pollAllSites, 3000);
    // Then poll every 5 minutes
    setInterval(pollAllSites, 5 * 60 * 1000);
}

start().catch(console.error);
