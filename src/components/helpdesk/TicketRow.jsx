import { Link } from 'react-router-dom'
import { Dot, Badge, Icon } from '../../ui'
import { TICKET_STATUS, fmtAgo } from '../../ui/format'

// Red: a customer is waiting on us. Amber: nobody owns it yet.
export function ticketTone(t) {
    if (t.status === 'resolved') return 'ok'
    if (t.awaiting_reply) return 'crit'
    if (t.assignee_id == null) return 'warn'
    return t.status === 'waiting' ? 'off' : 'info'
}

// One request in a list, as the team sees it
export default function TicketRow({ t }) {
    const st = TICKET_STATUS[t.status] || TICKET_STATUS.open
    const open = t.status !== 'resolved'
    const where = [t.trailer_unit, t.job_site_name, t.company_name].filter(Boolean).join(' · ')
    const who = t.requester_name ? `${t.requester_name} · opened ${fmtAgo(t.created_at)}`
        : `Opened by ${t.created_by || 'our team'} ${fmtAgo(t.created_at)}`
    return (
        <Link to={`/helpdesk/${t.id}`} className="list-row">
            <Dot tone={ticketTone(t)} pulse={t.awaiting_reply && open} />
            <div className="main">
                <div className="title">
                    {t.subject}
                    {t.awaiting_reply && open && <Badge tone="crit">Needs a reply</Badge>}
                    {t.priority === 'urgent' && open && <Badge tone="warn">Urgent</Badge>}
                </div>
                <div className="desc">{where || 'No trailer or site'}</div>
                <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>{who}</div>
            </div>
            <div className="side" style={{ display: 'grid', gap: 5, justifyItems: 'end' }}>
                <Badge tone={st.tone}>{st.label}</Badge>
                <span>{t.assignee_name || (open ? 'Unassigned' : '')}</span>
            </div>
            <Icon name="chevron" />
        </Link>
    )
}
