import {
    getTrailersWithGps, getJobSites, insertJobSite, updateJobSite,
    upsertTrailerAssignment, getPool
} from './db.js';

/**
 * Reverse geocode coordinates to get a city/location name.
 * Uses OpenStreetMap Nominatim (free, 1 req/sec rate limit).
 */
async function reverseGeocode(lat, lng) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'VRM-Fleet-Dashboard/1.0' }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const addr = data.address || {};
        const road = addr.road || addr.hamlet || '';
        const city = addr.city || addr.town || addr.village || addr.county || 'Unknown';
        const state = addr.state || '';
        const zip = addr.postcode || '';
        const parts = [];
        if (road) parts.push(road);
        if (city) parts.push(city);
        if (state) parts.push(state);
        if (zip) parts.push(zip);
        return { city, state, address: parts.join(', ') || null };
    } catch {
        return null;
    }
}

/**
 * Forward geocode a free-text address to coordinates (Nominatim, US only).
 * Used when a site is created from an address so it lands on the map and
 * can be matched by arriving trailers.
 */
export async function forwardGeocode(address) {
    if (!address || !address.trim()) return null;
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'BIGView-OMNI/1.0' } });
        if (!res.ok) return null;
        const [hit] = await res.json();
        if (!hit) return null;
        return { latitude: parseFloat(hit.lat), longitude: parseFloat(hit.lon) };
    } catch {
        return null;
    }
}

/**
 * Haversine distance between two GPS points in meters.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Cluster trailers by GPS proximity.
 * Returns array of clusters: [{ centroid_lat, centroid_lng, trailers: [...] }]
 */
function clusterTrailers(trailers, thresholdMeters = 300) {
    const assigned = new Set();
    const clusters = [];

    for (const trailer of trailers) {
        if (assigned.has(trailer.site_id)) continue;
        if (trailer.latitude == null || trailer.longitude == null) continue;

        const cluster = [trailer];
        assigned.add(trailer.site_id);

        // Find all unassigned trailers within threshold of any cluster member
        let changed = true;
        while (changed) {
            changed = false;
            for (const other of trailers) {
                if (assigned.has(other.site_id)) continue;
                if (other.latitude == null || other.longitude == null) continue;

                const isNear = cluster.some(member =>
                    haversineMeters(member.latitude, member.longitude,
                                   other.latitude, other.longitude) < thresholdMeters
                );

                if (isNear) {
                    cluster.push(other);
                    assigned.add(other.site_id);
                    changed = true;
                }
            }
        }

        clusters.push(cluster);
    }

    return clusters.map(members => ({
        centroid_lat: members.reduce((s, t) => s + t.latitude, 0) / members.length,
        centroid_lng: members.reduce((s, t) => s + t.longitude, 0) / members.length,
        trailers: members,
    }));
}

/**
 * Place UNASSIGNED trailers onto job sites by GPS.
 *
 * Trailers already assigned to a site are left alone: when one moves, GPS
 * change detection raises a relocation suggestion for a human to approve,
 * and geofence checks flag breaches. (Re-clustering assigned trailers used
 * to silently undo both, and dragged site locations along with one unit.)
 *
 * For each cluster of unassigned trailers, in order:
 *   1. an open rental's destination site, if the GPS is consistent with it
 *   2. the nearest existing site within MATCH_DISTANCE_M
 *   3. a new auto-named site (reverse geocoded)
 * A site's coordinates are only set automatically when it has none.
 */
const MATCH_DISTANCE_M = 2000;

async function openRentalSiteByVrm() {
    const pool = getPool();
    if (!pool) return new Map();
    const { rows } = await pool.query(`
        SELECT t.vrm_site_id, r.job_site_id
        FROM rentals r JOIN trailers t ON t.id = r.trailer_id
        WHERE r.status IN ('delivered', 'billing', 'called_off', 'awaiting_pickup')
          AND r.picked_up_at IS NULL AND r.job_site_id IS NOT NULL AND t.vrm_site_id IS NOT NULL
    `);
    return new Map(rows.map(r => [r.vrm_site_id, r.job_site_id]));
}

export async function runClustering(thresholdMeters = 300) {
    const trailers = await getTrailersWithGps();
    const unassigned = trailers.filter(t => !t.manual_override && t.job_site_id == null);
    if (unassigned.length === 0) {
        return { jobSites: 0, created: 0, updated: 0, trailers: 0 };
    }

    const clusters = clusterTrailers(unassigned, thresholdMeters);
    const jobSites = await getJobSites();
    const rentalSites = await openRentalSiteByVrm();

    let created = 0;
    let updated = 0;

    for (const cluster of clusters) {
        let jobSiteId = null;

        // 1. Rental intent: all rentals in the cluster agree on a destination
        const intended = [...new Set(cluster.trailers.map(t => rentalSites.get(t.site_id)).filter(Boolean))];
        if (intended.length === 1) {
            const js = jobSites.find(s => s.id === intended[0]);
            if (js && (!js.latitude || !js.longitude
                || haversineMeters(js.latitude, js.longitude, cluster.centroid_lat, cluster.centroid_lng) < MATCH_DISTANCE_M)) {
                jobSiteId = js.id;
            }
        }

        // 2. Nearest existing site
        if (!jobSiteId) {
            let best = null, bestDist = Infinity;
            for (const js of jobSites) {
                if (!js.latitude || !js.longitude) continue;
                const d = haversineMeters(js.latitude, js.longitude, cluster.centroid_lat, cluster.centroid_lng);
                if (d < MATCH_DISTANCE_M && d < bestDist) { best = js; bestDist = d; }
            }
            if (best) jobSiteId = best.id;
        }

        if (jobSiteId) {
            const js = jobSites.find(s => s.id === jobSiteId);
            if (js && !js.is_headquarters && (!js.latitude || !js.longitude)) {
                await updateJobSite(jobSiteId, { latitude: cluster.centroid_lat, longitude: cluster.centroid_lng });
                js.latitude = cluster.centroid_lat;
                js.longitude = cluster.centroid_lng;
            }
            updated++;
        } else {
            // 3. New auto-named site
            let siteName = `Site ${jobSites.length + 1}`;
            let address = null;
            const geo = await reverseGeocode(cluster.centroid_lat, cluster.centroid_lng);
            if (geo) {
                siteName = `${geo.city}, ${geo.state}`.replace(/, $/, '');
                address = geo.address;
                const taken = jobSites.filter(s => s.name === siteName || s.name.startsWith(siteName + ' #')).length;
                if (taken) siteName = `${siteName} #${taken + 1}`;
            }
            const newSite = await insertJobSite({
                name: siteName, latitude: cluster.centroid_lat, longitude: cluster.centroid_lng, address,
            });
            jobSiteId = newSite.id;
            jobSites.push(newSite);
            created++;
            await new Promise(r => setTimeout(r, 1100));  // Nominatim rate limit
        }

        for (const trailer of cluster.trailers) {
            await upsertTrailerAssignment(trailer.site_id, trailer.site_name, trailer.latitude, trailer.longitude, jobSiteId);
        }
    }

    const totalAssigned = clusters.reduce((sum, c) => sum + c.trailers.length, 0);
    console.log(`  Clustering: placed ${totalAssigned} unassigned trailers (${created} new sites, ${updated} existing)`);
    return { jobSites: clusters.length, created, updated, trailers: totalAssigned };
}

export { haversineMeters, clusterTrailers };
