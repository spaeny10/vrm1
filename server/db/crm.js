import { pool } from './core.js';

export async function getCompanies() {
    if (!pool) return [];
    const result = await pool.query(`
        SELECT c.*, 
            (SELECT COUNT(*) FROM job_sites WHERE company_id = c.id) as site_count,
            (SELECT COUNT(*) FROM contacts WHERE company_id = c.id) as contact_count
        FROM companies c ORDER BY c.name
    `);
    return result.rows;
}

export async function getCompany(id) {
    if (!pool) return null;
    const result = await pool.query(`SELECT * FROM companies WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function insertCompany(company) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO companies (name, address, city, state, zip, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING *`,
        [company.name, company.address || null, company.city || null, company.state || null, company.zip || null, company.notes || null, Date.now()]
    );
    return result.rows[0];
}

export async function updateCompany(id, data) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const key of ['name', 'address', 'city', 'state', 'zip', 'notes']) {
        if (data[key] !== undefined) {
            fields.push(`${key} = $${idx}`);
            values.push(data[key]);
            idx++;
        }
    }
    if (fields.length === 0) return null;
    fields.push(`updated_at = $${idx}`);
    values.push(Date.now());
    idx++;
    values.push(id);
    const result = await pool.query(
        `UPDATE companies SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0];
}

// ============================================================
// Contacts
// ============================================================
export async function getContacts(companyId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM contacts WHERE company_id = $1 ORDER BY is_primary DESC, name`,
        [companyId]
    );
    return result.rows;
}

export async function insertContact(contact) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO contacts (company_id, name, title, phone, email, is_primary, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [contact.company_id, contact.name, contact.title || null, contact.phone || null, contact.email || null, contact.is_primary || false, Date.now()]
    );
    return result.rows[0];
}

export async function updateContact(id, data) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const key of ['name', 'title', 'phone', 'email', 'is_primary']) {
        if (data[key] !== undefined) {
            fields.push(`${key} = $${idx}`);
            values.push(data[key]);
            idx++;
        }
    }
    if (fields.length === 0) return null;
    values.push(id);
    const result = await pool.query(
        `UPDATE contacts SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0];
}

export async function deleteContact(id) {
    if (!pool) return;
    await pool.query(`DELETE FROM contacts WHERE id = $1`, [id]);
}

export async function getContactById(id) {
    if (!pool) return null;
    const result = await pool.query(`SELECT * FROM contacts WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function getContactSiteIds(contactId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT DISTINCT job_site_id FROM site_contacts WHERE contact_id = $1`, [contactId]
    );
    return result.rows.map(r => r.job_site_id);
}

export async function setContactPortalUserId(contactId, userId) {
    if (!pool) return;
    await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS portal_user_id INTEGER`);
    await pool.query(`UPDATE contacts SET portal_user_id = $1 WHERE id = $2`, [userId, contactId]);
}

// ============================================================
// Site Contacts (junction)
// ============================================================
export async function getSiteContacts(jobSiteId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT sc.id, sc.role, c.id as contact_id, c.name, c.title, c.phone, c.email, c.is_primary, co.name as company_name
         FROM site_contacts sc
         JOIN contacts c ON sc.contact_id = c.id
         LEFT JOIN companies co ON c.company_id = co.id
         WHERE sc.job_site_id = $1
         ORDER BY c.is_primary DESC, c.name`,
        [jobSiteId]
    );
    return result.rows;
}

export async function assignContactToSite(jobSiteId, contactId, role = 'on-site') {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO site_contacts (job_site_id, contact_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (job_site_id, contact_id) DO UPDATE SET role = $3
         RETURNING *`,
        [jobSiteId, contactId, role]
    );
    return result.rows[0];
}

export async function removeContactFromSite(jobSiteId, contactId) {
    if (!pool) return;
    await pool.query(`DELETE FROM site_contacts WHERE job_site_id = $1 AND contact_id = $2`, [jobSiteId, contactId]);
}

// ============================================================
// Audit Log
// ============================================================
