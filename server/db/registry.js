import { pool } from './core.js';

// Apply one repair produced by the fleet roster (services/roster.js).
// Every statement re-checks its own precondition, so a repair that no
// longer applies is a no-op. Returns true when something changed.
export async function applyRosterRepair(r) {
    if (!pool) return false;
    const now = Date.now();

    if (r.type === 'remove_duplicate') {
        // Only ever an untouched, auto-created row that duplicates another trailer
        const res = await pool.query(
            `DELETE FROM trailers
             WHERE id = $1 AND id <> $2
               AND vin IS NULL AND purchase_date IS NULL AND condition_notes IS NULL AND status = 'available'
               AND NOT EXISTS (SELECT 1 FROM rentals WHERE trailer_id = $1)
               AND EXISTS (SELECT 1 FROM trailers WHERE id = $2)`,
            [r.trailer_id, r.keep]
        );
        return res.rowCount > 0;
    }

    if (r.type === 'relink') {
        const res = await pool.query(
            `UPDATE trailers SET vrm_site_id = $2, ic2_device_id = COALESCE(ic2_device_id, $3), updated_at = $4
             WHERE id = $1 AND vrm_site_id IS DISTINCT FROM $2
               AND NOT EXISTS (SELECT 1 FROM trailers WHERE vrm_site_id = $2 AND id <> $1)`,
            [r.trailer_id, r.to, r.router_id ?? null, now]
        );
        return res.rowCount > 0;
    }

    if (r.type === 'merge_assignment') {
        // Carry the job site and location over to the id the trailer reports
        // under now, then retire the old row.
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const moved = await client.query(
                `INSERT INTO trailer_assignments (site_id, site_name, latitude, longitude, job_site_id, ic2_device_id, manual_override, assigned_at)
                 SELECT $2, site_name, latitude, longitude, job_site_id, ic2_device_id, manual_override, assigned_at
                 FROM trailer_assignments WHERE site_id = $1
                 ON CONFLICT (site_id) DO UPDATE SET
                   latitude = COALESCE(trailer_assignments.latitude, EXCLUDED.latitude),
                   longitude = COALESCE(trailer_assignments.longitude, EXCLUDED.longitude),
                   job_site_id = COALESCE(trailer_assignments.job_site_id, EXCLUDED.job_site_id),
                   manual_override = trailer_assignments.manual_override OR EXCLUDED.manual_override,
                   ic2_device_id = COALESCE(trailer_assignments.ic2_device_id, EXCLUDED.ic2_device_id)`,
                [r.from, r.to]
            );
            if (r.from < 0) {
                await client.query(`DELETE FROM trailer_assignments WHERE site_id = $1`, [r.from]);
            } else {
                // A VRM installation still exists for this id, so the poller would
                // recreate the row. Keep it, but take it off the site and the map.
                await client.query(
                    `UPDATE trailer_assignments SET job_site_id = NULL, manual_override = FALSE, latitude = NULL, longitude = NULL WHERE site_id = $1`,
                    [r.from]
                );
            }
            await client.query('COMMIT');
            return moved.rowCount > 0;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    if (r.type === 'register') {
        const res = await pool.query(
            `INSERT INTO trailers (unit_number, vrm_site_id, ic2_device_id, status)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [r.unit, r.site_id, r.router_id ?? null, r.status || 'available']
        );
        return res.rowCount > 0;
    }

    return false;
}

// A person is linking a trailer to a Cerbo or router. If the only thing in
// the way is the untouched row the app auto-created for that telemetry,
// remove it so the link can be made. Returns the unit number of a real
// trailer that already holds the link, or null when the way is clear.
export async function releaseTelemetryLink(vrmSiteId, forTrailerId = null) {
    if (!pool || vrmSiteId == null) return null;
    await pool.query(
        `DELETE FROM trailers
         WHERE vrm_site_id = $1 AND id IS DISTINCT FROM $2
           AND vin IS NULL AND purchase_date IS NULL AND condition_notes IS NULL AND status IN ('available', 'maintenance')
           AND NOT EXISTS (SELECT 1 FROM rentals WHERE trailer_id = trailers.id)`,
        [vrmSiteId, forTrailerId]
    );
    const held = await pool.query(
        `SELECT unit_number FROM trailers WHERE vrm_site_id = $1 AND id IS DISTINCT FROM $2`, [vrmSiteId, forTrailerId]);
    return held.rows[0]?.unit_number || null;
}
