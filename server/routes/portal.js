import {
    getCustomerSiteAccess, getJobSite, getJobSites, getSiteContacts, getTrailersByJobSite,
    upsertCustomerSiteAccess, getCustomerVisibleNotes, insertSiteNote,
} from '../db.js';
import { hasVrmData, getPepwaveForTrailer } from '../lib/util.js';
import { requireRole } from '../middleware/auth.js';
import { snapshotCache } from '../state.js';

// Customer-facing trailer summary: charge and solar only, and offline units
// stay in the list (marked offline) rather than silently disappearing
function portalTrailer(assignment) {
    const snap = snapshotCache.get(assignment.site_id);
    const live = hasVrmData(snap);
    const pw = getPepwaveForTrailer(assignment);
    return {
        site_id: assignment.site_id,
        site_name: assignment.site_name,
        online: live || !!pw?.online,
        battery_soc: live ? snap.battery_soc : null,
        solar_watts: live ? snap.solar_watts : null,
        solar_yield_today: live ? snap.solar_yield_today : null,
    };
}

function siteSummary(js, trailers) {
    const withSoc = trailers.filter(t => t.battery_soc != null);
    const avgSoc = withSoc.length ? Math.round(withSoc.reduce((s, t) => s + t.battery_soc, 0) / withSoc.length) : null;
    return {
        id: js.id,
        uid: js.uid,
        name: js.name,
        status: js.status,
        address: js.address,
        trailer_count: trailers.length,
        trailers_online: trailers.filter(t => t.online).length,
        avg_soc: avgSoc,
        worst_status: trailers.some(t => !t.online) ? 'offline'
            : trailers.some(t => t.battery_soc != null && t.battery_soc < 20) ? 'critical'
            : trailers.some(t => t.battery_soc != null && t.battery_soc < 50) ? 'warning' : 'ok',
    };
}

async function customerSiteIds(req) {
    const access = await getCustomerSiteAccess(req.user.id);
    return access.map(a => a.job_site_id);
}

function customerOnly(req, res, next) {
    if (!req.user || req.user.role !== 'customer') {
        return res.status(403).json({ error: 'Customer access only' });
    }
    next();
}

async function requireSiteAccess(req, res, next) {
    const siteId = parseInt(req.params.id);
    const ids = await customerSiteIds(req);
    if (!ids.includes(siteId)) return res.status(403).json({ error: 'No access to this site' });
    req.siteId = siteId;
    next();
}

export function registerPortalRoutes(app) {

// --- Customer Portal ---
app.get('/api/portal/sites', customerOnly, async (req, res) => {
    try {
        const siteIds = await customerSiteIds(req);
        if (siteIds.length === 0) return res.json({ sites: [] });
        const jobSites = (await getJobSites()).filter(js => siteIds.includes(js.id));
        const sites = await Promise.all(jobSites.map(async js => {
            const trailers = (await getTrailersByJobSite(js.id)).map(portalTrailer);
            return { ...siteSummary(js, trailers), trailers };
        }));
        res.json({ sites });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/portal/site/:id', customerOnly, requireSiteAccess, async (req, res) => {
    try {
        const js = await getJobSite(req.siteId);
        if (!js) return res.status(404).json({ error: 'Site not found' });
        const trailers = (await getTrailersByJobSite(req.siteId)).map(portalTrailer);
        const siteContacts = await getSiteContacts(req.siteId);
        const primaryContact = siteContacts.find(c => c.is_primary) || siteContacts[0];
        res.json({
            site: {
                ...siteSummary(js, trailers),
                primary_contact_name: primaryContact?.name || null,
                primary_contact_phone: primaryContact?.phone || null,
                trailers,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Shared message thread: customers see only notes shared with them
app.get('/api/portal/site/:id/notes', customerOnly, requireSiteAccess, async (req, res) => {
    try {
        res.json({ notes: await getCustomerVisibleNotes(req.siteId) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/portal/site/:id/notes', customerOnly, requireSiteAccess, async (req, res) => {
    try {
        const note = String(req.body.note || '').trim();
        if (!note) return res.status(400).json({ error: 'Message is required' });
        if (note.length > 4000) return res.status(400).json({ error: 'Message is too long' });
        const created = await insertSiteNote(req.siteId, note, req.user.display_name, [], null, [], true);
        res.status(201).json({ note: { id: created.id, note: created.note, author: created.author, created_at: created.created_at } });
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
