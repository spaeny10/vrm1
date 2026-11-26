// ============================================================
// Help desk rules. The state changes are pure functions so the
// behaviour is in one place and can be tested without a database:
//
//   new      nobody has picked it up
//   open     someone is working on it
//   waiting  we asked the customer something
//   resolved done; a customer reply reopens it
//
// awaiting_reply is separate from status: it is true whenever the
// last word in the conversation was the customer's.
// ============================================================
import { normalizeUnitName } from '../lib/util.js';

export const STATUSES = ['new', 'open', 'waiting', 'resolved'];
export const PRIORITIES = ['normal', 'urgent'];

// What moving a request to a status changes
export function applyStatus(ticket, status, now = Date.now()) {
    if (!STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
    const patch = { status, updated_at: now };
    if (status === 'resolved') {
        patch.resolved_at = ticket.status === 'resolved' && ticket.resolved_at ? ticket.resolved_at : now;
        patch.awaiting_reply = false;
    } else {
        patch.resolved_at = null;
    }
    return patch;
}

// What giving a request to someone (or no one) changes
export function applyAssignment(ticket, assigneeId, now = Date.now()) {
    const patch = { assignee_id: assigneeId ?? null, updated_at: now };
    // An owner means work has started; taking the owner away from untouched work puts it back in the queue
    if (assigneeId != null && ticket.status === 'new') patch.status = 'open';
    if (assigneeId == null && ticket.status === 'open' && !ticket.first_response_at) patch.status = 'new';
    return patch;
}

// What a new message changes.
//   from      'customer' | 'staff'
//   internal  a staff note the customer never sees
//   then      status the sender asked for after sending (staff only)
export function applyMessage(ticket, { from, internal = false, authorId = null, then = null, now = Date.now() }) {
    const patch = { updated_at: now };
    if (from === 'customer') {
        patch.awaiting_reply = true;
        // The customer answering, or writing again after we closed it, puts it back in front of a tech
        if (ticket.status === 'waiting' || ticket.status === 'resolved') {
            patch.status = ticket.assignee_id != null ? 'open' : 'new';
            patch.resolved_at = null;
        }
        return patch;
    }
    if (then && then !== ticket.status) Object.assign(patch, applyStatus(ticket, then, now));
    if (internal) return patch;   // a note doesn't answer the customer

    patch.awaiting_reply = false;
    patch.customer_unread = true;
    if (!ticket.first_response_at) patch.first_response_at = now;
    // Replying is picking it up
    if (ticket.assignee_id == null && authorId != null) patch.assignee_id = authorId;
    if (!patch.status && ticket.status === 'new') patch.status = 'open';
    return patch;
}

// Find the fleet board row a request is about. Telemetry ids and registry rows
// change over a trailer's life, so try every identity the request recorded.
export function findTrailerRow(rows, { trailer_id, site_id, trailer_unit }) {
    if (!rows?.length) return null;
    const name = trailer_unit ? normalizeUnitName(trailer_unit) : null;
    return (trailer_id != null && rows.find(r => r.trailer_id === trailer_id))
        || (site_id != null && rows.find(r => r.site_id === site_id || (r.site_ids || []).includes(site_id)))
        || (name && rows.find(r => normalizeUnitName(r.unit) === name))
        || null;
}

// The same lookup from whatever a page sends: a telemetry id or a board row key
export function findTrailerRowByRef(rows, ref) {
    if (ref == null || ref === '') return null;
    const s = String(ref);
    return rows.find(r => String(r.site_id) === s || r.key === s || (r.site_ids || []).some(id => String(id) === s)) || null;
}

// The few live facts a tech wants beside the conversation
export function trailerNow(row) {
    if (!row) return null;
    return {
        key: row.key, site_id: row.site_id, unit: row.unit, health: row.health, diagnosis: row.diagnosis,
        in_service: row.in_service, soc: row.soc, solar_w: row.solar_w, yield_today_kwh: row.yield_today_kwh,
        last_seen: row.last_seen, online: row.online, has_router: row.has_router, has_cerbo: row.has_cerbo,
        signal_bars: row.signal_bars, carrier: row.carrier,
        site: row.site ? { id: row.site.id, name: row.site.name } : null,
        customer: row.customer || null,
    };
}

// What a customer is allowed to see of a request
export function customerView(t) {
    return {
        id: t.id, subject: t.subject, status: t.status, source: t.source,
        job_site_id: t.job_site_id, job_site_name: t.job_site_name, trailer_unit: t.trailer_unit,
        requester_name: t.requester_name, created_at: t.created_at, updated_at: t.updated_at,
        resolved_at: t.resolved_at, unread: !!t.customer_unread, last_message: t.last_public_message || null,
    };
}
