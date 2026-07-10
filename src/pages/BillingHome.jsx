import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchBillingSummary, fetchBillingAlerts } from '../api/vrm'
import { formatDate, formatMoney, pricingLabel, RentalStatusBadge } from '../components/RentalLifecycle'

// Billing workspace home: is the money right, and what needs fixing.
function BillingHome() {
    const fetchSummaryFn = useCallback(() => fetchBillingSummary(), [])
    const fetchAlertsFn = useCallback(() => fetchBillingAlerts(), [])

    const { data: summaryData } = useApiPolling(fetchSummaryFn, 60000)
    const { data: alertsData } = useApiPolling(fetchAlertsFn, 60000)

    const summary = summaryData?.summary || {}
    const rentals = summaryData?.rentals || []
    const alerts = alertsData?.alerts || []

    const billingNow = rentals.filter(r => r.status === 'billing' || r.status === 'called_off')

    return (
        <div className="page">
            <div className="page-header">
                <div className="page-header-row">
                    <h1>Billing</h1>
                    <div className="page-header-actions">
                        <Link to="/rentals?view=statements" className="btn btn-primary">Monthly Statements</Link>
                        <Link to="/rentals" className="btn btn-secondary">All Rentals</Link>
                    </div>
                </div>
                <p className="page-subtitle">Revenue at a glance — accruals, leaks, and month-end statements</p>
            </div>

            {/* Money KPIs */}
            <div className="kpi-row">
                <div className="kpi-card kpi-yellow">
                    <div className="kpi-value">{formatMoney(summary.accrued_mtd)}</div>
                    <div className="kpi-label">Accrued This Month</div>
                </div>
                <div className="kpi-card kpi-green">
                    <div className="kpi-value">{summary.rentals_billing ?? '—'}</div>
                    <div className="kpi-label">Rentals Billing</div>
                </div>
                <div className="kpi-card kpi-blue">
                    <div className="kpi-value">{formatMoney(summary.accrued_total_open)}</div>
                    <div className="kpi-label">Open Accruals Total</div>
                </div>
                <div className={`kpi-card ${alerts.length > 0 ? 'kpi-red' : ''}`}>
                    <div className="kpi-value">{alerts.length}</div>
                    <div className="kpi-label">Billing Alerts</div>
                </div>
                <div className={`kpi-card ${summary.rentals_missing_rate > 0 ? 'kpi-red' : ''}`}>
                    <div className="kpi-value">{summary.rentals_missing_rate ?? 0}</div>
                    <div className="kpi-label">Missing Rates</div>
                </div>
            </div>

            {/* Revenue leaks first — this is the money page */}
            <div className="maint-table-section" style={{ marginBottom: 20 }}>
                <div className="maint-group-header">
                    <h3>Billing Alerts</h3>
                    <span className="maint-group-count">{alerts.length} issue{alerts.length !== 1 ? 's' : ''}</span>
                </div>
                {alerts.length === 0 ? (
                    <p className="settings-desc" style={{ padding: '8px 0' }}>
                        No revenue leaks detected — nothing billing past its call-off, nothing billing from HQ, no unbilled deployed trailers.
                    </p>
                ) : (
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
                                        <Link to="/rentals" className="btn btn-sm btn-secondary">Open Rentals</Link>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* What's earning right now */}
            <div className="maint-table-section">
                <div className="maint-group-header">
                    <h3>Currently Billing</h3>
                    <span className="maint-group-count">{billingNow.length} rental{billingNow.length !== 1 ? 's' : ''}</span>
                </div>
                {billingNow.length === 0 ? (
                    <p className="settings-desc" style={{ padding: '8px 0' }}>Nothing is billing right now.</p>
                ) : (
                    <table className="maint-table">
                        <thead>
                            <tr>
                                <th>Unit</th>
                                <th>Customer</th>
                                <th>Job Site</th>
                                <th>PO #</th>
                                <th>Rate</th>
                                <th>Billing Start</th>
                                <th>Days</th>
                                <th>Accrued</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {billingNow.map(r => (
                                <tr key={r.id}>
                                    <td className="maint-title">
                                        {r.vrm_site_id
                                            ? <Link to={`/trailer/${r.vrm_site_id}`} className="table-link">{r.unit_number}</Link>
                                            : r.unit_number}
                                    </td>
                                    <td>{r.company_name || '—'}</td>
                                    <td>{r.job_site_id
                                        ? <Link to={`/site/${r.job_site_id}`} className="table-link">{r.job_site_name}</Link>
                                        : (r.job_site_name || '—')}</td>
                                    <td>{r.po_number || '—'}</td>
                                    <td style={{ fontSize: 13 }}>{pricingLabel(r) || '—'}</td>
                                    <td className="maint-date">{formatDate(r.billing_start)}</td>
                                    <td>{r.days_on_rent ?? '—'}</td>
                                    <td className="maint-cost">{formatMoney(r.total_due ?? r.accrued_amount)}</td>
                                    <td><RentalStatusBadge status={r.status} /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    )
}

export default BillingHome
