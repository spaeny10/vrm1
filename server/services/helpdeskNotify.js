// ============================================================
// Who hears about what on the help desk. Every send here is
// fire-and-forget: a failed email must never fail the request.
// ============================================================
import { getHelpDeskStaff, insertNotification } from '../db.js';
import { helpDeskExtraRecipients, sendTicketEmail } from '../email.js';

const clip = (s, n = 140) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

const where = (t) => [t.trailer_unit, t.job_site_name, t.company_name].filter(Boolean).join(' · ');

const facts = (t) => [
    ['From', [t.requester_name, t.company_name].filter(Boolean).join(', ')],
    ['Site', t.job_site_name],
    ['Unit', t.trailer_unit],
    ['Phone', t.requester_phone],
];

async function tellStaff(staff, t, { title, body, emailSubject, heading, intro, quote, extraEmails = [] }) {
    const link = `/helpdesk/${t.id}`;
    await Promise.all(staff.map(u => insertNotification(u.id, 'ticket', title, body, link).catch(() => { })));
    sendTicketEmail({
        to: [...staff.map(u => u.email), ...extraEmails],
        subject: emailSubject, heading, intro, quote, facts: facts(t), path: link,
    }).catch(() => { });
}

// A customer raised a request: everyone who works the desk hears about it
export async function notifyNewRequest(t, text) {
    const staff = await getHelpDeskStaff();
    await tellStaff(staff, t, {
        title: `New request: ${clip(t.subject, 80)}`,
        body: [t.requester_name, where(t)].filter(Boolean).join(' — '),
        emailSubject: `[Help desk] New request #${t.id}: ${clip(t.subject, 80)}`,
        heading: t.subject,
        intro: `${t.requester_name || 'A customer'} opened a request${t.job_site_name ? ` for ${t.job_site_name}` : ''}.`,
        quote: text,
        extraEmails: helpDeskExtraRecipients(),
    });
}

// The customer wrote back: the owner hears about it, or everyone if nobody owns it
export async function notifyCustomerReplied(t, text) {
    const staff = await getHelpDeskStaff();
    const owner = staff.filter(u => u.id === t.assignee_id);
    await tellStaff(owner.length ? owner : staff, t, {
        title: `${t.requester_name || 'Customer'} replied: ${clip(t.subject, 60)}`,
        body: clip(text),
        emailSubject: `[Help desk] Reply on #${t.id}: ${clip(t.subject, 80)}`,
        heading: t.subject,
        intro: `${t.requester_name || 'The customer'} replied.`,
        quote: text,
    });
}

// Someone handed a request to a colleague
export async function notifyAssigned(t, assigneeId, byName) {
    const staff = await getHelpDeskStaff();
    const owner = staff.filter(u => u.id === assigneeId);
    if (!owner.length) return;
    await tellStaff(owner, t, {
        title: `Assigned to you: ${clip(t.subject, 70)}`,
        body: [byName && `From ${byName}`, where(t)].filter(Boolean).join(' — '),
        emailSubject: `[Help desk] Assigned to you #${t.id}: ${clip(t.subject, 80)}`,
        heading: t.subject,
        intro: `${byName || 'A colleague'} assigned this request to you.`,
    });
}

// We answered: the customer gets the reply by email (and sees it in the portal)
export function emailCustomerReply(t, text, authorName, { resolved = false } = {}) {
    if (!t.customer_visible || !t.requester_email) return;
    sendTicketEmail({
        to: t.requester_email,
        label: 'BIGView support',
        subject: `${resolved ? 'Resolved' : 'Update'}: ${clip(t.subject, 90)}`,
        heading: t.subject,
        intro: text
            ? `${authorName || 'The BIGView team'} replied to your request${resolved ? ' and marked it resolved' : ''}.`
            : `Your request has been marked resolved. ${t.requester_user_id ? 'Reply in the portal' : 'Contact us'} if it still needs attention.`,
        quote: text || null,
        facts: [['Site', t.job_site_name], ['Unit', t.trailer_unit]],
        path: t.requester_user_id ? `/requests/${t.id}` : null,
        cta: 'View and reply',
    }).catch(() => { });
}
