import {
    getCustomerSiteAccess, getJobSite, getJobSites, getSiteContacts,
    upsertCustomerSiteAccess, getCustomerVisibleNotes, insertSiteNote,
} from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { buildTrailerBoard } from '../services/board.js';

// Customer-facing trailer summary: charge and solar only, and offline units
// stay in the list (marked offline) rather than silently disappearing.
// Built from the fleet board, so customers see one row per physical trailer.
function portalTrailer(row) {
    return {
        site_id: row.site_id ?? row.key,
        site_name: row.unit,
        // A unit we have no telemetry for is "no live data", not "offline"
        monitored: row.health !== 'unknown',
        online: row.soc != null || row.online,
        battery_soc: row.soc,
        solar_watts: row.solar_w,
        solar_yield_today: row.yield_today_kwh,
    };
}

async function trailersBySite() {
    const bySite = new Map();
    for (const row of await buildTrailerBoard()) {
        if (!row.in_service || !row.site) continue;
        if (!bySite.has(row.site.id)) bySite.set(row.site.id, []);
        bySite.get(row.site.id).push(portalTrailer(row));
    }
    return bySite;
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
        trailers_monitored: trailers.filter(t => t.monitored !== false).length,
        avg_soc: avgSoc,
        worst_status: trailers.some(t => !t.online && t.monitored !== false) ? 'offline'
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
        const bySite = await trailersBySite();
        const sites = jobSites.map(js => {
            const trailers = bySite.get(js.id) || [];
            return { ...siteSummary(js, trailers), trailers };
        });
        res.json({ sites });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/portal/site/:id', customerOnly, requireSiteAccess, async (req, res) => {
    try {
        const js = await getJobSite(req.siteId);
        if (!js) return res.status(404).json({ error: 'Site not found' });
        const trailers = (await trailersBySite()).get(req.siteId) || [];
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
