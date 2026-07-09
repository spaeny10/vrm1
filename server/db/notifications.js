import { pool } from './core.js';

let notificationsTableReady = false;

async function ensureNotificationsTable() {
    if (notificationsTableReady || !pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL DEFAULT 'mention',
            title TEXT NOT NULL,
            body TEXT,
            link TEXT,
            read BOOLEAN NOT NULL DEFAULT FALSE,
            created_at BIGINT NOT NULL
        )
    `);
    notificationsTableReady = true;
}

export async function insertNotification(userId, type, title, body, link) {
    if (!pool) return null;
    await ensureNotificationsTable();
    const result = await pool.query(
        `INSERT INTO notifications (user_id, type, title, body, link, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [userId, type, title, body || null, link || null, Date.now()]
    );
    return result.rows[0];
}

export async function getUserNotifications(userId, { limit = 20, unreadOnly = false } = {}) {
    if (!pool) return [];
    await ensureNotificationsTable();
    const where = unreadOnly ? 'AND read = FALSE' : '';
    const result = await pool.query(
        `SELECT * FROM notifications WHERE user_id = $1 ${where} ORDER BY created_at DESC LIMIT $2`,
        [userId, limit]
    );
    return result.rows;
}

export async function getUnreadNotificationCount(userId) {
    if (!pool) return 0;
    await ensureNotificationsTable();
    const result = await pool.query(
        `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = FALSE`, [userId]
    );
    return parseInt(result.rows[0].count) || 0;
}

export async function markNotificationRead(notifId) {
    if (!pool) return;
    await pool.query(`UPDATE notifications SET read = TRUE WHERE id = $1`, [notifId]);
}

export async function markAllNotificationsRead(userId) {
    if (!pool) return;
    await pool.query(`UPDATE notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE`, [userId]);
}

// ============================================================
// Trailers (rental fleet assets)
// ============================================================

