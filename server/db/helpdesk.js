// ============================================================
// Help desk storage: requests (tickets) and their message threads.
// ============================================================
import { pool } from './core.js';

const SELECT = `
    SELECT t.*, js.name AS job_site_name, c.name AS company_name, u.display_name AS assignee_name,
           (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id)::int AS message_count,
           (SELECT m.body FROM ticket_messages m
             WHERE m.ticket_id = t.id AND NOT m.internal AND m.author_role <> 'system'
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_public_message
      FROM tickets t
      LEFT JOIN job_sites js ON js.id = t.job_site_id
      LEFT JOIN companies c ON c.id = t.company_id
      LEFT JOIN users u ON u.id = t.assignee_id`;

// Unanswered customers first, then unassigned, then the most recently touched
const ORDER = `ORDER BY (t.status = 'resolved'), t.awaiting_reply DESC, (t.priority = 'urgent') DESC, t.updated_at DESC`;

const TICKET_FIELDS = [
    'subject', 'status', 'priority', 'source', 'customer_visible', 'job_site_id', 'company_id',
    'trailer_id', 'site_id', 'trailer_unit', 'requester_user_id', 'requester_name', 'requester_email',
    'requester_phone', 'assignee_id', 'maintenance_log_id', 'awaiting_reply', 'customer_unread',
    'created_by', 'first_response_at', 'resolved_at', 'updated_at',
];

export async function insertTicket(t) {
    if (!pool) return null;
    const now = t.created_at || Date.now();
    const row = { status: 'new', priority: 'normal', source: 'staff', ...t, updated_at: now };
    const cols = TICKET_FIELDS.filter(k => row[k] !== undefined);
    const result = await pool.query(
        `INSERT INTO tickets (${cols.join(', ')}, created_at)
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING id`,
        [...cols.map(k => row[k]), now]
    );
    return getTicket(result.rows[0].id);
}

export async function getTicket(id) {
    if (!pool) return null;
    const result = await pool.query(`${SELECT} WHERE t.id = $1`, [id]);
    return result.rows[0] || null;
}

// Open requests, plus ones resolved recently enough to still be looked up
export async function listTickets({ resolvedSince = Date.now() - 60 * 86400000, limit = 300 } = {}) {
    if (!pool) return [];
    const result = await pool.query(
        `${SELECT} WHERE t.status <> 'resolved' OR t.resolved_at >= $1 OR t.resolved_at IS NULL ${ORDER} LIMIT $2`,
        [resolvedSince, limit]
    );
    return result.rows;
}

// What a customer may see: requests they raised, and requests raised for them on their sites
export async function listTicketsForCustomer(userId, jobSiteIds = []) {
    if (!pool) return [];
    const result = await pool.query(
        `${SELECT} WHERE t.requester_user_id = $1 OR (t.customer_visible AND t.job_site_id = ANY($2::int[]))
         ORDER BY (t.status = 'resolved'), t.updated_at DESC LIMIT 200`,
        [userId, jobSiteIds]
    );
    return result.rows;
}

export async function updateTicket(id, patch) {
    if (!pool) return null;
    const cols = TICKET_FIELDS.filter(k => patch[k] !== undefined);
    if (cols.length === 0) return getTicket(id);
    if (!cols.includes('updated_at')) { cols.push('updated_at'); patch = { ...patch, updated_at: Date.now() }; }
    await pool.query(
        `UPDATE tickets SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [id, ...cols.map(k => patch[k])]
    );
    return getTicket(id);
}

export async function insertTicketMessage(ticketId, m) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO ticket_messages (ticket_id, author_user_id, author_name, author_role, body, internal, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [ticketId, m.author_user_id ?? null, m.author_name || null, m.author_role || 'staff', m.body, !!m.internal, m.created_at || Date.now()]
    );
    return result.rows[0];
}

export async function getTicketMessages(ticketId, { publicOnly = false } = {}) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM ticket_messages WHERE ticket_id = $1 ${publicOnly ? 'AND NOT internal' : ''} ORDER BY created_at ASC, id ASC`,
        [ticketId]
    );
    return result.rows;
}

export async function getTicketCounts(userId) {
    const empty = { open: 0, unassigned: 0, needs_reply: 0, needs_action: 0, mine: 0, waiting: 0 };
    if (!pool) return empty;
    const result = await pool.query(
        `SELECT COUNT(*)::int AS open,
                COUNT(*) FILTER (WHERE assignee_id IS NULL)::int AS unassigned,
                COUNT(*) FILTER (WHERE awaiting_reply)::int AS needs_reply,
                COUNT(*) FILTER (WHERE awaiting_reply OR assignee_id IS NULL)::int AS needs_action,
                COUNT(*) FILTER (WHERE assignee_id = $1)::int AS mine,
                COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting
           FROM tickets WHERE status <> 'resolved'`,
        [userId ?? -1]
    );
    return result.rows[0] || empty;
}

// The people who work requests: active admins and technicians
export async function getHelpDeskStaff() {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT id, display_name, email, role FROM users
          WHERE active IS NOT FALSE AND role IN ('admin', 'technician') ORDER BY display_name`
    );
    return result.rows;
}
