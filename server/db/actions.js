import { pool } from './core.js';

export async function getAcknowledgedActions() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT a.action_key, a.acknowledged_at, a.notes, u.display_name AS acknowledged_by_name
         FROM action_queue_acks a LEFT JOIN users u ON a.acknowledged_by = u.id`
    );
    return result.rows;
}

export async function acknowledgeAction(actionKey, userId, notes) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO action_queue_acks (action_key, acknowledged_by, acknowledged_at, notes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (action_key) DO UPDATE SET acknowledged_by = $2, acknowledged_at = $3, notes = $4
         RETURNING *`,
        [actionKey, userId, Date.now(), notes || null]
    );
    return result.rows[0];
}

export async function unacknowledgeAction(actionKey) {
    if (!pool) return;
    await pool.query(`DELETE FROM action_queue_acks WHERE action_key = $1`, [actionKey]);
}

// ============================================================
// Checklist Templates
// ============================================================

