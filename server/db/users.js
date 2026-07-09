import { pool } from './core.js';

export async function createUser(username, passwordHash, displayName, role, mustChangePassword = false) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO users (username, password_hash, display_name, role, must_change_password)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, username, display_name, role, active, created_at`,
        [username, passwordHash, displayName, role, mustChangePassword]
    );
    return result.rows[0];
}

export async function getUserByUsername(username) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT * FROM users WHERE username = $1 AND active = TRUE`,
        [username]
    );
    return result.rows[0] || null;
}

export async function getUserById(id) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT id, username, display_name, role, active, created_at, must_change_password FROM users WHERE id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

export async function getUserByGoogleId(googleId) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT * FROM users WHERE google_id = $1 AND active = TRUE`,
        [googleId]
    );
    return result.rows[0] || null;
}

export async function getUserByEmail(email) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT * FROM users WHERE email = $1 AND active = TRUE`,
        [email]
    );
    return result.rows[0] || null;
}

export async function createGoogleUser(googleId, email, displayName, role = 'viewer') {
    if (!pool) return null;
    const username = email.split('@')[0];
    const result = await pool.query(
        `INSERT INTO users (username, password_hash, display_name, role, google_id, email)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, display_name, role, active, created_at, email`,
        [username, 'google-sso-no-password', displayName, role, googleId, email]
    );
    return result.rows[0];
}

export async function getUsers() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT id, username, display_name, role, active, created_at, updated_at, email, google_id, last_login, digest_enabled FROM users ORDER BY created_at ASC`
    );
    return result.rows;
}

export async function updateUser(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
        if (['display_name', 'role', 'active', 'password_hash', 'google_id', 'email', 'last_login', 'digest_enabled', 'must_change_password'].includes(key)) {
            fields.push(`${key} = $${idx++}`);
            values.push(val);
        }
    }
    if (fields.length === 0) return null;
    fields.push(`updated_at = $${idx++}`);
    values.push(Date.now());
    values.push(id);
    const result = await pool.query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, username, display_name, role, active`,
        values
    );
    return result.rows[0] || null;
}

export async function deleteUser(id) {
    if (!pool) return;
    await pool.query(`UPDATE users SET active = FALSE, updated_at = $2 WHERE id = $1`, [id, Date.now()]);
}

// ============================================================
// Action Queue Acknowledgements
// ============================================================


export async function getCustomerSiteAccess(userId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT csa.*, js.name as job_site_name, js.status, js.address
         FROM customer_site_access csa
         JOIN job_sites js ON csa.job_site_id = js.id
         WHERE csa.user_id = $1
         ORDER BY js.name`,
        [userId]
    );
    return result.rows;
}

export async function upsertCustomerSiteAccess(userId, jobSiteIds) {
    if (!pool) return;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM customer_site_access WHERE user_id = $1`, [userId]);
        for (const jsId of jobSiteIds) {
            await client.query(
                `INSERT INTO customer_site_access (user_id, job_site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [userId, jsId]
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ============================================================
// Notifications
// ============================================================
