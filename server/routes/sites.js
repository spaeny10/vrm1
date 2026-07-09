import { SITES_CACHE_TTL, VRM_USER_ID } from '../config.js';
import { getHistory } from '../db.js';
import { vrmFetch } from '../services/vrmClient.js';
import { dbAvailable, pepwaveCache, setSitesCache, sitesCache, sitesCacheTime } from '../state.js';

export function registerSitesRoutes(app) {

app.get('/api/sites', async (req, res) => {
    try {
        if (!sitesCache || Date.now() - sitesCacheTime >= SITES_CACHE_TTL) {
            const data = await vrmFetch(`/users/${VRM_USER_ID}/installations`);
            setSitesCache(data);
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

}
