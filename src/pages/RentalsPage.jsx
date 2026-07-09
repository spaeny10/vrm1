import { useState, useCallback, useMemo, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useToast } from '../components/ToastProvider'
import {
    fetchRentals, fetchRental, createRental, updateRental, postRentalEvent,
    fetchBillingSummary, fetchBillingAlerts,
    fetchTrailers, fetchJobSites, fetchCompanies, fetchRateCards,
} from '../api/vrm'
import {
    STATUS_LABELS, STATUS_ACTIONS, EVENT_LABELS, TERM_LABELS, CYCLE_LABELS,
    formatDate, formatMoney, todayStr, toDateInput, pricingLabel,
    RentalStatusBadge, RentalActionButtons, RentalEventModal,
} from '../components/RentalLifecycle'
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

function RentalsPage() {
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const toast = useToast()

    const [statusFilter, setStatusFilter] = useState('all')
    const [showNewRental, setShowNewRental] = useState(false)
    const [editingRental, setEditingRental] = useState(null)
    const [detailRental, setDetailRental] = useState(null) // { rental, events }
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

    // Reference data for the New/Edit Rental modals
    const [trailers, setTrailers] = useState([])
    const [jobSites, setJobSites] = useState([])
    const [companies, setCompanies] = useState([])
    const [rateCards, setRateCards] = useState([])

    useEffect(() => {
        if (!showNewRental && !editingRental) return
        Promise.all([fetchTrailers(), fetchJobSites(), fetchCompanies(), fetchRateCards()])
            .then(([t, j, c, rc]) => {
                setTrailers(t.trailers || [])
                setJobSites(j.job_sites || [])
                setCompanies(c.companies || [])
                setRateCards(rc.rate_cards || [])
            })
            .catch(err => toast.error(`Failed to load form data: ${err.message}`))
    }, [showNewRental, editingRental])

    const filteredRentals = useMemo(() => {
        if (statusFilter === 'all') return rentals.filter(r => r.status !== 'closed' && r.status !== 'cancelled')
        if (statusFilter === 'closed') return rentals.filter(r => r.status === 'closed' || r.status === 'cancelled')
        return rentals.filter(r => r.status === statusFilter)
    }, [rentals, statusFilter])

    // Dispatch board: what needs to physically move
    const dispatch = useMemo(() => {
        const open = rentals.filter(r => r.status !== 'closed' && r.status !== 'cancelled')
        return {
            deliveries: open.filter(r => r.status === 'reserved')
                .sort((a, b) => String(a.reserved_at).localeCompare(String(b.reserved_at))),
            pickups: open.filter(r => (r.status === 'awaiting_pickup' || r.status === 'called_off') && !r.picked_up_at)
                .sort((a, b) => String(a.calloff_at || a.billing_stop || '').localeCompare(String(b.calloff_at || b.billing_stop || ''))),
            inTransit: open.filter(r => r.status === 'awaiting_pickup' && r.picked_up_at),
        }
    }, [rentals])

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

    const openDetail = async (rental) => {
        try {
            const data = await fetchRental(rental.id)
            setDetailRental({ rental: data.rental, events: data.events || [] })
        } catch (err) {
            toast.error(err.message)
        }
    }

    const handleExportCSV = () => {
        const headers = ['Unit', 'Status', 'Job Site', 'Company', 'PO Number', 'Term', 'Effective Rate', 'Billing Cycle', 'Volume Tier', 'Billing Start', 'Billing Stop', 'Days on Rent', 'Accrued', 'Roll-Back Adj', 'Total Due']
        const rows = filteredRentals.map(r => [
            r.unit_number,
            STATUS_LABELS[r.status] || r.status,
            r.job_site_name || '',
            r.company_name || '',
            r.po_number || '',
            r.pricing_source === 'manual' ? 'Manual' : (TERM_LABELS[r.commitment_term] || r.commitment_term || ''),
            r.effective_rate ?? '',
            r.billing_cycle || '',
            r.volume_tier ? `${r.volume_tier.name} -${r.volume_tier.discount_pct}%` : '',
            r.billing_start ? String(r.billing_start).slice(0, 10) : '',
            r.billing_stop ? String(r.billing_stop).slice(0, 10) : '',
            r.days_on_rent ?? '',
            r.accrued_amount ?? '',
            r.rollback_amount ?? '',
            r.total_due ?? '',
        ])
        downloadCSV(generateCSV(headers, rows), `rentals-${todayStr()}.csv`)
    }

    const unitCell = (r) => r.vrm_site_id
        ? <Link to={`/trailer/${r.vrm_site_id}`} onClick={e => e.stopPropagation()} className="table-link">{r.unit_number}</Link>
        : r.unit_number

    const siteCell = (r) => r.job_site_id
        ? <Link to={`/site/${r.job_site_id}`} onClick={e => e.stopPropagation()} className="table-link">{r.job_site_name}</Link>
        : (r.job_site_name || '—')

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

            {/* Dispatch board: physical moves needed */}
            {(dispatch.deliveries.length > 0 || dispatch.pickups.length > 0 || dispatch.inTransit.length > 0) && (
                <div className="maint-table-section" style={{ marginBottom: 20 }}>
                    <div className="maint-group-header">
                        <h3>Dispatch</h3>
                        <span className="maint-group-count">
                            {dispatch.deliveries.length} deliver · {dispatch.pickups.length} pick up · {dispatch.inTransit.length} in transit
                        </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, padding: '12px 0' }}>
                        <DispatchColumn
                            title="Deliveries Due"
                            empty="No pending deliveries"
                            items={dispatch.deliveries}
                            dateLabel={r => `Reserved ${formatDate(r.reserved_at)}`}
                            canEdit={canEdit}
                            onAction={(r, ev) => setActionModal({ rental: r, event: ev })}
                            unitCell={unitCell} siteCell={siteCell}
                        />
                        <DispatchColumn
                            title="Pickups Due"
                            empty="No pending pickups"
                            items={dispatch.pickups}
                            dateLabel={r => r.calloff_at ? `Called off ${formatDate(r.calloff_at)}` : `Billing stopped ${formatDate(r.billing_stop)}`}
                            canEdit={canEdit}
                            onAction={(r, ev) => setActionModal({ rental: r, event: ev })}
                            unitCell={unitCell} siteCell={siteCell}
                        />
                        <DispatchColumn
                            title="In Transit"
                            empty="Nothing in transit"
                            items={dispatch.inTransit}
                            dateLabel={r => `Picked up ${formatDate(r.picked_up_at)}`}
                            canEdit={canEdit}
                            onAction={(r, ev) => setActionModal({ rental: r, event: ev })}
                            unitCell={unitCell} siteCell={siteCell}
                        />
                    </div>
                </div>
            )}

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
                                    <td style={{ width: 110, textAlign: 'right' }}>
                                        {a.rental_id && (
                                            <button className="btn btn-sm btn-secondary" onClick={() => {
                                                const r = rentals.find(x => x.id === a.rental_id)
                                                if (r) openDetail(r)
                                            }}>
                                                View Rental
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {summary.rentals_missing_rate > 0 && (
                <p className="settings-desc" style={{ marginBottom: 16 }}>
                    {summary.rentals_missing_rate} active rental{summary.rentals_missing_rate !== 1 ? 's have' : ' has'} no matching rate card and no manual rate — accrued totals are understated. Edit the rental to set a term or manual rate.
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
                                <tr key={r.id} className="maint-row" onClick={() => openDetail(r)} style={{ cursor: 'pointer' }}>
                                    <td className="maint-title">{unitCell(r)}</td>
                                    <td>{siteCell(r)}</td>
                                    <td>{r.company_name || '—'}</td>
                                    <td>{r.po_number || '—'}</td>
                                    <td>
                                        {r.effective_rate ? (
                                            <>
                                                <div>{formatMoney(r.effective_rate)}/{CYCLE_LABELS[r.billing_cycle] || r.billing_cycle}</div>
                                                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                                    {r.pricing_source === 'manual'
                                                        ? 'Manual rate'
                                                        : `${TERM_LABELS[r.commitment_term] || r.commitment_term}${r.volume_tier && r.volume_tier.discount_pct > 0 ? ` · ${r.volume_tier.name} −${r.volume_tier.discount_pct}%` : ''}`}
                                                </div>
                                            </>
                                        ) : '—'}
                                    </td>
                                    <td className="maint-date">{formatDate(r.billing_start)}</td>
                                    <td className="maint-date">{formatDate(r.billing_stop)}</td>
                                    <td>{r.days_on_rent ?? '—'}</td>
                                    <td className="maint-cost">
                                        {formatMoney(r.total_due ?? r.accrued_amount)}
                                        {r.rollback_amount > 0 && (
                                            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }} title="Roll-back adjustment for early termination of commitment">
                                                incl. +{formatMoney(r.rollback_amount)} roll-back
                                            </div>
                                        )}
                                    </td>
                                    <td><RentalStatusBadge status={r.status} /></td>
                                    {canEdit && (
                                        <td className="maint-actions">
                                            <button
                                                className="btn btn-sm btn-ghost"
                                                style={{ marginRight: 6 }}
                                                onClick={(e) => { e.stopPropagation(); setEditingRental(r) }}
                                            >
                                                Edit
                                            </button>
                                            <RentalActionButtons rental={r} onAction={(rental, event) => setActionModal({ rental, event })} />
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Rental detail drawer: summary + event timeline */}
            {detailRental && (
                <RentalDetailModal
                    rental={detailRental.rental}
                    events={detailRental.events}
                    canEdit={canEdit}
                    onAction={(rental, event) => { setDetailRental(null); setActionModal({ rental, event }) }}
                    onEdit={(rental) => { setDetailRental(null); setEditingRental(rental) }}
                    onClose={() => setDetailRental(null)}
                />
            )}

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
                    rateCards={rateCards}
                    onCreated={() => { setShowNewRental(false); refetchAll(); toast.success('Rental created') }}
                    onError={(msg) => toast.error(msg)}
                    onClose={() => setShowNewRental(false)}
                />
            )}

            {/* Edit rental modal */}
            {editingRental && (
                <EditRentalModal
                    rental={editingRental}
                    jobSites={jobSites}
                    companies={companies}
                    rateCards={rateCards}
                    onSaved={() => { setEditingRental(null); refetchAll(); toast.success('Rental updated') }}
                    onError={(msg) => toast.error(msg)}
                    onClose={() => setEditingRental(null)}
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

function RentalDetailModal({ rental, events, canEdit, onAction, onEdit, onClose }) {
    const r = rental
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
                <div className="modal-header">
                    <h2>{r.unit_number} — Rental #{r.id}</h2>
                    <button className="modal-close" onClick={onClose}>&times;</button>
                </div>
                <div style={{ padding: 20 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
                        <RentalStatusBadge status={r.status} />
                        {pricingLabel(r) && <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{pricingLabel(r)}</span>}
                    </div>
                    <div className="stat-row"><span className="stat-label">Customer</span><span className="stat-value">{r.company_name || '—'}</span></div>
                    <div className="stat-row"><span className="stat-label">Job Site</span><span className="stat-value">{r.job_site_name || '—'}</span></div>
                    <div className="stat-row"><span className="stat-label">PO Number</span><span className="stat-value">{r.po_number || '—'}</span></div>
                    <div className="stat-row"><span className="stat-label">Days on Rent</span><span className="stat-value">{r.days_on_rent ?? '—'}</span></div>
                    <div className="stat-row"><span className="stat-label">Accrued</span><span className="stat-value">{formatMoney(r.accrued_amount)}</span></div>
                    {r.rollback_amount > 0 && (
                        <div className="stat-row"><span className="stat-label">Roll-Back Adjustment</span><span className="stat-value">+{formatMoney(r.rollback_amount)}</span></div>
                    )}
                    <div className="stat-row"><span className="stat-label">Total Due</span><span className="stat-value">{formatMoney(r.total_due)}</span></div>
                    {r.notes && <div className="stat-row"><span className="stat-label">Notes</span><span className="stat-value">{r.notes}</span></div>}

                    <h3 style={{ margin: '18px 0 8px' }}>History</h3>
                    {events.length === 0 ? (
                        <p className="settings-desc">No events recorded yet.</p>
                    ) : (
                        <table className="maint-table">
                            <tbody>
                                {events.map(ev => (
                                    <tr key={ev.id}>
                                        <td className="maint-date" style={{ width: 110 }}>{formatDate(ev.event_date)}</td>
                                        <td className="maint-title">{EVENT_LABELS[ev.event_type] || ev.event_type}</td>
                                        <td style={{ color: 'var(--text-secondary)' }}>
                                            {ev.actor}{ev.notes ? ` — ${ev.notes}` : ''}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {canEdit && (
                        <div className="modal-footer" style={{ marginTop: 16 }}>
                            <button className="btn btn-ghost" onClick={() => onEdit(r)}>Edit Details</button>
                            <RentalActionButtons rental={r} onAction={onAction} size="sm" />
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

// Rate cards for the product of the selected trailer (fallback BV1305)
function cardsForTrailer(rateCards, trailers, trailerId) {
    const trailer = trailers.find(t => String(t.id) === String(trailerId))
    const product = trailer?.product_code || 'BV1305'
    return rateCards.filter(c => c.product_code === product)
}

export function termOptionLabel(card) {
    return `${TERM_LABELS[card.commitment_term] || card.commitment_term} — ${formatMoney(card.base_rate)}/${CYCLE_LABELS[card.billing_cycle] || card.billing_cycle}`
}

function NewRentalModal({ trailers, jobSites, companies, rateCards, onCreated, onError, onClose }) {
    const [form, setForm] = useState({
        trailer_id: '',
        job_site_id: '',
        company_id: '',
        po_number: '',
        commitment_term: 'monthly',
        rate_amount: '',
        rate_period: 'month',
        reserved_at: todayStr(),
        notes: '',
    })
    const [saving, setSaving] = useState(false)

    // Only trailers without an open rental can be reserved
    const rentableTrailers = trailers.filter(t => !t.open_rental_id && t.status !== 'retired')
    const availableCards = cardsForTrailer(rateCards, trailers, form.trailer_id)

    const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

    const handleSubmit = async () => {
        setSaving(true)
        try {
            await createRental({
                trailer_id: parseInt(form.trailer_id),
                job_site_id: form.job_site_id ? parseInt(form.job_site_id) : null,
                company_id: form.company_id ? parseInt(form.company_id) : null,
                po_number: form.po_number || null,
                commitment_term: form.commitment_term,
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
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Commitment Term</label>
                        <select className="input" value={form.commitment_term} onChange={set('commitment_term')}>
                            {availableCards.length > 0 ? availableCards.map(c => (
                                <option key={c.commitment_term} value={c.commitment_term}>{termOptionLabel(c)}</option>
                            )) : (
                                <>
                                    <option value="monthly">Monthly</option>
                                    <option value="6_month">6-Month</option>
                                    <option value="1_year">1-Year</option>
                                </>
                            )}
                        </select>
                        <p className="settings-desc" style={{ marginTop: 6 }}>
                            Pricing comes from the rate card; enterprise volume discounts (Bronze/Silver/Gold) apply automatically per billing cycle based on the customer's on-rent unit count. Early termination of 6-month/1-year commitments triggers the roll-back clause.
                        </p>
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
                            <label className="form-label">Manual Rate Override ($)</label>
                            <input type="number" min="0" step="0.01" className="input" value={form.rate_amount} onChange={set('rate_amount')} placeholder="Leave blank to use rate card" />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Override Per</label>
                            <select className="input" value={form.rate_period} onChange={set('rate_period')} disabled={!form.rate_amount}>
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

function EditRentalModal({ rental, jobSites, companies, rateCards, onSaved, onError, onClose }) {
    const [form, setForm] = useState({
        job_site_id: rental.job_site_id || '',
        company_id: rental.company_id || '',
        po_number: rental.po_number || '',
        commitment_term: rental.commitment_term || 'monthly',
        rate_amount: rental.rate_amount || '',
        rate_period: rental.rate_period || 'month',
        billing_start: toDateInput(rental.billing_start),
        calloff_at: toDateInput(rental.calloff_at),
        billing_stop: toDateInput(rental.billing_stop),
        notes: rental.notes || '',
    })
    const [saving, setSaving] = useState(false)

    const productCards = rateCards.filter(c => c.product_code === (rental.product_code || 'BV1305'))

    const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

    const handleSubmit = async () => {
        if (form.billing_start && form.billing_stop && form.billing_stop < form.billing_start) {
            onError('Billing stop cannot be before billing start')
            return
        }
        setSaving(true)
        try {
            await updateRental(rental.id, {
                job_site_id: form.job_site_id ? parseInt(form.job_site_id) : null,
                company_id: form.company_id ? parseInt(form.company_id) : null,
                po_number: form.po_number || null,
                commitment_term: form.commitment_term,
                rate_amount: form.rate_amount ? parseFloat(form.rate_amount) : null,
                rate_period: form.rate_period,
                billing_start: form.billing_start || null,
                calloff_at: form.calloff_at || null,
                billing_stop: form.billing_stop || null,
                notes: form.notes || null,
            })
            onSaved()
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
                    <h2>Edit Rental — {rental.unit_number}</h2>
                    <button className="modal-close" onClick={onClose}>&times;</button>
                </div>
                <div style={{ padding: 20 }}>
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Job Site</label>
                        <select className="input" value={form.job_site_id} onChange={set('job_site_id')}>
                            <option value="">— None —</option>
                            {jobSites.filter(js => !js.is_headquarters).map(js => (
                                <option key={js.id} value={js.id}>{js.name}</option>
                            ))}
                        </select>
                    </div>
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Company</label>
                        <select className="input" value={form.company_id} onChange={set('company_id')}>
                            <option value="">— None —</option>
                            {companies.map(c => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                        </select>
                    </div>
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Commitment Term</label>
                        <select className="input" value={form.commitment_term} onChange={set('commitment_term')}>
                            {productCards.length > 0 ? productCards.map(c => (
                                <option key={c.commitment_term} value={c.commitment_term}>{termOptionLabel(c)}</option>
                            )) : (
                                <>
                                    <option value="monthly">Monthly</option>
                                    <option value="6_month">6-Month</option>
                                    <option value="1_year">1-Year</option>
                                </>
                            )}
                        </select>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">PO Number</label>
                            <input className="input" value={form.po_number} onChange={set('po_number')} />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Manual Rate Override ($)</label>
                            <input type="number" min="0" step="0.01" className="input" value={form.rate_amount} onChange={set('rate_amount')} placeholder="Blank = rate card" />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Override Per</label>
                            <select className="input" value={form.rate_period} onChange={set('rate_period')} disabled={!form.rate_amount}>
                                <option value="day">Day</option>
                                <option value="week">Week</option>
                                <option value="month">Month (28-day)</option>
                            </select>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Billing Start</label>
                            <input type="date" className="input" value={form.billing_start} onChange={set('billing_start')} />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Calloff</label>
                            <input type="date" className="input" value={form.calloff_at} onChange={set('calloff_at')} />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Billing Stop</label>
                            <input type="date" className="input" value={form.billing_stop} onChange={set('billing_stop')} />
                        </div>
                    </div>
                    <p className="settings-desc" style={{ marginBottom: 14 }}>
                        Date fields here are for corrections and are audit-logged. Normal lifecycle changes (deliver, start/stop billing, pickup, return) should use the action buttons so the event trail stays complete.
                    </p>
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Notes</label>
                        <textarea className="input" rows={2} value={form.notes} onChange={set('notes')} />
                    </div>
                    <div className="modal-footer">
                        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
                        <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
                            {saving ? 'Saving...' : 'Save Changes'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

export default RentalsPage
