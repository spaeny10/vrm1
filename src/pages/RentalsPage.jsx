import { useState, useCallback, useMemo, useEffect } from 'react'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useToast } from '../components/ToastProvider'
import {
    fetchRentals, createRental, postRentalEvent,
    fetchBillingSummary, fetchBillingAlerts,
    fetchTrailers, fetchJobSites, fetchCompanies,
} from '../api/vrm'
import { generateCSV, downloadCSV } from '../utils/csv'

const STATUS_TABS = [
    { key: 'all', label: 'All Open' },
    { key: 'reserved', label: 'Reserved' },
    { key: 'delivered', label: 'Delivered' },
    { key: 'billing', label: 'Billing' },
    { key: 'called_off', label: 'Called Off' },
    { key: 'awaiting_pickup', label: 'Awaiting Pickup' },
    { key: 'closed', label: 'Closed' },
]

const STATUS_LABELS = {
    reserved: 'Reserved',
    delivered: 'Delivered',
    billing: 'Billing',
    called_off: 'Called Off',
    awaiting_pickup: 'Awaiting Pickup',
    closed: 'Closed',
    cancelled: 'Cancelled',
}

const STATUS_COLORS = {
    reserved: 'gray',
    delivered: 'blue',
    billing: 'green',
    called_off: 'yellow',
    awaiting_pickup: 'yellow',
    closed: 'gray',
    cancelled: 'gray',
}

// Lifecycle actions available from each rental status
const STATUS_ACTIONS = {
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

const EVENT_LABELS = {
    deliver: 'Mark Delivered',
    start_billing: 'Start Billing',
    calloff: 'Call Off',
    stop_billing: 'Stop Billing',
    pickup: 'Mark Picked Up',
    return: 'Mark Returned',
    cancel: 'Cancel Rental',
}

function formatDate(d) {
    if (!d) return '—'
    const dt = new Date(d)
    return isNaN(dt) ? '—' : dt.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatMoney(v) {
    if (v === null || v === undefined) return '—'
    return `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function todayStr() {
    return new Date().toISOString().slice(0, 10)
}

function RentalsPage() {
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const toast = useToast()

    const [statusFilter, setStatusFilter] = useState('all')
    const [showNewRental, setShowNewRental] = useState(false)
    const [actionModal, setActionModal] = useState(null) // { rental, event }
    const [submitting, setSubmitting] = useState(false)

    const fetchRentalsFn = useCallback(() => fetchRentals(), [])
    const fetchSummaryFn = useCallback(() => fetchBillingSummary(), [])
    const fetchAlertsFn = useCallback(() => fetchBillingAlerts(), [])

    const { data: rentalsData, loading, refetch: refetchRentals } = useApiPolling(fetchRentalsFn, 60000)
    const { data: summaryData, refetch: refetchSummary } = useApiPolling(fetchSummaryFn, 60000)
    const { data: alertsData, refetch: refetchAlerts } = useApiPolling(fetchAlertsFn, 60000)

    const rentals = rentalsData?.rentals || []
    const summary = summaryData?.summary || {}
    const alerts = alertsData?.alerts || []

    // Reference data for the New Rental modal
    const [trailers, setTrailers] = useState([])
    const [jobSites, setJobSites] = useState([])
    const [companies, setCompanies] = useState([])

    useEffect(() => {
        if (!showNewRental) return
        Promise.all([fetchTrailers(), fetchJobSites(), fetchCompanies()])
            .then(([t, j, c]) => {
                setTrailers(t.trailers || [])
                setJobSites(j.job_sites || [])
                setCompanies(c.companies || [])
            })
            .catch(err => toast.error(`Failed to load form data: ${err.message}`))
    }, [showNewRental])

    const filteredRentals = useMemo(() => {
        if (statusFilter === 'all') return rentals.filter(r => r.status !== 'closed' && r.status !== 'cancelled')
        if (statusFilter === 'closed') return rentals.filter(r => r.status === 'closed' || r.status === 'cancelled')
        return rentals.filter(r => r.status === statusFilter)
    }, [rentals, statusFilter])

    const refetchAll = () => { refetchRentals(); refetchSummary(); refetchAlerts() }

    const handleEvent = async (rental, event, date, notes) => {
        setSubmitting(true)
        try {
            await postRentalEvent(rental.id, event, date, notes)
            toast.success(`${rental.unit_number}: ${EVENT_LABELS[event] || event} recorded`)
            setActionModal(null)
            refetchAll()
        } catch (err) {
            toast.error(err.message)
        } finally {
            setSubmitting(false)
        }
    }

    const handleExportCSV = () => {
        const headers = ['Unit', 'Status', 'Job Site', 'Company', 'PO Number', 'Rate', 'Rate Period', 'Billing Start', 'Billing Stop', 'Days on Rent', 'Accrued']
        const rows = filteredRentals.map(r => [
            r.unit_number,
            STATUS_LABELS[r.status] || r.status,
            r.job_site_name || '',
            r.company_name || '',
            r.po_number || '',
            r.rate_amount || '',
            r.rate_period || '',
            r.billing_start ? String(r.billing_start).slice(0, 10) : '',
            r.billing_stop ? String(r.billing_stop).slice(0, 10) : '',
            r.days_on_rent ?? '',
            r.accrued_amount ?? '',
        ])
        downloadCSV(generateCSV(headers, rows), `rentals-${todayStr()}.csv`)
    }

    const statusBadge = (status) => (
        <span className={`maint-status-badge maint-status-${STATUS_COLORS[status] || 'gray'}`}>
            {STATUS_LABELS[status] || status}
        </span>
    )

    return (
        <div className="page">
            <div className="page-header">
                <div className="page-header-row">
                    <h1>Rentals & Billing</h1>
                    <div className="page-header-actions">
                        <button className="btn btn-secondary" onClick={handleExportCSV} disabled={filteredRentals.length === 0}>
                            Export CSV
                        </button>
                        {canEdit && (
                            <button className="btn btn-primary" onClick={() => setShowNewRental(true)}>
                                + New Rental
                            </button>
                        )}
                    </div>
                </div>
                <p className="page-subtitle">Track deployments, billing start/stop, and returns across the rental fleet</p>
            </div>

            {/* KPI tiles */}
            <div className="kpi-row">
                <div className="kpi-card kpi-green">
                    <div className="kpi-value">{summary.rentals_billing ?? '—'}</div>
                    <div className="kpi-label">Billing Now</div>
                </div>
                <div className="kpi-card kpi-blue">
                    <div className="kpi-value">{summary.rentals_open ?? '—'}</div>
                    <div className="kpi-label">Open Rentals</div>
                </div>
                <div className="kpi-card kpi-teal">
                    <div className="kpi-value">{summary.trailers_available ?? '—'}</div>
                    <div className="kpi-label">Available Trailers</div>
                </div>
                <div className="kpi-card kpi-yellow">
                    <div className="kpi-value">{formatMoney(summary.accrued_mtd)}</div>
                    <div className="kpi-label">Accrued This Month</div>
                </div>
                <div className={`kpi-card ${alerts.length > 0 ? 'kpi-red' : ''}`}>
                    <div className="kpi-value">{alerts.length}</div>
                    <div className="kpi-label">Billing Alerts</div>
                </div>
            </div>

            {/* Revenue-leakage alerts */}
            {alerts.length > 0 && (
                <div className="maint-table-section" style={{ marginBottom: 20 }}>
                    <div className="maint-group-header">
                        <h3>Billing Alerts</h3>
                        <span className="maint-group-count">{alerts.length} issue{alerts.length !== 1 ? 's' : ''}</span>
                    </div>
                    <table className="maint-table">
                        <tbody>
                            {alerts.map((a, i) => (
                                <tr key={i}>
                                    <td style={{ width: 90 }}>
                                        <span className={a.severity === 'critical' ? 'priority-badge-critical' : 'priority-badge-warning'}>
                                            {a.severity === 'critical' ? 'Critical' : 'Warning'}
                                        </span>
                                    </td>
                                    <td>{a.message}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {summary.rentals_missing_rate > 0 && (
                <p className="settings-desc" style={{ marginBottom: 16 }}>
                    {summary.rentals_missing_rate} active rental{summary.rentals_missing_rate !== 1 ? 's have' : ' has'} no rate set — accrued totals are understated. Edit the rental to add a rate.
                </p>
            )}

            {/* Status tabs */}
            <div className="maint-tabs" style={{ marginBottom: 16 }}>
                {STATUS_TABS.map(tab => (
                    <button
                        key={tab.key}
                        className={`maint-tab ${statusFilter === tab.key ? 'active' : ''}`}
                        onClick={() => setStatusFilter(tab.key)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Rentals table */}
            <div className="maint-table-section">
                {loading && rentals.length === 0 ? (
                    <div className="page-loading"><div className="spinner" /><p>Loading rentals...</p></div>
                ) : filteredRentals.length === 0 ? (
                    <div className="empty-section">
                        <p>{rentals.length === 0
                            ? 'No rentals yet. Click "+ New Rental" to reserve a trailer for a customer.'
                            : 'No rentals match this filter.'}</p>
                    </div>
                ) : (
                    <table className="maint-table">
                        <thead>
                            <tr>
                                <th>Unit</th>
                                <th>Job Site</th>
                                <th>Company</th>
                                <th>PO #</th>
                                <th>Rate</th>
                                <th>Billing Start</th>
                                <th>Billing Stop</th>
                                <th>Days</th>
                                <th>Accrued</th>
                                <th>Status</th>
                                {canEdit && <th>Actions</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {filteredRentals.map(r => (
                                <tr key={r.id}>
                                    <td className="maint-title">{r.unit_number}</td>
                                    <td>{r.job_site_name || '—'}</td>
                                    <td>{r.company_name || '—'}</td>
                                    <td>{r.po_number || '—'}</td>
                                    <td>{r.rate_amount ? `${formatMoney(r.rate_amount)}/${r.rate_period}` : '—'}</td>
                                    <td className="maint-date">{formatDate(r.billing_start)}</td>
                                    <td className="maint-date">{formatDate(r.billing_stop)}</td>
                                    <td>{r.days_on_rent ?? '—'}</td>
                                    <td className="maint-cost">{formatMoney(r.accrued_amount)}</td>
                                    <td>{statusBadge(r.status)}</td>
                                    {canEdit && (
                                        <td className="maint-actions">
                                            {(STATUS_ACTIONS[r.status] || []).map(action => (
                                                <button
                                                    key={action.event}
                                                    className={`btn btn-sm ${action.event === 'cancel' ? 'btn-ghost' : 'btn-secondary'}`}
                                                    style={{ marginRight: 6 }}
                                                    onClick={() => setActionModal({ rental: r, event: action.event })}
                                                >
                                                    {action.label}
                                                </button>
                                            ))}
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Lifecycle event modal */}
            {actionModal && (
                <RentalEventModal
                    rental={actionModal.rental}
                    event={actionModal.event}
                    submitting={submitting}
                    onConfirm={(date, notes) => handleEvent(actionModal.rental, actionModal.event, date, notes)}
                    onClose={() => setActionModal(null)}
                />
            )}

            {/* New rental modal */}
            {showNewRental && (
                <NewRentalModal
                    trailers={trailers}
                    jobSites={jobSites}
                    companies={companies}
                    onCreated={() => { setShowNewRental(false); refetchAll(); toast.success('Rental created') }}
                    onError={(msg) => toast.error(msg)}
                    onClose={() => setShowNewRental(false)}
                />
            )}
        </div>
    )
}

function RentalEventModal({ rental, event, submitting, onConfirm, onClose }) {
    const [date, setDate] = useState(todayStr())
    const [notes, setNotes] = useState('')
    const isBillingEvent = event === 'start_billing' || event === 'stop_billing'

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
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Notes (optional)</label>
                        <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Confirmed with site super by phone" />
                    </div>
                    <div className="modal-footer">
                        <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
                        <button className="btn btn-primary" onClick={() => onConfirm(event === 'cancel' ? undefined : date, notes)} disabled={submitting}>
                            {submitting ? 'Saving...' : (EVENT_LABELS[event] || 'Confirm')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

function NewRentalModal({ trailers, jobSites, companies, onCreated, onError, onClose }) {
    const [form, setForm] = useState({
        trailer_id: '',
        job_site_id: '',
        company_id: '',
        po_number: '',
        rate_amount: '',
        rate_period: 'month',
        reserved_at: todayStr(),
        notes: '',
    })
    const [saving, setSaving] = useState(false)

    // Only trailers without an open rental can be reserved
    const rentableTrailers = trailers.filter(t => !t.open_rental_id && t.status !== 'retired')

    const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

    const handleSubmit = async () => {
        setSaving(true)
        try {
            await createRental({
                trailer_id: parseInt(form.trailer_id),
                job_site_id: form.job_site_id ? parseInt(form.job_site_id) : null,
                company_id: form.company_id ? parseInt(form.company_id) : null,
                po_number: form.po_number || null,
                rate_amount: form.rate_amount ? parseFloat(form.rate_amount) : null,
                rate_period: form.rate_period,
                reserved_at: form.reserved_at,
                notes: form.notes || null,
            })
            onCreated()
        } catch (err) {
            onError(err.message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
                <div className="modal-header">
                    <h2>New Rental</h2>
                    <button className="modal-close" onClick={onClose}>&times;</button>
                </div>
                <div style={{ padding: 20 }}>
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Trailer *</label>
                        <select className="input" value={form.trailer_id} onChange={set('trailer_id')}>
                            <option value="">— Select a trailer —</option>
                            {rentableTrailers.map(t => (
                                <option key={t.id} value={t.id}>
                                    {t.unit_number}{t.current_job_site_name ? ` (at ${t.current_job_site_name})` : ''}
                                </option>
                            ))}
                        </select>
                        {rentableTrailers.length === 0 && (
                            <p className="settings-desc" style={{ marginTop: 6 }}>No trailers available — all units have open rentals.</p>
                        )}
                    </div>
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Job Site</label>
                        <select className="input" value={form.job_site_id} onChange={set('job_site_id')}>
                            <option value="">— Select destination site —</option>
                            {jobSites.filter(js => !js.is_headquarters).map(js => (
                                <option key={js.id} value={js.id}>{js.name}</option>
                            ))}
                        </select>
                    </div>
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Company</label>
                        <select className="input" value={form.company_id} onChange={set('company_id')}>
                            <option value="">— Select customer —</option>
                            {companies.map(c => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                        </select>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">PO Number</label>
                            <input className="input" value={form.po_number} onChange={set('po_number')} placeholder="e.g. PO-4471" />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Reserved Date</label>
                            <input type="date" className="input" value={form.reserved_at} onChange={set('reserved_at')} />
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Rate ($)</label>
                            <input type="number" min="0" step="0.01" className="input" value={form.rate_amount} onChange={set('rate_amount')} placeholder="e.g. 1850" />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Per</label>
                            <select className="input" value={form.rate_period} onChange={set('rate_period')}>
                                <option value="day">Day</option>
                                <option value="week">Week</option>
                                <option value="month">Month (28-day)</option>
                            </select>
                        </div>
                    </div>
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Notes</label>
                        <textarea className="input" rows={2} value={form.notes} onChange={set('notes')} />
                    </div>
                    <div className="modal-footer">
                        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
                        <button className="btn btn-primary" onClick={handleSubmit} disabled={saving || !form.trailer_id}>
                            {saving ? 'Creating...' : 'Create Rental'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

export default RentalsPage
