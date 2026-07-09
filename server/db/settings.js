import { pool } from './core.js';

export async function getRetentionDays() {
    if (!pool) return 90;
    const result = await pool.query("SELECT value FROM settings WHERE key='retention_days'");
    if (result.rows.length === 0) return 90;
    return parseInt(result.rows[0].value, 10);
}

export async function setRetentionDays(days) {
    if (!pool) return;
    await pool.query(
        "INSERT INTO settings (key, value) VALUES ('retention_days', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
        [String(days)]
    );
}

export async function getSetting(key, defaultValue = null) {
    if (!pool) return defaultValue;
    const result = await pool.query("SELECT value FROM settings WHERE key=$1", [key]);
    if (result.rows.length === 0) return defaultValue;
    return result.rows[0].value;
}

export async function setSetting(key, value) {
    if (!pool) return;
    await pool.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
        [key, String(value)]
    );
}

export async function pruneOldData() {
    if (!pool) return;
    const days = await getRetentionDays();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    await pool.query("DELETE FROM site_snapshots WHERE timestamp < $1", [cutoff]);
    await pool.query("DELETE FROM pepwave_snapshots WHERE timestamp < $1", [cutoff]);
}

export async function getDbStats() {
    if (!pool) return { size: 0, count: 0, pepwave_count: 0 };
    const countResult = await pool.query("SELECT COUNT(*) as count FROM site_snapshots");
    const pepwaveCountResult = await pool.query("SELECT COUNT(*) as count FROM pepwave_snapshots");
    let sizeBytes = 0;
    try {
        const sizeResult = await pool.query(
            "SELECT pg_total_relation_size('site_snapshots') + pg_total_relation_size('pepwave_snapshots') as size"
        );
        sizeBytes = parseInt(sizeResult.rows[0].size, 10);
    } catch {
        // May not have permissions for pg_total_relation_size
    }
    return {
        size: sizeBytes,
        count: parseInt(countResult.rows[0].count, 10),
        pepwave_count: parseInt(pepwaveCountResult.rows[0].count, 10),
    };
}

// ============================================================
// Semantic Search - Embeddings Management
// ============================================================

