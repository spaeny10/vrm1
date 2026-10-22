import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../components/AuthProvider'
import { fetchBoardTrailers, fetchRentals, fetchActionQueue, approveGpsChange, rejectGpsChange, apiGet } from '../api/vrm'
import { Page, Card, Stats, Stat, Dot, Badge, HealthBadge, AllClear, Loading, Icon } from '../ui'
import { HEALTH, fmtDate, fmtDateShort, daysSince, plural } from '../ui/format'
import { RentalActionButtons, useRentalEventFlow } from '../components/RentalLifecycle'

// Fleet workspace home: what has to move, what needs a decision, and
// which trailers need someone on site.
export default function FleetHome() {
    const navigate = useNavigate()
    const toast = useToast()
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'

    const boardFn = useCallback(() => fetchBoardTrailers(), [])
    const rentalsFn = useCallback(() => fetchRentals({ open: 1 }), [])
    const queueFn = useCallback(() => fetchActionQueue(), [])
    const maintFn = useCallback(() => apiGet('/maintenance'), [])
    const { data: board } = useApiPolling(boardFn, 60000)
    const { data: rentalsData, loading: rentalsLoading, refetch: refetchRentals } = useApiPolling(rentalsFn, 60000)
    const { data: queue, refetch: refetchQueue } = useApiPolling(queueFn, 60000)
    const { data: maint } = useApiPolling(maintFn, 120000)

    const flow = useRentalEventFlow(() => { refetchRentals() })
    const rows = board?.trailers || []
    const rentals = rentalsData?.rentals || []

    const moves = useMemo(() => ({
        deliveries: rentals.filter(r => r.status === 'reserved'),
        pickups: rentals.filter(r => (r.status === 'called_off' || r.status === 'awaiting_pickup') && !r.picked_up_at),
        transit: rentals.filter(r => r.status === 'awaiting_pickup' && r.picked_up_at),
    }), [rentals])

    const decisions = (queue?.actions || []).filter(a => a.category === 'location' && !a.acknowledged)
    const siteVisits = rows.filter(r => r.health === 'offline' || r.health === 'attention')

    const now = Date.now()
    const service = (maint?.logs || [])
        .filter(m => m.status === 'in_progress' || (m.status === 'scheduled' && m.scheduled_date && m.scheduled_date <= now + 7 * 86400000))
        .sort((a, b) => (a.scheduled_date || 0) - (b.scheduled_date || 0))

    const kpi = useMemo(() => ({
        onRent: rows.filter(r => r.rental && ['billing', 'called_off', 'delivered'].includes(r.rental.status) && !r.rental.picked_up_at).length,
        available: rows.filter(r => r.asset_status === 'available').length,
        movesDue: moves.deliveries.length + moves.pickups.length,
    }), [rows, moves])

    const [resolving, setResolving] = useState(null)
    const resolve = async (a, approve) => {
        let name = null
        if (approve && a.suggestion_type === 'create_new') {
            name = prompt('No existing site is nearby. Name for the new job site:')
            if (!name) return
        }
        setResolving(a.key)
        try {
            if (approve) await approveGpsChange(a.suggestion_id, name)
            else await rejectGpsChange(a.suggestion_id)
            toast.success(approve ? 'Relocation approved' : 'Relocation dismissed')
            refetchQueue()
        } catch (err) { toast.error(err.message) } finally { setResolving(null) }
    }

    return (
        <Page title="Fleet operations" sub="Moves, decisions, and site visits for today">
            <Stats>
                <Stat label="On rent" value={board ? kpi.onRent : '—'} hint="Delivered to customer sites" />
                <Stat label="Available" value={board ? kpi.available : '—'} hint="Ready to deploy" dot="ok" />
                <Stat label="Moves due" value={rentalsData ? kpi.movesDue : '—'} hint={`${moves.deliveries.length} deliver · ${moves.pickups.length} pick up`} tone={kpi.movesDue ? 'warn' : null} />
                <Stat label="Need a site visit" value={board ? siteVisits.length : '—'} tone={siteVisits.length ? 'crit' : null} onClick={() => navigate('/trailers?health=attention')} />
            </Stats>

            <Card title="Moves" meta={rentalsData ? `${moves.deliveries.length + moves.pickups.length + moves.transit.length} open` : null} flush>
                {rentalsLoading && !rentalsData ? <Loading /> : (
                    <div className="grid-3" style={{ gap: 0 }}>
                        <MoveColumn title="Deliveries due" empty="Nothing waiting to go out." items={moves.deliveries}
                            when={r => `Reserved ${fmtDateShort(r.reserved_at)}`} onAction={flow.start} canEdit={canEdit} />
                        <MoveColumn title="Pickups due" empty="No call-offs waiting." items={moves.pickups}
                            when={r => r.calloff_at ? `Called off ${fmtDateShort(r.calloff_at)}` : 'Billing stopped'} onAction={flow.start} canEdit={canEdit} />
                        <MoveColumn title="In transit" empty="Nothing on the road." items={moves.transit}
                            when={r => `Picked up ${fmtDateShort(r.picked_up_at)}`} onAction={flow.start} canEdit={canEdit} last />
                    </div>
                )}
            </Card>

            <div className="grid-2">
                <Card title="Decisions" meta={decisions.length || null} flush>
                    {decisions.length === 0 ? <AllClear>No relocations or geofence breaches to review.</AllClear> : (
                        <div className="list">
                            {decisions.map(a => (
                                <div key={a.key} className="list-row">
                                    <Dot tone={a.severity === 'critical' ? 'crit' : 'warn'} />
                                    <div className="main">
                                        <div className="title">{a.title}</div>
                                        <div className="desc">{a.subtitle}{a.details ? ` — ${a.details}` : ''}</div>
                                    </div>
                                    {a.suggestion_id && canEdit && (
                                        <span className="btn-row">
                                            <button className="btn sm primary" disabled={resolving === a.key} onClick={() => resolve(a, true)}>Approve</button>
                                            <button className="btn sm ghost" disabled={resolving === a.key} onClick={() => resolve(a, false)}>Dismiss</button>
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </Card>

                <Card title="Field service this week" meta={service.length || null} flush
                    actions={<Link to="/maintenance" className="btn sm ghost">All service <Icon name="chevron" /></Link>}>
                    {service.length === 0 ? <AllClear>No service due in the next 7 days.</AllClear> : (
                        <div className="list">
                            {service.slice(0, 8).map(m => {
                                const overdue = m.status === 'scheduled' && m.scheduled_date < now - 86400000
                                return (
                                    <Link key={m.id} to="/maintenance" className="list-row">
                                        <Dot tone={overdue ? 'crit' : m.status === 'in_progress' ? 'info' : 'warn'} />
                                        <div className="main">
                                            <div className="title">{m.title}</div>
                                            <div className="desc">{[m.trailer_name, m.job_site_name].filter(Boolean).join(' · ')}</div>
                                        </div>
                                        <div className="side">
                                            {m.status === 'in_progress' ? <Badge tone="info">In progress</Badge>
                                                : overdue ? <Badge tone="crit">Overdue</Badge> : fmtDate(m.scheduled_date, { year: false })}
                                        </div>
                                    </Link>
                                )
                            })}
                        </div>
                    )}
                </Card>
            </div>

            <Card title="Trailers needing a site visit" meta={siteVisits.length || null} flush>
                {siteVisits.length === 0 ? <AllClear>Every trailer is reporting normally.</AllClear> : (
                    <div className="list">
                        {siteVisits.map(r => (
                            <Link key={r.key} to={r.site_id != null ? `/trailer/${r.site_id}` : '/trailers'} className="list-row">
                                <Dot tone={HEALTH[r.health]?.tone} />
                                <div className="main">
                                    <div className="title">{r.unit} <HealthBadge health={r.health} /></div>
                                    <div className="desc">{r.diagnosis}</div>
                                </div>
                                <div className="side">{r.site?.name || 'Unassigned'}<br />{r.customer?.name}</div>
                            </Link>
                        ))}
                    </div>
                )}
            </Card>
            {flow.modal}
        </Page>
    )
}

function MoveColumn({ title, empty, items, when, onAction, canEdit, last }) {
    return (
        <div style={{ borderRight: last ? 0 : '1px solid var(--border)', minWidth: 0 }}>
            <div style={{ padding: '12px 18px 6px', fontSize: 12, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                {title} {items.length > 0 && <span className="badge plain" style={{ marginLeft: 4 }}>{items.length}</span>}
            </div>
            {items.length === 0 ? <div className="faint" style={{ padding: '6px 18px 18px', fontSize: 13 }}>{empty}</div> : items.map(r => {
                const age = daysSince(r.calloff_at || r.reserved_at)
                return (
                    <div key={r.id} style={{ padding: '10px 18px', borderTop: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <Link to={r.vrm_site_id ? `/trailer/${r.vrm_site_id}` : '/trailers'} style={{ fontWeight: 600 }}>{r.unit_number}</Link>
                            <span className="faint" style={{ fontSize: 12.5 }}>{when(r)}{age > 2 ? ` · ${plural(age, 'day')}` : ''}</span>
                        </div>
                        <div className="muted" style={{ fontSize: 13, margin: '2px 0 8px' }}>
                            {r.job_site_id ? <Link to={`/site/${r.job_site_id}`} className="link">{r.job_site_name}</Link> : 'No site'}{r.company_name ? ` · ${r.company_name}` : ''}
                        </div>
                        {canEdit && <RentalActionButtons rental={r} onAction={onAction} align="start" />}
                    </div>
                )
            })}
        </div>
    )
}
