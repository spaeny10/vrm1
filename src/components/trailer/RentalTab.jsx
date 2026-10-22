import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiPolling } from '../../hooks/useApiPolling'
import { fetchRentals, fetchRental } from '../../api/vrm'
import { Card, KV, Empty, Loading, Icon } from '../../ui'
import { fmtDate, fmtMoney, plural } from '../../ui/format'
import {
    RentalStatusBadge, TrailerStatusBadge, RentalActionButtons, useRentalEventFlow, pricingLabel, TERM_LABELS, EVENT_LABELS,
} from '../RentalLifecycle'

const EVENT_TONE = { reserved: 'info', deliver: 'info', start_billing: 'ok', calloff: 'warn', stop_billing: 'warn', pickup: 'info', return: 'ok', cancel: 'crit' }

// Rental: the unit's open rental, lifecycle actions for the workspace
// that owns them, and the event history. Tech never sees dollar amounts.
export default function RentalTab({ siteId, row, workspace, role, onChanged }) {
    const isTech = workspace === 'tech'
    const filters = siteId > 0 ? { vrm_site_id: siteId, open: 1 } : row?.trailer_id ? { trailer_id: row.trailer_id, open: 1 } : null
    const fn = useCallback(() => (filters ? fetchRentals(filters) : Promise.resolve({ rentals: [] })), [JSON.stringify(filters)])
    const { data, loading, error, refetch } = useApiPolling(fn, 120000)
    const flow = useRentalEventFlow(() => { refetch(); onChanged?.() })
    const rental = (data?.rentals || [])[0] || null
    const showRentalsLink = role === 'admin' || workspace === 'billing'

    if (loading && !data) return <Card><Loading /></Card>
    if (error && !data) return <Card><Empty compact title="Couldn't load the rental">{error}</Empty></Card>

    if (!rental) {
        return (
            <Card>
                <Empty title="Not on rent">
                    <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
                        <span>This unit has no open rental.{row?.asset_status ? <> Asset status: <TrailerStatusBadge status={row.asset_status} /></> : null}</span>
                        {showRentalsLink && <Link to="/rentals" className="link">Go to rentals</Link>}
                    </div>
                </Empty>
            </Card>
        )
    }

    const items = [
        ['Status', <RentalStatusBadge key="s" status={rental.status} />],
        ['Customer', rental.company_name || '—'],
        ['Site', rental.job_site_id ? <Link to={`/site/${rental.job_site_id}`} className="link">{rental.job_site_name}</Link> : rental.job_site_name || '—'],
        ['PO number', rental.po_number || '—'],
        ['Term', TERM_LABELS[rental.commitment_term] || rental.commitment_term || '—'],
        ['Reserved', fmtDate(rental.reserved_at)],
        ['Delivered', fmtDate(rental.delivered_at)],
        ['Billing start', fmtDate(rental.billing_start)],
        rental.calloff_at && ['Called off', fmtDate(rental.calloff_at)],
        rental.billing_stop && ['Billing stopped', fmtDate(rental.billing_stop)],
        rental.picked_up_at && ['Picked up', fmtDate(rental.picked_up_at)],
        ['Days on rent', rental.days_on_rent != null ? plural(rental.days_on_rent, 'day') : '—'],
    ]
    if (!isTech) {
        items.push(
            ['Rate', pricingLabel(rental) || '—'],
            ['Accrued to date', fmtMoney(rental.accrued_amount)],
            ['Total due', fmtMoney(rental.total_due)],
        )
    }

    return (
        <div className="grid-main">
            <Card title="Current rental" meta={`#${rental.id}`}
                actions={<RentalActionButtons rental={rental} onAction={flow.start} />}
                foot={showRentalsLink ? <Link to="/rentals" className="link" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Open in rentals <Icon name="chevron" size={13} /></Link> : null}>
                <KV items={items} />
                {rental.notes && !(isTech && rental.notes.includes('$')) && <div className="muted" style={{ marginTop: 14, fontSize: 13 }}>{rental.notes}</div>}
            </Card>
            <RentalHistory rentalId={rental.id} isTech={isTech} key={`${rental.id}-${rental.status}`} />
            {flow.modal}
        </div>
    )
}

function RentalHistory({ rentalId, isTech }) {
    const [events, setEvents] = useState(null)
    useEffect(() => {
        let alive = true
        fetchRental(rentalId).then(d => alive && setEvents(d.events || [])).catch(() => alive && setEvents([]))
        return () => { alive = false }
    }, [rentalId])

    return (
        <Card title="History">
            {!events ? <Loading /> : events.length === 0 ? <Empty compact>No events recorded.</Empty> : (
                <div className="timeline">
                    {[...events].reverse().map(e => (
                        <div key={e.id} className="tl-item">
                            <span className={`tl-dot ${EVENT_TONE[e.event_type] || ''}`} />
                            <div>
                                <div className="tl-title">{EVENT_LABELS[e.event_type] || e.event_type}</div>
                                <div className="tl-meta">
                                    {[fmtDate(e.event_date || e.created_at), e.actor, e.transport_company,
                                        !isTech && e.transport_cost != null && `transport ${fmtMoney(e.transport_cost)}`].filter(Boolean).join(' · ')}
                                </div>
                                {e.notes && !(isTech && e.notes.includes('$')) && <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{e.notes}</div>}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </Card>
    )
}
