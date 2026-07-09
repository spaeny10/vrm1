import {
    gpsCache, geofenceAlerts, snapshotCache, pepwaveCache, dbAvailable, trailerJobSiteMap,
} from '../state.js';
import { getJobSites, getTrailerAssignments, getTrailersWithGps, updateTrailerGps, getPool } from '../db.js';
import { haversineMeters } from '../clustering.js';
import { sendGeofenceEmail, isEmailConfigured } from '../email.js';

export async function checkGeofences() {
    if (!dbAvailable) return;
    try {
        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

        for (const assignment of assignments) {
            const gps = gpsCache.get(assignment.site_id);
            if (!gps) continue;

            if (!assignment.job_site_id) {
                // Trailer is unassigned. Check if it's near any job site.
                let nearestSite = null;
                let minDistance = Infinity;
                for (const site of jobSites) {
                    if (!site.latitude || !site.longitude) continue;
                    const d = haversineMeters(gps.latitude, gps.longitude, site.latitude, site.longitude);
                    if (d < minDistance) {
                        minDistance = d;
                        nearestSite = site;
                    }
                }

                if (nearestSite && minDistance <= (nearestSite.geofence_radius_m || 500)) {
                    geofenceAlerts.set(assignment.site_id, {
                        breached: false,
                        unassigned_near_site: true,
                        distance_m: Math.round(minDistance),
                        lastAlertedAt: Date.now(),
                        site_name: assignment.site_name,
                        job_site_name: null,
                        suggested_site: { id: nearestSite.id, name: nearestSite.name, distance_m: Math.round(minDistance) }
                    });
                } else {
                    const existing = geofenceAlerts.get(assignment.site_id);
                    if (existing && existing.unassigned_near_site) {
                        geofenceAlerts.delete(assignment.site_id);
                    }
                }
                continue;
            }

            const jobSite = jobSites.find(js => js.id === assignment.job_site_id);
            if (!jobSite || !jobSite.latitude || !jobSite.longitude) continue;

            const distance = haversineMeters(gps.latitude, gps.longitude, jobSite.latitude, jobSite.longitude);
            const radius = jobSite.geofence_radius_m || 500;

            if (distance > radius) {
                // Find nearest other job site to suggest reassignment
                let nearestSite = null;
                let minDistance = Infinity;
                for (const otherSite of jobSites) {
                    if (otherSite.id === jobSite.id || !otherSite.latitude || !otherSite.longitude) continue;
                    const d = haversineMeters(gps.latitude, gps.longitude, otherSite.latitude, otherSite.longitude);
                    if (d < minDistance) {
                        minDistance = d;
                        nearestSite = otherSite;
                    }
                }

                let suggestedSite = null;
                if (nearestSite && minDistance <= 1000) {
                    suggestedSite = { id: nearestSite.id, name: nearestSite.name, distance_m: Math.round(minDistance) };
                }

                const existing = geofenceAlerts.get(assignment.site_id);
                const cooldown = 24 * 60 * 60 * 1000;
                if (!existing || Date.now() - existing.lastAlertedAt > cooldown) {
                    geofenceAlerts.set(assignment.site_id, {
                        breached: true,
                        distance_m: Math.round(distance),
                        lastAlertedAt: Date.now(),
                        site_name: assignment.site_name,
                        job_site_name: jobSite.name,
                        suggested_site: suggestedSite
                    });
                    if (isEmailConfigured()) {
                        sendGeofenceEmail({
                            site_name: assignment.site_name,
                            job_site_name: jobSite.name,
                            distance_m: Math.round(distance),
                            geofence_radius_m: radius,
                        }).catch(err => console.error('  Geofence email error:', err.message));
                    }
                }
            } else {
                const existing = geofenceAlerts.get(assignment.site_id);
                if (existing && !existing.unassigned_near_site) {
                    geofenceAlerts.delete(assignment.site_id);
                }
            }
        }
    } catch (err) {
        console.error('  Geofence check error:', err.message);
    }
}

export async function detectGpsChanges() {
    if (!dbAvailable) return;

    try {
        const assignments = await getTrailerAssignments();
        const jobSites = await getJobSites();

        for (const assignment of assignments) {
            // Skip manual overrides
            if (assignment.manual_override) continue;

            // Get current GPS from cache
            const currentGps = gpsCache.get(assignment.site_id);
            if (!currentGps) continue;

            // Get last known GPS from assignment
            const lastLat = assignment.last_gps_lat;
            const lastLon = assignment.last_gps_lon;

            // First GPS reading or no previous data - just update
            if (!lastLat || !lastLon) {
                await updateTrailerGps(assignment.site_id, currentGps.latitude, currentGps.longitude);
                continue;
            }

            // Calculate distance moved
            const distanceMeters = haversineMeters(lastLat, lastLon, currentGps.latitude, currentGps.longitude);
            const distanceKm = distanceMeters / 1000;

            // Threshold: 1km for significant movement
            if (distanceKm >= 1.0) {
                // Check if suggestion already exists and is pending
                const existing = await getPool().query(
                    'SELECT id FROM gps_change_suggestions WHERE site_id = $1 AND status = $2',
                    [assignment.site_id, 'pending']
                );

                if (existing.rows.length > 0) continue; // Already has pending suggestion

                // Find nearest job site to new location
                let nearestSite = null;
                let nearestDistance = Infinity;

                for (const jobSite of jobSites) {
                    if (!jobSite.latitude || !jobSite.longitude) continue;
                    if (jobSite.id === assignment.job_site_id) continue; // Skip current site

                    const dist = haversineMeters(
                        currentGps.latitude, currentGps.longitude,
                        jobSite.latitude, jobSite.longitude
                    );

                    if (dist < nearestDistance) {
                        nearestDistance = dist;
                        nearestSite = jobSite;
                    }
                }

                // Determine suggestion type
                let suggestionType = 'create_new';
                let suggestedSiteId = null;
                let suggestedSiteName = null;

                // If nearest site is within 500m, suggest reassignment
                if (nearestSite && nearestDistance < 500) {
                    suggestionType = 'reassign_existing';
                    suggestedSiteId = nearestSite.id;
                    suggestedSiteName = nearestSite.name;
                }

                // Create suggestion
                await getPool().query(
                    `INSERT INTO gps_change_suggestions (
                        site_id, site_name, old_latitude, old_longitude,
                        new_latitude, new_longitude, distance_km,
                        current_job_site_id, current_job_site_name,
                        suggested_job_site_id, suggested_job_site_name,
                        suggestion_type
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [
                        assignment.site_id,
                        assignment.site_name,
                        lastLat,
                        lastLon,
                        currentGps.latitude,
                        currentGps.longitude,
                        distanceKm,
                        assignment.job_site_id,
                        jobSites.find(js => js.id === assignment.job_site_id)?.name || null,
                        suggestedSiteId,
                        suggestedSiteName,
                        suggestionType
                    ]
                );

                console.log(`  📍 GPS change detected: ${assignment.site_name} moved ${distanceKm.toFixed(2)}km`);
            }
        }
    } catch (err) {
        console.error('  GPS change detection error:', err.message);
    }
}
