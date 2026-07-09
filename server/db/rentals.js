import { pool } from './core.js';

const TRAILER_STATUSES = ['available', 'reserved', 'on_rent', 'in_transit', 'maintenance', 'retired'];
const OPEN_RENTAL_STATUSES = ['reserved', 'delivered', 'billing', 'called_off', 'awaiting_pickup'];

export async function getTrailers({ status } = {}) {
    if (!pool) return [];
    const params = [];
    let where = '';
    if (status) {
        params.push(status);
        where = `WHERE t.status = $1`;
    }
    const result = await pool.query(`
        SELECT t.*,
               ta.job_site_id AS current_job_site_id,
               js.name AS current_job_site_name,
               js.is_headquarters AS at_headquarters,
               r.id AS open_rental_id,
               r.status AS open_rental_status
        FROM trailers t
        LEFT JOIN trailer_assignments ta ON ta.site_id = t.vrm_site_id
        LEFT JOIN job_sites js ON js.id = ta.job_site_id
        LEFT JOIN rentals r ON r.trailer_id = t.id AND r.status NOT IN ('closed', 'cancelled')
        ${where}
        ORDER BY t.unit_number
    `, params);
    return result.rows;
}

export async function getTrailer(id) {
    if (!pool) return null;
    const result = await pool.query(`SELECT * FROM trailers WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function insertTrailer(t) {
    if (!pool) return null;
    const result = await pool.query(`
        INSERT INTO trailers (unit_number, vin, vrm_site_id, ic2_device_id, status, home_base_job_site_id, purchase_date, condition_notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
    `, [
        t.unit_number,
        t.vin || null,
        t.vrm_site_id || null,
        t.ic2_device_id || null,
        TRAILER_STATUSES.includes(t.status) ? t.status : 'available',
        t.home_base_job_site_id || null,
        t.purchase_date || null,
        t.condition_notes || null,
    ]);
    return result.rows[0];
}

export async function updateTrailer(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, value] of Object.entries(updates)) {
        if (['unit_number', 'vin', 'vrm_site_id', 'ic2_device_id', 'status', 'home_base_job_site_id', 'purchase_date', 'condition_notes'].includes(key)) {
            if (key === 'status' && !TRAILER_STATUSES.includes(value)) continue;
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
        `UPDATE trailers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

// ============================================================
// Rentals & billing lifecycle
// ============================================================

const RENTAL_JOIN = `
    SELECT r.*,
           t.unit_number, t.vrm_site_id, t.status AS trailer_status, t.product_code,
           js.name AS job_site_name,
           c.name AS company_name
    FROM rentals r
    JOIN trailers t ON t.id = r.trailer_id
    LEFT JOIN job_sites js ON js.id = r.job_site_id
    LEFT JOIN companies c ON c.id = r.company_id
`;

export async function getRentals({ status, trailerId, jobSiteId, companyId, open } = {}) {
    if (!pool) return [];
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`r.status = $${params.length}`); }
    if (trailerId) { params.push(trailerId); conditions.push(`r.trailer_id = $${params.length}`); }
    if (jobSiteId) { params.push(jobSiteId); conditions.push(`r.job_site_id = $${params.length}`); }
    if (companyId) { params.push(companyId); conditions.push(`r.company_id = $${params.length}`); }
    if (open) conditions.push(`r.status NOT IN ('closed', 'cancelled')`);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(`
        ${RENTAL_JOIN}
        ${where}
        ORDER BY
            CASE r.status
                WHEN 'billing' THEN 0 WHEN 'called_off' THEN 1 WHEN 'awaiting_pickup' THEN 2
                WHEN 'delivered' THEN 3 WHEN 'reserved' THEN 4 ELSE 5
            END,
            t.unit_number
    `, params);
    return result.rows;
}

export async function getRental(id) {
    if (!pool) return null;
    const result = await pool.query(`${RENTAL_JOIN} WHERE r.id = $1`, [id]);
    return result.rows[0] || null;
}

export async function insertRental(r) {
    if (!pool) return null;
    const result = await pool.query(`
        INSERT INTO rentals (trailer_id, job_site_id, company_id, po_number, reserved_at, rate_amount, rate_period, commitment_term, status, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
    `, [
        r.trailer_id,
        r.job_site_id || null,
        r.company_id || null,
        r.po_number || null,
        r.reserved_at || new Date().toISOString().slice(0, 10),
        r.rate_amount || null,
        ['day', 'week', 'month'].includes(r.rate_period) ? r.rate_period : 'month',
        ['monthly', '6_month', '1_year'].includes(r.commitment_term) ? r.commitment_term : 'monthly',
        'reserved',
        r.notes || null,
    ]);
    return result.rows[0];
}

export async function updateRental(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, value] of Object.entries(updates)) {
        if (['job_site_id', 'company_id', 'po_number', 'reserved_at', 'delivered_at', 'billing_start', 'calloff_at', 'billing_stop', 'picked_up_at', 'returned_at', 'rate_amount', 'rate_period', 'commitment_term', 'rollback_amount', 'status', 'notes'].includes(key)) {
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
        `UPDATE rentals SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

export async function insertRentalEvent(rentalId, eventType, eventDate, actor = 'system', notes = null) {
    if (!pool) return null;
    const result = await pool.query(`
        INSERT INTO rental_events (rental_id, event_type, event_date, actor, notes)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
    `, [rentalId, eventType, eventDate, actor, notes]);
    return result.rows[0];
}

export async function getRentalEvents(rentalId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM rental_events WHERE rental_id = $1 ORDER BY event_date, created_at`,
        [rentalId]
    );
    return result.rows;
}

// ============================================================
// Billing: revenue-leakage alert queries
// ============================================================

// Rentals still accruing past their calloff date (billing or called_off —
// both accrue until billing_stop is stamped)
export async function getBillingPastCalloff() {
    if (!pool) return [];
    const result = await pool.query(`
        ${RENTAL_JOIN}
        WHERE r.status IN ('billing', 'called_off')
          AND r.billing_stop IS NULL
          AND r.calloff_at IS NOT NULL
          AND r.calloff_at < CURRENT_DATE
        ORDER BY r.calloff_at
    `);
    return result.rows;
}

// Trailers physically at HQ (per GPS assignment) but with billing still running
export async function getBillingAtHeadquarters() {
    if (!pool) return [];
    const result = await pool.query(`
        SELECT r.*, t.unit_number, js.name AS hq_name
        FROM rentals r
        JOIN trailers t ON t.id = r.trailer_id
        JOIN trailer_assignments ta ON ta.site_id = t.vrm_site_id
        JOIN job_sites js ON js.id = ta.job_site_id
        WHERE js.is_headquarters = TRUE
          AND r.status IN ('billing', 'called_off')
          AND r.billing_stop IS NULL
        ORDER BY t.unit_number
    `);
    return result.rows;
}

// Trailers deployed on an active customer site with no open rental (unbilled units)
export async function getUnbilledDeployedTrailers() {
    if (!pool) return [];
    const result = await pool.query(`
        SELECT t.id AS trailer_id, t.unit_number, js.id AS job_site_id, js.name AS job_site_name
        FROM trailers t
        JOIN trailer_assignments ta ON ta.site_id = t.vrm_site_id
        JOIN job_sites js ON js.id = ta.job_site_id
        WHERE js.is_headquarters IS NOT TRUE
          AND js.status = 'active'
          AND t.status != 'retired'
          AND NOT EXISTS (
            SELECT 1 FROM rentals r
            WHERE r.trailer_id = t.id AND r.status NOT IN ('closed', 'cancelled')
          )
        ORDER BY t.unit_number
    `);
    return result.rows;
}

// ============================================================
// Pricing: rate cards, volume tiers, on-rent windows
// ============================================================

export async function getRateCards(productCode = null) {
    if (!pool) return [];
    const params = [];
    let where = 'WHERE active = TRUE';
    if (productCode) {
        params.push(productCode);
        where += ` AND product_code = $1`;
    }
    const result = await pool.query(`SELECT * FROM rate_cards ${where} ORDER BY product_code, base_rate DESC`, params);
    return result.rows;
}

export async function getVolumeTiers() {
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM volume_tiers ORDER BY min_units`);
    return result.rows;
}

// Billing windows for every rental that ever billed, grouped by company —
// used to resolve each customer's EA volume tier at any cycle-open date
export async function getCompanyRentalWindows() {
    if (!pool) return [];
    const result = await pool.query(`
        SELECT company_id, billing_start, billing_stop
        FROM rentals
        WHERE company_id IS NOT NULL
          AND billing_start IS NOT NULL
          AND status != 'cancelled'
    `);
    return result.rows;
}

export { OPEN_RENTAL_STATUSES };
