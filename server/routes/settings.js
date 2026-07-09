import { SOLAR_SCORE_DEFAULTS } from '../config.js';
import { getDbStats, getRetentionDays, pruneOldData, setRetentionDays, setSetting } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { dbAvailable, snapshotCache, solarScoreConfig } from '../state.js';

export function registerSettingsRoutes(app) {

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
            solar_score_config: { ...solarScoreConfig },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/settings/solar-score', requireRole('admin'), async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: false, error: 'Database not connected' });
        }
        const validKeys = Object.keys(SOLAR_SCORE_DEFAULTS);
        const updates = {};
        for (const key of validKeys) {
            if (req.body[key] !== undefined) {
                const val = parseFloat(req.body[key]);
                if (isNaN(val) || val < 0 || val > 100) {
                    return res.status(400).json({ error: `Invalid value for ${key}: must be 0-100` });
                }
                updates[key] = val;
            }
        }
        for (const [key, val] of Object.entries(updates)) {
            await setSetting(`solar_${key}`, val);
            solarScoreConfig[key] = val;
        }
        res.json({ success: true, solar_score_config: { ...solarScoreConfig } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/settings', requireRole('admin'), async (req, res) => {
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

app.post('/api/settings/purge', requireRole('admin'), async (req, res) => {
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

}
