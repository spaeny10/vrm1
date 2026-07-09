import express from 'express';
import { getAllSiteNotes, getAuditLog, getJobSiteByPhone, getUnreadNotificationCount, getUserNotifications, insertSiteNote, markAllNotificationsRead, markNotificationRead } from '../db.js';
import { requireRole } from '../middleware/auth.js';

// Validate Twilio request signature
function validateTwilioSignature(req) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return true; // Skip validation if token not configured

    const signature = req.headers['x-twilio-signature'];
    if (!signature) return false;

    // Build the full URL Twilio used
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const url = `${protocol}://${host}${req.originalUrl}`;

    // Sort POST params and append to URL
    const params = req.body || {};
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const key of sortedKeys) {
        data += key + params[key];
    }

    const computed = crypto
        .createHmac('sha1', authToken)
        .update(Buffer.from(data, 'utf-8'))
        .digest('base64');

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(computed)
    );
}

export function registerCommsRoutes(app) {

// GET all communications (admin only) — cross-site notes with filters
app.get('/api/communications', requireRole('admin'), async (req, res) => {
    try {
        const { site_id, author, search, date_from, date_to, limit, offset } = req.query;
        const result = await getAllSiteNotes({
            siteId: site_id ? parseInt(site_id) : undefined,
            author: author || undefined,
            search: search || undefined,
            dateFrom: date_from ? parseInt(date_from) : undefined,
            dateTo: date_to ? parseInt(date_to) : undefined,
            limit: limit ? parseInt(limit) : 100,
            offset: offset ? parseInt(offset) : 0,
        });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Notifications
// ============================================================
app.get('/api/notifications', async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const notifications = await getUserNotifications(userId);
        const unread = await getUnreadNotificationCount(userId);
        res.json({ success: true, notifications, unread_count: unread });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/notifications/:id/read', async (req, res) => {
    try {
        await markNotificationRead(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/notifications/read-all', async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        await markAllNotificationsRead(userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Audit Log API
// ============================================================
app.get('/api/audit-log', requireRole('admin'), async (req, res) => {
    try {
        const entityType = req.query.entity_type || null;
        const entityId = req.query.entity_id ? parseInt(req.query.entity_id) : null;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const result = await getAuditLog({ entityType, entityId, limit, offset });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/webhooks/twilio', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        // Validate Twilio signature
        if (!validateTwilioSignature(req)) {
            console.warn('[Twilio] Invalid signature — rejecting request');
            return res.status(403).send('Invalid signature');
        }

        const { From, Body } = req.body;
        if (!From || !Body) {
            return res.status(400).send('Missing From or Body');
        }

        // Find the job site associated with this phone number
        const site = await getJobSiteByPhone(From);
        if (site) {
            // Log the incoming SMS as a site note
            await insertSiteNote(site.id, `SMS received: ${Body}`, From);
            console.log(`[Twilio] Saved SMS from ${From} to job site ${site.name}`);
        } else {
            console.warn(`[Twilio] Received SMS from unknown number: ${From}`);
        }

        // Send a generic empty TwiML response so Twilio knows we received it
        res.set('Content-Type', 'text/xml');
        res.send('<Response></Response>');
    } catch (err) {
        console.error('Twilio webhook error:', err.message);
        res.status(500).send('Webhook parsing error');
    }
});

}
