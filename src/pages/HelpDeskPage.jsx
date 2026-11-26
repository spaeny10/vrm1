import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { apiGet } from '../api/vrm'
import { Page, Card, Tabs, Search, AllClear, Empty, Loading, Icon } from '../ui'
import TicketRow from '../components/helpdesk/TicketRow'
import NewRequestModal from '../components/helpdesk/NewRequestModal'

const EMPTY = {
    unassigned: 'Every open request has an owner.',
    mine: 'Nothing is assigned to you.',
    open: 'No open requests.',
    waiting: 'Nothing is waiting on a customer.',
}

// Help desk inbox: customer requests and trailer problems our team is working.
// The order is always the same: customers waiting on a reply first.
export default function HelpDeskPage() {
    const { user } = useAuth()
    const navigate = useNavigate()
    const [params, setParams] = useSearchParams()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const fetchFn = useCallback(() => apiGet('/tickets'), [])
    const { data, loading } = useApiPolling(fetchFn, 30000)
    const [q, setQ] = useState('')
    const tickets = data?.tickets || []

    const views = useMemo(() => {
        const open = tickets.filter(t => t.status !== 'resolved')
        return {
            unassigned: open.filter(t => t.assignee_id == null),
            mine: open.filter(t => t.assignee_id === user?.id),
            open,
            waiting: open.filter(t => t.status === 'waiting'),
            resolved: tickets.filter(t => t.status === 'resolved').sort((a, b) => (b.resolved_at || 0) - (a.resolved_at || 0)),
        }
    }, [tickets, user])

    // Land on the pile that needs someone: unowned requests, then your own
    const auto = views.unassigned.length ? 'unassigned' : views.mine.length ? 'mine' : 'open'
    const view = views[params.get('view')] ? params.get('view') : auto
    const setView = (k) => setParams(p => { const n = new URLSearchParams(p); n.set('view', k); return n }, { replace: true })

    const creating = params.get('new') === '1'
    const closeNew = () => setParams(p => { const n = new URLSearchParams(p); for (const k of ['new', 'trailer', 'subject', 'by']) n.delete(k); return n }, { replace: true })

    const shown = useMemo(() => {
        const needle = q.trim().toLowerCase()
        if (!needle) return views[view]
        return views[view].filter(t => [t.subject, t.trailer_unit, t.job_site_name, t.company_name, t.requester_name, t.assignee_name, `#${t.id}`]
            .some(v => v && String(v).toLowerCase().includes(needle)))
    }, [views, view, q])

    const waitingOnUs = views.open.filter(t => t.awaiting_reply).length

    return (
        <Page title="Help desk"
            sub={loading && !data ? 'Loading…' : views.open.length === 0 ? 'No open requests'
                : `${views.open.length} open${waitingOnUs ? ` · ${waitingOnUs} waiting for a reply from us` : ''}`}
            actions={canEdit && <button className="btn primary" onClick={() => setParams(p => { const n = new URLSearchParams(p); n.set('new', '1'); return n })}><Icon name="plus" />New request</button>}>
            <div>
                <Tabs value={view} onChange={setView} tabs={[
                    { key: 'unassigned', label: 'Unassigned', count: views.unassigned.length },
                    { key: 'mine', label: 'Mine', count: views.mine.length },
                    { key: 'open', label: 'All open', count: views.open.length },
                    { key: 'waiting', label: 'Waiting on customer', count: views.waiting.length },
                    { key: 'resolved', label: 'Resolved' },
                ]} />
                {(views[view].length > 6 || q) && <div className="toolbar"><Search value={q} onChange={setQ} placeholder="Search requests…" /></div>}
                <Card flush>
                    {loading && !data ? <Loading /> : shown.length === 0 ? (
                        q ? <Empty compact>No requests match “{q}”.</Empty>
                            : view === 'resolved' ? <Empty compact>Nothing resolved in the last 60 days.</Empty>
                                : <AllClear>{EMPTY[view]}</AllClear>
                    ) : (
                        <div className="list">{shown.map(t => <TicketRow key={t.id} t={t} />)}</div>
                    )}
                </Card>
            </div>
            {creating && (
                <NewRequestModal
                    initial={{ trailer: params.get('trailer'), subject: params.get('subject') || '', reportedBy: params.get('by') === 'team' ? 'team' : 'customer', source: params.get('by') === 'team' ? 'watch' : undefined }}
                    onClose={closeNew}
                    onCreated={(ticket) => navigate(`/helpdesk/${ticket.id}`, { replace: true })} />
            )}
        </Page>
    )
}

