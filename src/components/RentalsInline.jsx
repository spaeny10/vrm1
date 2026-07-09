import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import { useToast } from './ToastProvider'
import { fetchRentals, postRentalEvent } from '../api/vrm'
import {
    EVENT_LABELS, formatDate, formatMoney, pricingLabel,
    RentalStatusBadge, RentalActionButtons, RentalEventModal,
} from './RentalLifecycle'

// Embedded rentals panel for Job Site detail (all open rentals on the
// site) and Trailer detail (the unit's open rental). Full management —
// creating rentals, editing rates — lives on the Rentals page; this
// panel covers the day-to-day lifecycle actions in context.
function RentalsInline({ jobSiteId, vrmSiteId, title = 'Rentals & Billing' }) {
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const toast = useToast()

    const [rentals, setRentals] = useState(null)
    const [actionModal, setActionModal] = useState(null)
    const [submitting, setSubmitting] = useState(false)

    const load = useCallback(() => {
        const filters = { open: 1 }
        if (jobSiteId) filters.job_site_id = jobSiteId
        if (vrmSiteId) filters.vrm_site_id = vrmSiteId
        fetchRentals(filters)
            .then(d => setRentals(d.rentals || []))
            .catch(() => setRentals([]))
    }, [jobSiteId, vrmSiteId])

    useEffect(() => { load() }, [load])

    const handleEvent = async (rental, event, date, notes, extras) => {
        setSubmitting(true)
        try {
            await postRentalEvent(rental.id, event, date, notes, extras)
            toast.success(`${rental.unit_number}: ${EVENT_LABELS[event] || event} recorded`)
            setActionModal(null)
            load()
        } catch (err) {
            toast.error(err.message)
        } finally {
            setSubmitting(false)
        }
    }

    if (rentals === null) return null

    return (
        <div className="maint-table-section" style={{ marginBottom: 20 }}>
            <div className="maint-group-header">
                <h3>{title}</h3>
                <Link to="/rentals" className="table-link" style={{ fontSize: 13 }}>Manage on Rentals page →</Link>
            </div>
            {rentals.length === 0 ? (
                <p className="settings-desc" style={{ padding: '8px 0' }}>
                    {vrmSiteId ? 'This unit is not on an open rental.' : 'No open rentals on this site.'}
                </p>
            ) : (
                <table className="maint-table">
                    <thead>
                        <tr>
                            <th>Unit</th>
                            {!jobSiteId && <th>Job Site</th>}
                            <th>Customer</th>
                            <th>PO #</th>
                            <th>Rate</th>
                            <th>Billing Start</th>
                            <th>Days</th>
                            <th>Total Due</th>
                            <th>Status</th>
                            {canEdit && <th>Actions</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {rentals.map(r => (
                            <tr key={r.id}>
                                <td className="maint-title">
                                    {r.vrm_site_id && !vrmSiteId
                                        ? <Link to={`/trailer/${r.vrm_site_id}`} className="table-link">{r.unit_number}</Link>
                                        : r.unit_number}
                                </td>
                                {!jobSiteId && (
                                    <td>{r.job_site_id
                                        ? <Link to={`/site/${r.job_site_id}`} className="table-link">{r.job_site_name}</Link>
                                        : (r.job_site_name || '—')}</td>
                                )}
                                <td>{r.company_name || '—'}</td>
                                <td>{r.po_number || '—'}</td>
                                <td style={{ fontSize: 13 }}>{pricingLabel(r) || '—'}</td>
                                <td className="maint-date">{formatDate(r.billing_start)}</td>
                                <td>{r.days_on_rent ?? '—'}</td>
                                <td className="maint-cost">{formatMoney(r.total_due ?? r.accrued_amount)}</td>
                                <td><RentalStatusBadge status={r.status} /></td>
                                {canEdit && (
                                    <td className="maint-actions">
                                        <RentalActionButtons rental={r} onAction={(rental, event) => setActionModal({ rental, event })} />
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
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

export default RentalsInline
