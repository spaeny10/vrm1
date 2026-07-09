import { getCustomerSiteAccess, getJobSite, getJobSites, getSiteContacts, getTrailerAssignments, getTrailersByJobSite, upsertCustomerSiteAccess } from '../db.js';
import { hasVrmData } from '../lib/util.js';
import { requireRole } from '../middleware/auth.js';
import { snapshotCache } from '../state.js';

export function registerPortalRoutes(app) {

// --- Customer Portal ---
app.get('/api/portal/sites', async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'customer') {
            return res.status(403).json({ error: 'Customer access only' });
        }
        const access = await getCustomerSiteAccess(req.user.id);
        const siteIds = access.map(a => a.job_site_id);
        if (siteIds.length === 0) return res.json({ sites: [] });

        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

        // Build a map of site_id -> job_site_id from trailer_assignments
        const trailerToJobSite = new Map();
        for (const a of assignments) {
            if (a.job_site_id != null) {
                trailerToJobSite.set(a.site_id, a.job_site_id);
            }
        }

        const sites = jobSites
            .filter(js => siteIds.includes(js.id))
            .map(js => {
                const trailers = [];
                // Find VRM-connected trailers assigned to this job site
                for (const [siteId, snap] of snapshotCache) {
                    if (trailerToJobSite.get(siteId) === js.id && hasVrmData(snap)) {
                        trailers.push({
                            site_id: siteId,
                            site_name: snap.site_name,
                            battery_soc: snap.battery_soc,
                            solar_watts: snap.solar_watts,
                            solar_yield_today: snap.solar_yield_today,
                        });
                    }
                }
                const onlineTrailers = trailers.filter(t => t.battery_soc != null);
                const avgSoc = onlineTrailers.length > 0
                    ? Math.round(onlineTrailers.reduce((s, t) => s + t.battery_soc, 0) / onlineTrailers.length)
                    : null;
                return {
                    id: js.id,
                    name: js.name,
                    status: js.status,
                    address: js.address,
                    trailer_count: trailers.length,
                    trailers_online: onlineTrailers.length,
                    avg_soc: avgSoc,
                    trailers,
                    worst_status: trailers.some(t => t.battery_soc != null && t.battery_soc < 20) ? 'critical'
                        : trailers.some(t => t.battery_soc != null && t.battery_soc < 50) ? 'warning' : 'ok',
                };
            });
        res.json({ sites });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/portal/site/:id', async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'customer') {
            return res.status(403).json({ error: 'Customer access only' });
        }
        const siteId = parseInt(req.params.id);
        const access = await getCustomerSiteAccess(req.user.id);
        if (!access.some(a => a.job_site_id === siteId)) {
            return res.status(403).json({ error: 'No access to this site' });
        }
        const js = await getJobSite(siteId);
        if (!js) return res.status(404).json({ error: 'Site not found' });

        const siteAssignments = await getTrailersByJobSite(siteId);
        const trailers = siteAssignments
            .filter(a => hasVrmData(snapshotCache.get(a.site_id)))
            .map(a => {
                const snap = snapshotCache.get(a.site_id);
                return {
                    site_id: a.site_id,
                    site_name: a.site_name,
                    battery_soc: snap?.battery_soc ?? null,
                    solar_watts: snap?.solar_watts ?? null,
                    solar_yield_today: snap?.solar_yield_today ?? null,
                };
            });
        const onlineTrailers = trailers.filter(t => t.battery_soc != null);
        const avgSoc = onlineTrailers.length > 0
            ? Math.round(onlineTrailers.reduce((s, t) => s + t.battery_soc, 0) / onlineTrailers.length)
            : null;

        // Source contact info from CRM instead of legacy job_sites columns
        const siteContacts = await getSiteContacts(siteId);
        const primaryContact = siteContacts.find(c => c.is_primary) || siteContacts[0];

        res.json({
            site: {
                ...js,
                primary_contact_name: primaryContact?.name || null,
                primary_contact_phone: primaryContact?.phone || null,
                trailer_count: trailers.length,
                trailers_online: onlineTrailers.length,
                avg_soc: avgSoc,
                trailers,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: manage customer site access
app.get('/api/customers/:userId/sites', requireRole('admin'), async (req, res) => {
    try {
        const access = await getCustomerSiteAccess(parseInt(req.params.userId));
        res.json({ sites: access.map(a => a.job_site_id) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/customers/:userId/sites', requireRole('admin'), async (req, res) => {
    try {
        const { site_ids } = req.body;
        if (!Array.isArray(site_ids)) return res.status(400).json({ error: 'site_ids must be an array' });
        await upsertCustomerSiteAccess(parseInt(req.params.userId), site_ids);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

}
