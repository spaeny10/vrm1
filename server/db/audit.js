import { pool } from './core.js';

export async function insertAuditLog(entityType, entityId, action, details = {}, actor = 'system') {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO audit_log (entity_type, entity_id, action, details, actor, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [entityType, entityId, action, JSON.stringify(details), actor, Date.now()]
    );
    return result.rows[0];
}

export async function getAuditLog({ entityType, entityId, limit = 50, offset = 0 } = {}) {
    if (!pool) return { entries: [], total: 0 };
    let where = 'WHERE 1=1';
    const params = [];
    let idx = 1;

    if (entityType) {
        where += ` AND entity_type = $${idx}`;
        params.push(entityType);
        idx++;
    }
    if (entityId) {
        where += ` AND entity_id = $${idx}`;
        params.push(entityId);
        idx++;
    }

    const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM audit_log ${where}`,
        params
    );
    const total = parseInt(countResult.rows[0].total);

    params.push(limit, offset);
    const result = await pool.query(
        `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        params
    );
    return { entries: result.rows, total };
}

// ============================================================
// Trailer Assignments
// ============================================================

