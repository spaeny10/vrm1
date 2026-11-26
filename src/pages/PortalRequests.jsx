import { useCallback } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { apiGet } from '../api/vrm'
import { Page, Card, Dot, Badge, Empty, Loading, Icon } from '../ui'
import { TICKET_STATUS, fmtAgo } from '../ui/format'
import ReportProblemModal from '../components/helpdesk/ReportProblemModal'

// Customer portal: everything this customer has asked BIGView to look at
export default function PortalRequests() {
    const navigate = useNavigate()
    const [params, setParams] = useSearchParams()
    const fetchFn = useCallback(() => apiGet('/portal/tickets'), [])
    const { data, loading } = useApiPolling(fetchFn, 30000)
    const tickets = data?.tickets || []
    const open = tickets.filter(t => t.status !== 'resolved')
    const done = tickets.filter(t => t.status === 'resolved')
    const reporting = params.get('new') === '1'

    return (
        <Page title="Requests" sub="Problems you’ve reported and where each one stands"
            actions={<button className="btn primary" onClick={() => setParams({ new: '1' })}><Icon name="plus" />Report a problem</button>}>
            <Card title="Open" meta={open.length || null} flush>
                {loading && !data ? <Loading /> : open.length === 0
                    ? <Empty compact>Nothing open. If something isn’t right on one of your sites, report it and we’ll take a look.</Empty>
                    : <RequestList tickets={open} />}
            </Card>
            {done.length > 0 && (
                <Card title="Resolved" meta={done.length} flush><RequestList tickets={done} /></Card>
            )}
            {reporting && (
                <ReportProblemModal
                    initial={{ siteId: params.get('site'), unit: params.get('unit') }}
                    onClose={() => setParams({}, { replace: true })}
                    onCreated={(t) => navigate(`/requests/${t.id}`, { replace: true })} />
            )}
        </Page>
    )
}

// The latest message, shortened; skipped when it only repeats the subject
function preview(t) {
    const m = (t.last_message || '').replace(/\s+/g, ' ').trim()
    if (!m || m === t.subject) return null
    return m.length > 110 ? m.slice(0, 109) + '…' : m
}

export function RequestList({ tickets }) {
    return (
        <div className="list">
            {tickets.map(t => {
                const st = TICKET_STATUS[t.status] || TICKET_STATUS.open
                return (
                    <Link key={t.id} to={`/requests/${t.id}`} className="list-row">
                        <Dot tone={t.unread ? 'info' : t.status === 'resolved' ? 'ok' : 'off'} />
                        <div className="main">
                            <div className="title">{t.subject}{t.unread && <Badge tone="info">New reply</Badge>}</div>
                            <div className="desc">{[t.trailer_unit, t.job_site_name].filter(Boolean).join(' · ') || '—'}</div>
                            {preview(t) && <div className="faint" style={{ fontSize: 12.5, marginTop: 2, overflowWrap: 'anywhere' }}>{preview(t)}</div>}
                        </div>
                        <div className="side" style={{ display: 'grid', gap: 5, justifyItems: 'end' }}>
                            <Badge tone={st.tone}>{st.customer}</Badge>
                            <span>{fmtAgo(t.updated_at)}</span>
                        </div>
                        <Icon name="chevron" />
                    </Link>
                )
            })}
        </div>
    )
}
