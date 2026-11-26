// ============================================================
// Help desk: requests from customers (or logged for them, or
// opened by our own team about a trailer), worked by the techs.
//
//   /api/tickets/*          staff
//   /api/portal/tickets/*   the customer's own requests
// ============================================================
import {
    getCustomerSiteAccess, getHelpDeskStaff, getJobSite, getMaintenanceLog, getTicket, getTicketCounts,
    getTicketMessages, insertAuditLog, insertMaintenanceLog, insertTicket, insertTicketMessage,
    listTickets, listTicketsForCustomer, updateTicket,
} from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { buildTrailerBoard } from '../services/board.js';
import {
    PRIORITIES, STATUSES, applyAssignment, applyMessage, applyStatus, customerView,
    findTrailerRow, findTrailerRowByRef, trailerNow,
} from '../services/helpdesk.js';
import { emailCustomerReply, notifyAssigned, notifyCustomerReplied, notifyNewRequest } from '../services/helpdeskNotify.js';

const staffOnly = requireRole('admin', 'technician');
const MAX_SUBJECT = 160;
const MAX_BODY = 4000;

const text = (v, max) => String(v ?? '').trim().slice(0, max);
const actorOf = (req) => req.user?.display_name || req.user?.username || 'system';
const audit = (id, action, details, actor) => insertAuditLog('ticket', id, action, details, actor).catch(() => { });

function customerOnly(req, res, next) {
    if (!req.user || req.user.role !== 'customer') return res.status(403).json({ error: 'Customer access only' });
    next();
}

// A portal login is the customer's email address
function emailOf(user) {
    if (user?.email) return user.email;
    return /^[^@\s]+@[^@\s]+$/.test(user?.username || '') ? user.username : null;
}

async function customerSiteIds(req) {
    return (await getCustomerSiteAccess(req.user.id)).map(a => a.job_site_id);
}

function customerCanSee(ticket, userId, siteIds) {
    return ticket.requester_user_id === userId || (ticket.customer_visible && siteIds.includes(ticket.job_site_id));
}

function systemLine(ticketId, body, internal = true) {
    return insertTicketMessage(ticketId, { author_role: 'system', author_name: 'System', body, internal });
}

export function registerHelpDeskRoutes(app) {

// ---------------- Staff ----------------

app.get('/api/tickets', async (req, res) => {
    try {
        const [tickets, counts] = await Promise.all([listTickets(), getTicketCounts(req.user.id)]);
        res.json({ tickets, counts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tickets/counts', async (req, res) => {
    try {
        res.json({ counts: await getTicketCounts(req.user.id) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Who a request can be assigned to
app.get('/api/tickets/staff', async (req, res) => {
    try {
        res.json({ staff: (await getHelpDeskStaff()).map(u => ({ id: u.id, display_name: u.display_name })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tickets/:id', async (req, res) => {
    try {
        const ticket = await getTicket(parseInt(req.params.id));
        if (!ticket) return res.status(404).json({ error: 'Request not found' });
        const [messages, rows, visit] = await Promise.all([
            getTicketMessages(ticket.id),
            buildTrailerBoard(),
            ticket.maintenance_log_id ? getMaintenanceLog(ticket.maintenance_log_id) : null,
        ]);
        res.json({ ticket, messages, trailer_now: trailerNow(findTrailerRow(rows, ticket)), visit: visit || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Log a request: for a customer who called or emailed, or about a trailer we spotted ourselves
app.post('/api/tickets', staffOnly, async (req, res) => {
    try {
        const b = req.body || {};
        const subject = text(b.subject, MAX_SUBJECT);
        if (!subject) return res.status(400).json({ error: 'Say what the problem is' });
        const forCustomer = b.reported_by === 'customer';
        if (b.priority && !PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'Unknown priority' });

        const row = findTrailerRowByRef(await buildTrailerBoard(), b.trailer);
        if (b.trailer != null && b.trailer !== '' && !row) return res.status(400).json({ error: 'That trailer is no longer on the fleet list' });
        const jobSiteId = b.job_site_id ? parseInt(b.job_site_id) : row?.site?.id ?? null;
        const site = jobSiteId ? await getJobSite(jobSiteId) : null;
        if (jobSiteId && !site) return res.status(400).json({ error: 'Site not found' });

        const assignee = b.assign_to_me ? req.user.id : b.assignee_id ? parseInt(b.assignee_id) : null;
        const ticket = await insertTicket({
            subject,
            status: assignee ? 'open' : 'new',
            priority: b.priority || 'normal',
            source: b.source === 'watch' ? 'watch' : 'staff',
            customer_visible: forCustomer,
            job_site_id: jobSiteId,
            company_id: site?.company_id ?? row?.customer?.id ?? null,
            trailer_id: row?.trailer_id ?? null,
            site_id: row?.site_id ?? null,
            trailer_unit: row?.unit ?? null,
            requester_name: forCustomer ? text(b.requester_name, 120) || null : null,
            requester_email: forCustomer ? text(b.requester_email, 200).toLowerCase() || null : null,
            requester_phone: forCustomer ? text(b.requester_phone, 40) || null : null,
            assignee_id: assignee,
            created_by: actorOf(req),
        });
        // What staff write down about a call stays internal; the customer sees the subject
        const details = text(b.body, MAX_BODY);
        if (details) {
            await insertTicketMessage(ticket.id, { author_user_id: req.user.id, author_name: actorOf(req), author_role: 'staff', body: details, internal: true });
        }
        audit(ticket.id, 'ticket_created', { subject, source: ticket.source, for_customer: forCustomer }, actorOf(req));
        if (assignee && assignee !== req.user.id) notifyAssigned(ticket, assignee, actorOf(req)).catch(() => { });
        res.status(201).json({ ticket });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Change status, owner, priority or subject
app.put('/api/tickets/:id', staffOnly, async (req, res) => {
    try {
        const ticket = await getTicket(parseInt(req.params.id));
        if (!ticket) return res.status(404).json({ error: 'Request not found' });
        const b = req.body || {};
        const actor = actorOf(req);
        let patch = {};
        const lines = [];
        let resolvedNow = false;
        let assignedTo = null;

        if (b.assignee_id !== undefined) {
            const next = b.assignee_id === null || b.assignee_id === '' ? null : parseInt(b.assignee_id);
            if (next !== ticket.assignee_id) {
                const staff = await getHelpDeskStaff();
                const person = next == null ? null : staff.find(u => u.id === next);
                if (next != null && !person) return res.status(400).json({ error: 'That person can’t be assigned requests' });
                Object.assign(patch, applyAssignment({ ...ticket, ...patch }, next));
                lines.push([person ? `${actor} assigned this to ${person.id === req.user.id ? 'themselves' : person.display_name}` : `${actor} unassigned this`, true]);
                if (person && person.id !== req.user.id) assignedTo = person.id;
            }
        }
        if (b.status !== undefined && b.status !== (patch.status ?? ticket.status)) {
            if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status' });
            Object.assign(patch, applyStatus({ ...ticket, ...patch }, b.status));
            if (b.status === 'resolved') { resolvedNow = true; lines.push([`Marked resolved by ${actor}`, false]); }
            else if (ticket.status === 'resolved') lines.push([`Reopened by ${actor}`, false]);
        }
        if (b.priority !== undefined && b.priority !== ticket.priority) {
            if (!PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'Unknown priority' });
            patch.priority = b.priority;
        }
        if (b.subject !== undefined) {
            const subject = text(b.subject, MAX_SUBJECT);
            if (!subject) return res.status(400).json({ error: 'The subject can’t be empty' });
            patch.subject = subject;
        }

        const updated = await updateTicket(ticket.id, patch);
        for (const [body, internal] of lines) await systemLine(ticket.id, body, internal || !ticket.customer_visible);
        if (Object.keys(patch).length) audit(ticket.id, 'ticket_updated', patch, actor);
        if (assignedTo) notifyAssigned(updated, assignedTo, actor).catch(() => { });
        if (resolvedNow) emailCustomerReply(updated, null, actor, { resolved: true });
        res.json({ ticket: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reply to the customer, or leave a note for the team
app.post('/api/tickets/:id/messages', staffOnly, async (req, res) => {
    try {
        const ticket = await getTicket(parseInt(req.params.id));
        if (!ticket) return res.status(404).json({ error: 'Request not found' });
        const body = text(req.body?.body, MAX_BODY);
        if (!body) return res.status(400).json({ error: 'Write a message first' });
        const then = req.body?.then || null;
        if (then && !STATUSES.includes(then)) return res.status(400).json({ error: 'Unknown status' });
        // A request the customer can't see has nobody to reply to
        const internal = !!req.body?.internal || !ticket.customer_visible;
        const actor = actorOf(req);

        const message = await insertTicketMessage(ticket.id, { author_user_id: req.user.id, author_name: actor, author_role: 'staff', body, internal });
        const patch = applyMessage(ticket, { from: 'staff', internal, authorId: req.user.id, then });
        const updated = await updateTicket(ticket.id, patch);
        const resolvedNow = patch.status === 'resolved';
        if (resolvedNow) await systemLine(ticket.id, `Marked resolved by ${actor}`, !ticket.customer_visible);
        if (!internal) emailCustomerReply(updated, body, actor, { resolved: resolvedNow });
        else if (resolvedNow) emailCustomerReply(updated, null, actor, { resolved: true });
        res.status(201).json({ ticket: updated, message });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Turn a request into a field service visit, linked both ways
app.post('/api/tickets/:id/visit', staffOnly, async (req, res) => {
    try {
        const ticket = await getTicket(parseInt(req.params.id));
        if (!ticket) return res.status(404).json({ error: 'Request not found' });
        if (ticket.maintenance_log_id) {
            const existing = await getMaintenanceLog(ticket.maintenance_log_id);
            if (existing && existing.status !== 'cancelled') return res.status(409).json({ error: 'A visit is already scheduled for this request' });
        }
        const b = req.body || {};
        const when = b.scheduled_date ? Number(b.scheduled_date) : null;
        if (b.scheduled_date && !Number.isFinite(when)) return res.status(400).json({ error: 'That date isn’t valid' });
        const staff = await getHelpDeskStaff();
        const tech = b.assigned_technician_id ? staff.find(u => u.id === parseInt(b.assigned_technician_id)) : null;
        const actor = actorOf(req);
        const notes = text(b.description, MAX_BODY);

        const log = await insertMaintenanceLog({
            job_site_id: ticket.job_site_id,
            site_id: ticket.site_id,
            visit_type: b.visit_type === 'inspection' ? 'inspection' : 'repair',
            status: 'scheduled',
            title: text(b.title, MAX_SUBJECT) || ticket.subject,
            description: [`From help desk request #${ticket.id}${ticket.requester_name ? ` (${ticket.requester_name})` : ''}.`, notes].filter(Boolean).join('\n\n'),
            technician: tech?.display_name || null,
            assigned_technician_id: tech?.id || null,
            scheduled_date: when,
        });
        const updated = await updateTicket(ticket.id, { maintenance_log_id: log.id, ...(ticket.status === 'new' ? { status: 'open' } : {}) });
        const day = when ? new Date(when).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
        await systemLine(ticket.id, `${actor} scheduled a field visit${day ? ` for ${day}` : ''}${tech ? ` with ${tech.display_name}` : ''}`);
        audit(ticket.id, 'ticket_visit_scheduled', { maintenance_log_id: log.id }, actor);
        res.status(201).json({ ticket: updated, visit: log });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------------- Customer portal ----------------

app.get('/api/portal/tickets', customerOnly, async (req, res) => {
    try {
        const tickets = await listTicketsForCustomer(req.user.id, await customerSiteIds(req));
        res.json({ tickets: tickets.map(customerView) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/portal/tickets', customerOnly, async (req, res) => {
    try {
        const b = req.body || {};
        const subject = text(b.subject, MAX_SUBJECT);
        const body = text(b.body, MAX_BODY);
        if (!subject) return res.status(400).json({ error: 'Tell us briefly what the problem is' });
        const jobSiteId = parseInt(b.job_site_id);
        if (!(await customerSiteIds(req)).includes(jobSiteId)) return res.status(403).json({ error: 'No access to this site' });
        const site = await getJobSite(jobSiteId);
        if (!site) return res.status(404).json({ error: 'Site not found' });

        // The unit must be one of theirs: in service on the site they picked
        let row = null;
        if (b.trailer != null && b.trailer !== '') {
            row = findTrailerRowByRef(await buildTrailerBoard(), b.trailer);
            if (!row || !row.in_service || row.site?.id !== jobSiteId) return res.status(400).json({ error: 'That unit isn’t on this site' });
        }

        const ticket = await insertTicket({
            subject,
            source: 'portal',
            customer_visible: true,
            job_site_id: jobSiteId,
            company_id: site.company_id ?? null,
            trailer_id: row?.trailer_id ?? null,
            site_id: row?.site_id ?? null,
            trailer_unit: row?.unit ?? null,
            requester_user_id: req.user.id,
            requester_name: req.user.display_name,
            requester_email: emailOf(req.user),
            awaiting_reply: true,
            created_by: req.user.display_name,
        });
        await insertTicketMessage(ticket.id, { author_user_id: req.user.id, author_name: req.user.display_name, author_role: 'customer', body: body || subject });
        audit(ticket.id, 'ticket_created', { subject, source: 'portal' }, req.user.display_name);
        notifyNewRequest(ticket, body || subject).catch(() => { });
        res.status(201).json({ ticket: customerView(ticket) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/portal/tickets/:id', customerOnly, async (req, res) => {
    try {
        const ticket = await getTicket(parseInt(req.params.id));
        // Same answer whether it doesn't exist or isn't theirs
        if (!ticket || !customerCanSee(ticket, req.user.id, await customerSiteIds(req))) return res.status(404).json({ error: 'Request not found' });
        const messages = await getTicketMessages(ticket.id, { publicOnly: true });
        // Opening it is reading it. updated_at is left alone so the desk's ordering doesn't move.
        if (ticket.customer_unread) await updateTicket(ticket.id, { customer_unread: false, updated_at: ticket.updated_at });
        res.json({
            ticket: { ...customerView(ticket), unread: false },
            messages: messages.map(m => ({ id: m.id, author: m.author_role === 'staff' ? `${m.author_name} · BIGView` : m.author_name, role: m.author_role, body: m.body, created_at: m.created_at })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/portal/tickets/:id/messages', customerOnly, async (req, res) => {
    try {
        const ticket = await getTicket(parseInt(req.params.id));
        if (!ticket || !customerCanSee(ticket, req.user.id, await customerSiteIds(req))) return res.status(404).json({ error: 'Request not found' });
        const body = text(req.body?.body, MAX_BODY);
        if (!body) return res.status(400).json({ error: 'Write a message first' });
        const reopened = ticket.status === 'resolved';
        await insertTicketMessage(ticket.id, { author_user_id: req.user.id, author_name: req.user.display_name, author_role: 'customer', body });
        const updated = await updateTicket(ticket.id, applyMessage(ticket, { from: 'customer' }));
        if (reopened) await systemLine(ticket.id, 'Reopened by a customer reply', false);
        notifyCustomerReplied(updated, body).catch(() => { });
        res.status(201).json({ ticket: customerView(updated) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

}
