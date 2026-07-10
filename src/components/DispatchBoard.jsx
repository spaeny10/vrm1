import { useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from './AuthProvider'
import { useToast } from './ToastProvider'
import { fetchRentals, postRentalEvent } from '../api/vrm'
import {
    EVENT_LABELS, formatDate,
    RentalActionButtons, RentalEventModal,
} from './RentalLifecycle'

// Self-contained dispatch board: what has to physically move.
// Used on the Fleet workspace home and the Rentals page.
function DispatchBoard() {
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const toast = useToast()

    const fetchFn = useCallback(() => fetchRentals({ open: 1 }), [])
    const { data, refetch } = useApiPolling(fetchFn, 60000)
    const rentals = data?.rentals || []

    const [actionModal, setActionModal] = useState(null)
    const [submitting, setSubmitting] = useState(false)

    const dispatch = useMemo(() => ({
        deliveries: rentals.filter(r => r.status === 'reserved')
            .sort((a, b) => String(a.reserved_at).localeCompare(String(b.reserved_at))),
        pickups: rentals.filter(r => (r.status === 'awaiting_pickup' || r.status === 'called_off') && !r.picked_up_at)
            .sort((a, b) => String(a.calloff_at || a.billing_stop || '').localeCompare(String(b.calloff_at || b.billing_stop || ''))),
        inTransit: rentals.filter(r => r.status === 'awaiting_pickup' && r.picked_up_at),
    }), [rentals])

    const handleEvent = async (rental, event, date, notes, extras) => {
        setSubmitting(true)
        try {
            await postRentalEvent(rental.id, event, date, notes, extras)
            toast.success(`${rental.unit_number}: ${EVENT_LABELS[event] || event} recorded`)
            setActionModal(null)
            refetch()
        } catch (err) {
            toast.error(err.message)
        } finally {
            setSubmitting(false)
        }
    }

    const unitCell = (r) => r.vrm_site_id
        ? <Link to={`/trailer/${r.vrm_site_id}`} onClick={e => e.stopPropagation()} className="table-link">{r.unit_number}</Link>
        : r.unit_number

    const siteCell = (r) => r.job_site_id
        ? <Link to={`/site/${r.job_site_id}`} onClick={e => e.stopPropagation()} className="table-link">{r.job_site_name}</Link>
        : (r.job_site_name || '—')

    const total = dispatch.deliveries.length + dispatch.pickups.length + dispatch.inTransit.length

    return (
        <div className="maint-table-section" style={{ marginBottom: 20 }}>
            <div className="maint-group-header">
                <h3>Dispatch</h3>
                <span className="maint-group-count">
                    {total === 0
                        ? 'nothing to move'
                        : `${dispatch.deliveries.length} deliver · ${dispatch.pickups.length} pick up · ${dispatch.inTransit.length} in transit`}
                </span>
            </div>
            {total === 0 ? (
                <p className="settings-desc" style={{ padding: '8px 0' }}>
                    No deliveries or pickups pending. New reservations and call-offs will appear here.
                </p>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, padding: '12px 0' }}>
                    <DispatchColumn
                        title="Deliveries Due" empty="No pending deliveries"
                        items={dispatch.deliveries}
                        dateLabel={r => `Reserved ${formatDate(r.reserved_at)}`}
                        canEdit={canEdit}
                        onAction={(r, ev) => setActionModal({ rental: r, event: ev })}
                        unitCell={unitCell} siteCell={siteCell}
                    />
                    <DispatchColumn
                        title="Pickups Due" empty="No pending pickups"
                        items={dispatch.pickups}
                        dateLabel={r => r.calloff_at ? `Called off ${formatDate(r.calloff_at)}` : `Billing stopped ${formatDate(r.billing_stop)}`}
                        canEdit={canEdit}
                        onAction={(r, ev) => setActionModal({ rental: r, event: ev })}
                        unitCell={unitCell} siteCell={siteCell}
                    />
                    <DispatchColumn
                        title="In Transit" empty="Nothing in transit"
                        items={dispatch.inTransit}
                        dateLabel={r => `Picked up ${formatDate(r.picked_up_at)}`}
                        canEdit={canEdit}
                        onAction={(r, ev) => setActionModal({ rental: r, event: ev })}
                        unitCell={unitCell} siteCell={siteCell}
                    />
                </div>
            )}

            {actionModal && (
                <RentalEventModal
                    rental={actionModal.rental}
                    event={actionModal.event}
                    submitting={submitting}
                    onConfirm={(date, notes, extras) => handleEvent(actionModal.rental, actionModal.event, date, notes, extras)}
                    onClose={() => setActionModal(null)}
                />
            )}
        </div>
    )
}

function DispatchColumn({ title, empty, items, dateLabel, canEdit, onAction, unitCell, siteCell }) {
    return (
        <div>
            <h4 style={{ margin: '0 0 8px', color: 'var(--text-secondary)', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {title} {items.length > 0 && <span className="maint-group-count">{items.length}</span>}
            </h4>
            {items.length === 0 ? (
                <p className="settings-desc">{empty}</p>
            ) : items.slice(0, 6).map(r => (
                <div key={r.id} className="work-card" style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <strong>{unitCell(r)}</strong>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{dateLabel(r)}</span>
                    </div>
                    <div style={{ fontSize: 13, margin: '4px 0 8px', color: 'var(--text-secondary)' }}>
                        {siteCell(r)}{r.company_name ? <> · {r.company_name}</> : null}
                    </div>
                    {canEdit && <RentalActionButtons rental={r} onAction={onAction} />}
                </div>
            ))}
            {items.length > 6 && <p className="settings-desc">+{items.length - 6} more…</p>}
        </div>
    )
}

export default DispatchBoard
