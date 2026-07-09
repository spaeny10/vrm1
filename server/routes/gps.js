import { runClustering } from '../clustering.js';
import { IC2_CLIENT_ID, IC2_CLIENT_SECRET, IC2_GROUP_ID, IC2_ORG_ID } from '../config.js';
import { getGpsSuggestions, getJobSites, getPool, getTrailerAssignments, insertAuditLog, insertJobSite, linkIc2Device, updateGpsSuggestionStatus, updateTrailerGps, upsertTrailerAssignment } from '../db.js';
import { getPepwaveForTrailer, hasVrmData } from '../lib/util.js';
import { requireRole } from '../middleware/auth.js';
import { checkGeofences } from '../services/geofence.js';
import { ic2Fetch } from '../services/ic2Client.js';
import { resolveIc2DeviceToSiteId } from '../services/ic2Poller.js';
import { dbAvailable, geofenceAlerts, gpsCache, ic2DeviceIdToSiteId, pepwaveCache, sitesCache, snapshotCache, weatherCache } from '../state.js';

export function registerGpsRoutes(app) {

// GET pending GPS change suggestions
app.get('/api/gps-changes', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const suggestions = await getGpsSuggestions('pending');
        res.json({ suggestions });
    } catch (err) {
        console.error('Get GPS changes error:', err);
        res.status(500).json({ error: 'Failed to fetch GPS change suggestions' });
    }
});

// POST approve GPS change suggestion
app.post('/api/gps-changes/:id/approve', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { id } = req.params;
        const { create_new_site_name } = req.body;

        // Get suggestion
        const suggestionResult = await getPool().query('SELECT * FROM gps_change_suggestions WHERE id = $1', [id]);
        if (suggestionResult.rows.length === 0) {
            return res.status(404).json({ error: 'Suggestion not found' });
        }

        const suggestion = suggestionResult.rows[0];
        if (suggestion.status !== 'pending') {
            return res.status(400).json({ error: 'Suggestion already resolved' });
        }

        let targetJobSiteId = suggestion.suggested_job_site_id;

        // If creating new site, create it first
        if (suggestion.suggestion_type === 'create_new') {
            const siteName = create_new_site_name || `New Site ${new Date().toISOString().slice(0, 10)}`;
            const newSite = await insertJobSite({
                name: siteName,
                latitude: suggestion.new_latitude,
                longitude: suggestion.new_longitude,
                address: null,
            });
            targetJobSiteId = newSite.id;
        }

        // Update trailer assignment
        await upsertTrailerAssignment(
            suggestion.site_id,
            suggestion.site_name,
            suggestion.new_latitude,
            suggestion.new_longitude,
            targetJobSiteId
        );

        // Update GPS tracking
        await updateTrailerGps(suggestion.site_id, suggestion.new_latitude, suggestion.new_longitude);

        // Mark suggestion as approved
        await updateGpsSuggestionStatus(id, 'approved', req.user.id);

        // Clear geofence alert for this trailer since assignment changed
        geofenceAlerts.delete(suggestion.site_id);

        // Log to audit
        await insertAuditLog('gps_suggestion', id, 'approved', {
            site_name: suggestion.site_name,
            target_job_site_id: targetJobSiteId,
            distance_km: suggestion.distance_km
        }, req.user.display_name);

        res.json({ success: true, target_job_site_id: targetJobSiteId });
    } catch (err) {
        console.error('Approve GPS change error:', err);
        res.status(500).json({ error: 'Failed to approve GPS change' });
    }
});

// POST reject GPS change suggestion
app.post('/api/gps-changes/:id/reject', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await updateGpsSuggestionStatus(id, 'rejected', req.user.id);

        if (!result) {
            return res.status(404).json({ error: 'Suggestion not found or already resolved' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Reject GPS change error:', err);
        res.status(500).json({ error: 'Failed to reject GPS change' });
    }
});

// GET map data (lightweight for markers)
app.get('/api/map/sites', async (req, res) => {
    try {
        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

        const assignmentsByJobSite = new Map();
        for (const a of assignments) {
            if (!assignmentsByJobSite.has(a.job_site_id)) {
                assignmentsByJobSite.set(a.job_site_id, []);
            }
            assignmentsByJobSite.get(a.job_site_id).push(a);
        }

        const markers = jobSites
            .filter(js => js.latitude != null && js.longitude != null)
            .map(js => {
                const trailers = assignmentsByJobSite.get(js.id) || [];
                let worstStatus = 'healthy';
                let trailersOnline = 0;
                let totalSoc = 0, socCount = 0;

                for (const t of trailers) {
                    const snap = snapshotCache.get(t.site_id);
                    const pw = pepwaveCache.get(t.site_name);
                    const isIc2Only = t.site_id < 0;
                    if (isIc2Only) {
                        if (pw?.online) trailersOnline++;
                    } else if (snap && hasVrmData(snap)) {
                        trailersOnline++;
                        if (snap.battery_soc != null) {
                            totalSoc += snap.battery_soc;
                            socCount++;
                            if (snap.battery_soc < 20) worstStatus = 'critical';
                            else if (snap.battery_soc < 50 && worstStatus !== 'critical') worstStatus = 'warning';
                        }
                    } else if (pw?.online) {
                        // No Cerbo/VRM data but Pepwave is online — not critical
                        trailersOnline++;
                    } else if (!snap) {
                        // No VRM snapshot AND no Pepwave connectivity — truly offline
                        if (worstStatus !== 'critical') worstStatus = 'warning';
                    }
                }

                // Check for geofence breaches on any trailer at this site
                const geofenceBreached = trailers.some(t => geofenceAlerts.has(t.site_id));

                // Attach cached weather data if available
                const cacheKey = `${js.latitude.toFixed(2)},${js.longitude.toFixed(2)}`;
                const weather = weatherCache.get(cacheKey);

                return {
                    id: js.id,
                    name: js.name,
                    address: js.address || null,
                    latitude: js.latitude,
                    longitude: js.longitude,
                    status: js.status,
                    is_headquarters: !!js.is_headquarters,
                    delivery_date: js.delivery_date || null,
                    active_date: js.active_date || null,
                    calloff_date: js.calloff_date || null,
                    pickup_date: js.pickup_date || null,
                    trailer_count: trailers.length,
                    trailers_online: trailersOnline,
                    avg_soc: socCount > 0 ? +(totalSoc / socCount).toFixed(1) : null,
                    worst_status: trailers.length === 0 ? 'unknown' : worstStatus,
                    geofence_radius_m: js.geofence_radius_m || 500,
                    geofence_breached: geofenceBreached,
                    weather: weather ? {
                        temperature: weather.temperature_current ?? null,
                        weather_code: weather.weather_code ?? null,
                        cloud_cover_pct: weather.cloud_cover_pct ?? null,
                        wind_speed_kmh: weather.wind_speed_kmh ?? null,
                        sunshine_hours: weather.sunshine_hours ?? null,
                        peak_sun_hours: weather.peak_sun_hours ?? null,
                    } : null,
                };
            });

        res.json({ success: true, markers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get all trailer GPS coordinates (DB + live IC2 cache)
app.get('/api/gps/trailers', async (req, res) => {
    try {
        const assignments = dbAvailable ? await getTrailerAssignments() : [];
        const trailers = assignments.map(a => {
            const live = gpsCache.get(a.site_id);
            const pepwave = getPepwaveForTrailer(a);
            return {
                site_id: a.site_id,
                site_name: a.site_name,
                ic2_device_id: a.ic2_device_id || null,
                job_site_id: a.job_site_id,
                manual_override: a.manual_override,
                db_latitude: a.latitude,
                db_longitude: a.longitude,
                live_latitude: live?.latitude || null,
                live_longitude: live?.longitude || null,
                ic2_latitude: pepwave?.latitude || null,
                ic2_longitude: pepwave?.longitude || null,
                ic2_online: pepwave?.online || false,
                gps_stale: live ? (Date.now() - live.updatedAt > 600000) : true, // >10 min = stale
            };
        });
        res.json({ success: true, trailers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Force refresh GPS from IC2 for all devices
app.post('/api/gps/refresh', requireRole('admin', 'technician'), async (req, res) => {
    try {
        if (!IC2_CLIENT_ID || !IC2_CLIENT_SECRET) {
            return res.status(400).json({ success: false, error: 'IC2 not configured' });
        }
        const vrmSites = sitesCache?.records || [];
        const result = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g/${IC2_GROUP_ID}/d?has_status=true`);
        const devices = result.data || [];
        const gpsDevices = devices.filter(d => d.gps_exist || d.gps_support);

        let updated = 0, failed = 0;
        for (let i = 0; i < gpsDevices.length; i += 5) {
            const batch = gpsDevices.slice(i, i + 5);
            const promises = batch.map(async (dev) => {
                try {
                    const locData = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g/${IC2_GROUP_ID}/d/${dev.id}/loc`);
                    const loc = (locData.data || [])[0];
                    if (loc && loc.la && loc.lo) {
                        const cached = pepwaveCache.get(dev.name);
                        if (cached) { cached.latitude = loc.la; cached.longitude = loc.lo; }

                        const { siteId, siteName } = resolveIc2DeviceToSiteId(dev, vrmSites);
                        gpsCache.set(siteId, { latitude: loc.la, longitude: loc.lo, updatedAt: Date.now() });

                        if (dbAvailable) {
                            await upsertTrailerAssignment(siteId, siteName, loc.la, loc.lo, null, dev.id);
                        }
                        updated++;
                    }
                } catch { failed++; }
            });
            await Promise.all(promises);
            if (i + 5 < gpsDevices.length) await new Promise(r => setTimeout(r, 500));
        }

        // Re-run clustering after GPS refresh
        if (dbAvailable && updated > 0) {
            try { await runClustering(); } catch (e) { /* non-critical */ }
        }

        // Clear stale geofence alerts — GPS positions have changed
        geofenceAlerts.clear();
        checkGeofences().catch(err => console.error('  Post-GPS-refresh geofence check failed:', err.message));

        res.json({ success: true, updated, failed, total_gps_devices: gpsDevices.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get unlinked IC2 devices (not yet bound to any trailer assignment)
app.get('/api/gps/unlinked-devices', async (req, res) => {
    try {
        const assignments = dbAvailable ? await getTrailerAssignments() : [];
        const linkedDeviceIds = new Set(assignments.filter(a => a.ic2_device_id).map(a => a.ic2_device_id));

        const unlinked = Array.from(pepwaveCache.values())
            .filter(dev => dev.id && !linkedDeviceIds.has(dev.id))
            .map(dev => ({ id: dev.id, name: dev.name, sn: dev.sn, online: dev.online }));

        res.json({ success: true, devices: unlinked });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Manually link an IC2 device to a trailer assignment
app.post('/api/gps/link-device', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { site_id, ic2_device_id } = req.body;
        if (!site_id || !ic2_device_id) {
            return res.status(400).json({ success: false, error: 'site_id and ic2_device_id required' });
        }
        if (!dbAvailable) {
            return res.status(500).json({ success: false, error: 'Database not available' });
        }

        const assignment = await linkIc2Device(site_id, ic2_device_id);
        if (!assignment) {
            return res.status(404).json({ success: false, error: 'Trailer assignment not found' });
        }

        // Update in-memory map
        ic2DeviceIdToSiteId.set(ic2_device_id, site_id);

        res.json({ success: true, assignment });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

}
