import { useState } from 'react'
import { useWorkspace } from './WorkspaceProvider'
import { useToast } from './ToastProvider'
import { postRentalEvent } from '../api/vrm'
import { Badge, Modal, Field } from '../ui'
import { fmtMoney, todayISO } from '../ui/format'

// ============================================================
// Shared rental lifecycle: status labels, lifecycle actions (owned
// per workspace), and the event confirmation dialog. Used by the
// rentals page, site and trailer pages, and the workspace homes.
// ============================================================

export const STATUS_LABELS = {
    reserved: 'Reserved', delivered: 'Delivered', billing: 'Billing', called_off: 'Called off',
    awaiting_pickup: 'Awaiting pickup', closed: 'Closed', cancelled: 'Cancelled',
}

export const STATUS_TONES = {
    reserved: 'info', delivered: 'warn', billing: 'ok', called_off: 'warn',
    awaiting_pickup: 'warn', closed: 'plain', cancelled: 'plain',
}

// Actions available from each status
export const STATUS_ACTIONS = {
    reserved: [{ event: 'deliver', label: 'Deliver' }, { event: 'start_billing', label: 'Start billing' }, { event: 'cancel', label: 'Cancel' }],
    delivered: [{ event: 'start_billing', label: 'Start billing' }, { event: 'pickup', label: 'Pick up' }, { event: 'cancel', label: 'Cancel' }],
    billing: [{ event: 'calloff', label: 'Call off' }, { event: 'stop_billing', label: 'Stop billing' }],
    called_off: [{ event: 'pickup', label: 'Pick up' }, { event: 'stop_billing', label: 'Stop billing' }],
    awaiting_pickup: [{ event: 'pickup', label: 'Pick up' }, { event: 'return', label: 'Returned to HQ' }],
}

// Who owns each event: fleet moves trailers and handles the customer's
// schedule; billing flips the money switch. Tech takes no rental actions.
export const EVENT_OWNER = {
    deliver: 'fleet', calloff: 'fleet', pickup: 'fleet', return: 'fleet', cancel: 'fleet',
    start_billing: 'billing', stop_billing: 'billing',
}

export const EVENT_LABELS = {
    reserved: 'Reserved', deliver: 'Delivered', start_billing: 'Billing started', calloff: 'Called off',
    stop_billing: 'Billing stopped', pickup: 'Picked up', return: 'Returned to HQ', cancel: 'Cancelled',
    rollback_adjustment: 'Roll-back adjustment',
}

const EVENT_VERB = {
    deliver: 'Mark delivered', start_billing: 'Start billing', calloff: 'Record call-off', stop_billing: 'Stop billing',
    pickup: 'Mark picked up', return: 'Mark returned', cancel: 'Cancel rental',
}

export const TERM_LABELS = { monthly: 'Monthly', '6_month': '6-month', '1_year': '1-year' }
export const CYCLE_LABELS = { calendar_month: 'month', '28_day': '28 days', day: 'day', week: 'week', month: '28-day month' }

export const TRAILER_STATUS_LABELS = {
    available: 'Available', reserved: 'Reserved', on_rent: 'On rent', in_transit: 'In transit', maintenance: 'Maintenance', retired: 'Retired',
}
export const TRAILER_STATUS_TONES = {
    available: 'ok', reserved: 'info', on_rent: 'plain', in_transit: 'info', maintenance: 'warn', retired: 'off',
}

export function RentalStatusBadge({ status }) {
    if (!status) return <span className="faint">—</span>
    return <Badge tone={STATUS_TONES[status] || 'plain'}>{STATUS_LABELS[status] || status}</Badge>
}

export function TrailerStatusBadge({ status }) {
    if (!status) return <span className="faint">—</span>
    return <Badge tone={TRAILER_STATUS_TONES[status] || 'plain'}>{TRAILER_STATUS_LABELS[status] || status}</Badge>
}

// "$1,923.00 / 28 days · 1-year · Bronze −7.25%"
export function pricingLabel(r) {
    if (!r?.effective_rate) return null
    const cycle = CYCLE_LABELS[r.billing_cycle] || r.billing_cycle
    if (r.pricing_source === 'manual') return `${fmtMoney(r.effective_rate)} / ${cycle} (manual)`
    const tier = r.volume_tier && r.volume_tier.discount_pct > 0 ? ` · ${r.volume_tier.name} −${r.volume_tier.discount_pct}%` : ''
    return `${fmtMoney(r.effective_rate)} / ${cycle} · ${TERM_LABELS[r.commitment_term] || r.commitment_term}${tier}`
}

export function useRentalActions(rental) {
    const { workspace } = useWorkspace()
    return (STATUS_ACTIONS[rental?.status] || []).filter(a => EVENT_OWNER[a.event] === workspace)
}

// Buttons for the actions this workspace owns. onAction(rental, event)
export function RentalActionButtons({ rental, onAction, align = 'end' }) {
    const actions = useRentalActions(rental)
    if (!actions.length) return null
    return (
        <span className="btn-row" style={{ justifyContent: align === 'start' ? 'flex-start' : 'flex-end' }}>
            {actions.map(a => (
                <button key={a.event} className={`btn sm ${a.event === 'cancel' ? 'ghost' : ''}`}
                    onClick={e => { e.stopPropagation(); onAction(rental, a.event) }}>{a.label}</button>
            ))}
        </span>
    )
}

// Confirm a lifecycle event with an effective date (and hotshot details for moves)
export function RentalEventModal({ rental, event, submitting, onConfirm, onClose }) {
    const [date, setDate] = useState(todayISO())
    const [notes, setNotes] = useState('')
    const [company, setCompany] = useState('')
    const [cost, setCost] = useState('')
    const isMove = event === 'pickup' || event === 'deliver'
    const isBilling = event === 'start_billing' || event === 'stop_billing'

    const confirm = () => onConfirm(
        event === 'cancel' ? undefined : date,
        notes,
        isMove ? { transport_company: company || null, transport_cost: cost ? parseFloat(cost) : null } : {},
    )

    return (
        <Modal title={`${EVENT_VERB[event] || event} — ${rental.unit_number}`} onClose={onClose}
            footer={<>
                <button className="btn ghost" onClick={onClose} disabled={submitting}>Cancel</button>
                <button className={`btn ${event === 'cancel' ? 'danger solid' : 'primary'}`} onClick={confirm} disabled={submitting}>
                    {submitting ? 'Saving…' : EVENT_VERB[event] || 'Confirm'}
                </button>
            </>}>
            <div className="form">
                {(rental.job_site_name || rental.company_name) && (
                    <div className="muted">{[rental.job_site_name, rental.company_name].filter(Boolean).join(' · ')}</div>
                )}
                {event !== 'cancel' && (
                    <Field label="Effective date" hint={isBilling ? 'Used for billing calculations and kept in the audit trail.' : null}>
                        <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
                    </Field>
                )}
                {isMove && (
                    <div className="form-row">
                        <Field label="Hotshot / transport company">
                            <input className="input" value={company} onChange={e => setCompany(e.target.value)} placeholder="e.g. Rapid Hotshot LLC" />
                        </Field>
                        <Field label="Transport cost ($)" hint="Internal expense, not billed">
                            <input className="input" type="number" min="0" step="0.01" value={cost} onChange={e => setCost(e.target.value)} />
                        </Field>
                    </div>
                )}
                <Field label="Notes (optional)">
                    <textarea className="textarea" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Confirmed with site superintendent" />
                </Field>
            </div>
        </Modal>
    )
}

// One-line lifecycle flow for any page: const flow = useRentalEventFlow(refetch)
// then flow.start(rental, 'deliver') and render {flow.modal}
export function useRentalEventFlow(onDone) {
    const toast = useToast()
    const [pending, setPending] = useState(null)
    const [submitting, setSubmitting] = useState(false)

    const confirm = async (date, notes, extras) => {
        setSubmitting(true)
        try {
            const res = await postRentalEvent(pending.rental.id, pending.event, date, notes, extras)
            const rb = res?.rollback?.adjustment
            toast.success(`${pending.rental.unit_number}: ${EVENT_LABELS[pending.event] || pending.event}${rb ? ` — roll-back adjustment ${fmtMoney(rb)}` : ''}`)
            setPending(null)
            onDone?.()
        } catch (err) {
            toast.error(err.message)
        } finally {
            setSubmitting(false)
        }
    }

    return {
        start: (rental, event) => setPending({ rental, event }),
        modal: pending ? (
            <RentalEventModal rental={pending.rental} event={pending.event} submitting={submitting}
                onConfirm={confirm} onClose={() => setPending(null)} />
        ) : null,
    }
}
