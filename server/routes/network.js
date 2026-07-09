import { getPepwaveDailyUsage, getPepwaveHistory } from '../db.js';
import { dbAvailable, lastIc2Poll, offlineTimestamps, pepwaveCache } from '../state.js';

export function registerNetworkRoutes(app) {

// ============================================================
// Fleet network: Pepwave device data
// ============================================================
app.get('/api/fleet/network', (req, res) => {
    const records = Array.from(pepwaveCache.values()).map(r => ({
        ...r,
        offline_since: offlineTimestamps.get(r.name) || null,
    }));
    records.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    res.json({
        success: true,
        records,
        last_poll: lastIc2Poll,
        device_count: records.length,
    });
});

// Debug: check bandwidth data source for a specific device
app.get('/api/debug/bandwidth', (req, res) => {
    const sample = Array.from(pepwaveCache.values()).slice(0, 3).map(r => ({
        name: r.name, id: r.id, usage_mb: r.usage_mb, tx_mb: r.tx_mb, rx_mb: r.rx_mb,
    }));
    res.json({ sample, cache_size: pepwaveCache.size });
});

app.get('/api/fleet/network/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const device = pepwaveCache.get(name);
    if (!device) {
        return res.status(404).json({ error: 'Device not found' });
    }
    res.json({ success: true, data: device });
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

}
