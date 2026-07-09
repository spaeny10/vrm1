import { useState } from 'react'

// ============================================================
// Shared rental lifecycle UI: status labels/badges, lifecycle
// action buttons, and the event-confirmation modal. Used by the
// Rentals page, Job Site detail, Trailer detail, and Trailers
// asset registry so the rental workflow looks and behaves the
// same everywhere.
// ============================================================

export const STATUS_LABELS = {
    reserved: 'Reserved',
    delivered: 'Delivered',
    billing: 'Billing',
    called_off: 'Called Off',
    awaiting_pickup: 'Awaiting Pickup',
    closed: 'Closed',
    cancelled: 'Cancelled',
}

export const STATUS_COLORS = {
    reserved: 'gray',
    delivered: 'blue',
    billing: 'green',
    called_off: 'yellow',
    awaiting_pickup: 'yellow',
    closed: 'gray',
    cancelled: 'gray',
}

// Lifecycle actions available from each rental status
export const STATUS_ACTIONS = {
    reserved: [
        { event: 'deliver', label: 'Deliver' },
        { event: 'start_billing', label: 'Start Billing' },
        { event: 'cancel', label: 'Cancel' },
    ],
    delivered: [
        { event: 'start_billing', label: 'Start Billing' },
        { event: 'pickup', label: 'Pickup' },
        { event: 'cancel', label: 'Cancel' },
    ],
    billing: [
        { event: 'calloff', label: 'Call Off' },
        { event: 'stop_billing', label: 'Stop Billing' },
    ],
    called_off: [
        { event: 'stop_billing', label: 'Stop Billing' },
    ],
    awaiting_pickup: [
        { event: 'pickup', label: 'Pickup' },
        { event: 'return', label: 'Return to HQ' },
    ],
}

export const EVENT_LABELS = {
    reserved: 'Reserved',
    deliver: 'Mark Delivered',
    start_billing: 'Start Billing',
    calloff: 'Call Off',
    stop_billing: 'Stop Billing',
    pickup: 'Mark Picked Up',
    return: 'Mark Returned',
    cancel: 'Cancel Rental',
    rollback_adjustment: 'Roll-Back Adjustment',
}

export const TERM_LABELS = {
    monthly: 'Monthly',
    '6_month': '6-Month',
    '1_year': '1-Year',
}

export const CYCLE_LABELS = {
    calendar_month: 'cal-mo',
    '28_day': '28d',
    day: 'day',
    week: 'week',
    month: '28d-mo',
}

export const TRAILER_STATUS_LABELS = {
    available: 'Available',
    reserved: 'Reserved',
    on_rent: 'On Rent',
    in_transit: 'In Transit',
    maintenance: 'Maintenance',
    retired: 'Retired',
}

export const TRAILER_STATUS_COLORS = {
    available: 'green',
    reserved: 'blue',
    on_rent: 'yellow',
    in_transit: 'blue',
    maintenance: 'yellow',
    retired: 'gray',
}

export function formatDate(d) {
    if (!d) return '—'
    const dt = new Date(d)
    return isNaN(dt) ? '—' : dt.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatMoney(v) {
    if (v === null || v === undefined) return '—'
    return `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function todayStr() {
    return new Date().toISOString().slice(0, 10)
}

// DATE columns arrive as ISO timestamps — reduce to yyyy-mm-dd for <input type="date">
export function toDateInput(d) {
    if (!d) return ''
    return String(d).slice(0, 10)
}

export function RentalStatusBadge({ status }) {
    return (
        <span className={`maint-status-badge maint-status-${STATUS_COLORS[status] || 'gray'}`}>
            {STATUS_LABELS[status] || status}
        </span>
    )
}

export function TrailerStatusBadge({ status }) {
    return (
        <span className={`maint-status-badge maint-status-${TRAILER_STATUS_COLORS[status] || 'gray'}`}>
            {TRAILER_STATUS_LABELS[status] || status}
        </span>
    )
}

// One-line description of a rental's pricing (manual or rate-card)
export function pricingLabel(r) {
    if (!r?.effective_rate) return null
    const cycle = CYCLE_LABELS[r.billing_cycle] || r.billing_cycle
    if (r.pricing_source === 'manual') return `${formatMoney(r.effective_rate)}/${cycle} (manual rate)`
    const tier = r.volume_tier && r.volume_tier.discount_pct > 0 ? ` · ${r.volume_tier.name} −${r.volume_tier.discount_pct}%` : ''
    return `${formatMoney(r.effective_rate)}/${cycle} · ${TERM_LABELS[r.commitment_term] || r.commitment_term}${tier}`
}

// Lifecycle action buttons for a rental row/card.
// onAction(rental, event) should open the RentalEventModal.
export function RentalActionButtons({ rental, onAction, size = 'sm' }) {
    const actions = STATUS_ACTIONS[rental.status] || []
    if (actions.length === 0) return null
    return (
        <>
            {actions.map(action => (
                <button
                    key={action.event}
                    className={`btn btn-${size} ${action.event === 'cancel' ? 'btn-ghost' : 'btn-secondary'}`}
                    style={{ marginRight: 6 }}
                    onClick={(e) => { e.stopPropagation(); onAction(rental, action.event) }}
                >
                    {action.label}
                </button>
            ))}
        </>
    )
}

// Confirmation modal for a lifecycle event (effective date + notes)
export function RentalEventModal({ rental, event, submitting, onConfirm, onClose }) {
    const [date, setDate] = useState(todayStr())
    const [notes, setNotes] = useState('')
    const [transportCompany, setTransportCompany] = useState('')
    const [transportCost, setTransportCost] = useState('')
    const isBillingEvent = event === 'start_billing' || event === 'stop_billing'
    // Pickups and deliveries are physical moves — log the hotshot service used
    const isTransportEvent = event === 'pickup' || event === 'deliver'

    const confirm = () => onConfirm(
        event === 'cancel' ? undefined : date,
        notes,
        isTransportEvent ? { transport_company: transportCompany || null, transport_cost: transportCost ? parseFloat(transportCost) : null } : {},
    )

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
                <div className="modal-header">
                    <h2>{EVENT_LABELS[event] || event} — {rental.unit_number}</h2>
                    <button className="modal-close" onClick={onClose}>&times;</button>
                </div>
                <div style={{ padding: 20 }}>
                    {event !== 'cancel' && (
                        <div style={{ marginBottom: 14 }}>
                            <label className="form-label">Effective Date</label>
                            <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
                            {isBillingEvent && (
                                <p className="settings-desc" style={{ marginTop: 6 }}>
                                    This date is used for billing calculations and is recorded in the audit trail.
                                </p>
                            )}
                        </div>
                    )}
                    {isTransportEvent && (
                        <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                            <div style={{ flex: 2 }}>
                                <label className="form-label">Hotshot / Transport Company</label>
                                <input className="input" value={transportCompany} onChange={e => setTransportCompany(e.target.value)} placeholder="e.g. Rapid Hotshot LLC" />
                            </div>
                            <div style={{ flex: 1 }}>
                                <label className="form-label">Transport Cost ($)</label>
                                <input type="number" min="0" step="0.01" className="input" value={transportCost} onChange={e => setTransportCost(e.target.value)} placeholder="0.00" />
                            </div>
                        </div>
                    )}
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Notes (optional)</label>
                        <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Confirmed with site super by phone" />
                    </div>
                    <div className="modal-footer">
                        <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
                        <button className="btn btn-primary" onClick={confirm} disabled={submitting}>
                            {submitting ? 'Saving...' : (EVENT_LABELS[event] || 'Confirm')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
