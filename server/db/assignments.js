import { pool } from './core.js';

export async function getTrailerAssignments() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT ta.*, js.name as job_site_name
         FROM trailer_assignments ta
         LEFT JOIN job_sites js ON ta.job_site_id = js.id
         ORDER BY ta.site_name`
    );
    return result.rows;
}

export async function getTrailersByJobSite(jobSiteId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM trailer_assignments WHERE job_site_id = $1 ORDER BY site_name`,
        [jobSiteId]
    );
    return result.rows;
}

export async function upsertTrailerAssignment(siteId, siteName, latitude, longitude, jobSiteId = null, ic2DeviceId = null) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO trailer_assignments (site_id, site_name, latitude, longitude, job_site_id, ic2_device_id, assigned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (site_id) DO UPDATE SET
           site_name = $2,
           latitude = COALESCE($3, trailer_assignments.latitude),
           longitude = COALESCE($4, trailer_assignments.longitude),
           job_site_id = CASE WHEN trailer_assignments.manual_override THEN trailer_assignments.job_site_id ELSE COALESCE($5, trailer_assignments.job_site_id) END,
           ic2_device_id = COALESCE($6, trailer_assignments.ic2_device_id),
           assigned_at = $7
         RETURNING *`,
        [siteId, siteName, latitude, longitude, jobSiteId, ic2DeviceId, Date.now()]
    );
    return result.rows[0];
}

export async function linkIc2Device(siteId, ic2DeviceId) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE trailer_assignments SET ic2_device_id = $1, assigned_at = $2 WHERE site_id = $3 RETURNING *`,
        [ic2DeviceId, Date.now(), siteId]
    );
    return result.rows[0] || null;
}

export async function assignTrailerToJobSite(siteId, jobSiteId, manual = false) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE trailer_assignments
         SET job_site_id = $1, manual_override = $2, assigned_at = $3
         WHERE site_id = $4
         RETURNING *`,
        [jobSiteId, manual, Date.now(), siteId]
    );
    return result.rows[0] || null;
}

export async function getTrailersWithGps() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM trailer_assignments
         WHERE latitude IS NOT NULL AND longitude IS NOT NULL
         ORDER BY site_name`
    );
    return result.rows;
}

/**
 * Updates trailer GPS tracking data (last known position)
 * Used for GPS change detection
 */
export async function updateTrailerGps(siteId, latitude, longitude) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE trailer_assignments
         SET last_gps_lat = $2,
             last_gps_lon = $3,
             last_gps_update = $4
         WHERE site_id = $1
         RETURNING *`,
        [siteId, latitude, longitude, Date.now()]
    );
    return result.rows[0] || null;
}

/**
 * Gets GPS change suggestions filtered by status
 */
export async function getGpsSuggestions(status = 'pending') {
    if (!pool) return [];
    const result = await pool.query(
        'SELECT * FROM gps_change_suggestions WHERE status = $1 ORDER BY created_at DESC',
        [status]
    );
    return result.rows;
}

/**
 * Updates GPS suggestion status (approve/reject)
 */
export async function updateGpsSuggestionStatus(suggestionId, status, resolvedBy) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE gps_change_suggestions
         SET status = $2, resolved_at = $3, resolved_by = $4
         WHERE id = $1
         RETURNING *`,
        [suggestionId, status, Date.now(), resolvedBy]
    );
    return result.rows[0] || null;
}

// ============================================================
// Maintenance Logs
// ============================================================

