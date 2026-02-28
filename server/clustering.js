import {
    getTrailersWithGps, getJobSites, insertJobSite,
    upsertTrailerAssignment, getTrailersByJobSite
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
 * Run clustering and reconcile with existing job_sites in the database.
 * - Matches clusters to existing job sites by trailer overlap
 * - Creates new job sites for unmatched clusters
 * - Respects manual_override on trailer assignments
 */
export async function runClustering(thresholdMeters = 300) {
    const trailers = await getTrailersWithGps();
    if (trailers.length === 0) {
        console.log('  Clustering: No trailers with GPS data yet');
        return { jobSites: 0, trailers: 0 };
    }

    // Separate manual overrides — don't recluster these
    const autoTrailers = trailers.filter(t => !t.manual_override);
    const clusters = clusterTrailers(autoTrailers, thresholdMeters);

    const existingJobSites = await getJobSites();

    // Build map: job_site_id -> set of site_ids currently assigned
    const existingAssignments = new Map();
    for (const js of existingJobSites) {
        const assigned = await getTrailersByJobSite(js.id);
        existingAssignments.set(js.id, new Set(assigned.map(a => a.site_id)));
    }

    let created = 0;
    let updated = 0;

    for (const cluster of clusters) {
        const clusterSiteIds = new Set(cluster.trailers.map(t => t.site_id));

        // Find the existing job site with the most overlap
        let bestMatch = null;
        let bestOverlap = 0;

        for (const [jobSiteId, assignedIds] of existingAssignments) {
            const overlap = [...clusterSiteIds].filter(id => assignedIds.has(id)).length;
            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestMatch = jobSiteId;
            }
        }

        let jobSiteId;
        if (bestMatch && bestOverlap > 0) {
            // Update existing job site centroid
            jobSiteId = bestMatch;
            updated++;
        } else {
            // Create new job site — reverse geocode for name
            let siteName = `Site ${existingJobSites.length + created + 1}`;
            let address = null;
            const geo = await reverseGeocode(cluster.centroid_lat, cluster.centroid_lng);
            if (geo) {
                siteName = `${geo.city}, ${geo.state}`.replace(/, $/, '');
                address = geo.address;
                // Disambiguate if name already exists
                const existingNames = existingJobSites.map(s => s.name);
                if (existingNames.some(n => n === siteName || n.startsWith(siteName + ' #'))) {
                    const count = existingNames.filter(n => n === siteName || n.startsWith(siteName + ' #')).length;
                    siteName = `${siteName} #${count + 1}`;
                }
            }
            const newSite = await insertJobSite({
                name: siteName,
                latitude: cluster.centroid_lat,
                longitude: cluster.centroid_lng,
                address,
            });
            jobSiteId = newSite.id;
            existingJobSites.push({ id: jobSiteId, name: siteName });
            created++;
            // Rate limit Nominatim
            await new Promise(r => setTimeout(r, 1100));
        }

        // Assign all trailers in this cluster to the job site
        for (const trailer of cluster.trailers) {
            await upsertTrailerAssignment(
                trailer.site_id,
                trailer.site_name,
                trailer.latitude,
                trailer.longitude,
                jobSiteId
            );
        }
    }

    const totalAssigned = clusters.reduce((sum, c) => sum + c.trailers.length, 0);
    console.log(`  Clustering complete: ${clusters.length} sites (${created} new, ${updated} matched), ${totalAssigned} trailers assigned`);

    return {
        jobSites: clusters.length,
        created,
        updated,
        trailers: totalAssigned,
    };
}

export { haversineMeters, clusterTrailers };
