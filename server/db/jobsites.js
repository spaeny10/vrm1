import { pool } from './core.js';

export async function getJobSites() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM job_sites ORDER BY
            CASE WHEN status = 'active' THEN 0 WHEN status = 'standby' THEN 1 ELSE 2 END, name`
    );
    return result.rows;
}

export async function getJobSite(id) {
    if (!pool) return null;
    const result = await pool.query(`SELECT * FROM job_sites WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function getJobSiteByPhone(phone) {
    if (!pool || !phone) return null;
    const cleanPhone = phone.replace(/\D/g, '');
    if (!cleanPhone) return null;
    // Search CRM contacts linked to job sites via site_contacts
    const result = await pool.query(`
        SELECT js.* FROM job_sites js
        JOIN site_contacts sc ON sc.job_site_id = js.id
        JOIN contacts c ON c.id = sc.contact_id
        WHERE regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE '%' || $1 || '%'
        LIMIT 1
    `, [cleanPhone.slice(-10)]);
    return result.rows[0] || null;
}

export async function insertJobSite(site) {
    if (!pool) return null;

    // Collision-safe UID generation with retry loop
    let uid = site.uid;
    if (!uid) {
        for (let attempt = 0; attempt < 5; attempt++) {
            uid = `SITE-${Math.floor(Math.random() * 90000) + 10000}`;
            const existing = await pool.query(`SELECT id FROM job_sites WHERE uid = $1`, [uid]);
            if (existing.rows.length === 0) break;
            if (attempt === 4) uid = `SITE-${Date.now().toString(36).toUpperCase()}`; // fallback guaranteed unique
        }
    }

    const result = await pool.query(
        `INSERT INTO job_sites (
            name, latitude, longitude, address, status, notes, uid,
            created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         RETURNING *`,
        [
            site.name,
            site.latitude,
            site.longitude,
            site.address || null,
            site.status || 'active',
            site.notes || null,
            uid,
            Date.now()
        ]
    );
    return result.rows[0];
}

export async function updateJobSite(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (['name', 'latitude', 'longitude', 'address', 'status', 'notes', 'is_headquarters', 'delivery_date', 'active_date', 'calloff_date', 'pickup_date', 'geofence_radius_m', 'uid', 'company_id'].includes(key)) {
            fields.push(`${key} = $${idx}`);
            values.push(value);
            idx++;
        }
    }
    if (fields.length === 0) return null;

    fields.push(`updated_at = $${idx}`);
    values.push(Date.now());
    idx++;

    values.push(id);
    const result = await pool.query(
        `UPDATE job_sites SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

export async function deleteJobSite(id) {
    if (!pool) return null;
    const result = await pool.query('DELETE FROM job_sites WHERE id = $1 RETURNING *', [id]);
    return result.rows[0] || null;
}

// ============================================================
// Site Notes
// ============================================================
