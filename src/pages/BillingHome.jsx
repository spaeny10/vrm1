import { useCallback, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchBillingSummary, fetchBillingAlerts, fetchBillingStatements } from '../api/vrm'
import { Page, Card, Stats, Stat, Dot, DataTable, AllClear, Loading, Icon } from '../ui'
import { fmtMoney, fmtDate, todayISO, plural } from '../ui/format'
import { RentalStatusBadge, pricingLabel, useRentalEventFlow } from '../components/RentalLifecycle'

// Which billing action fixes each alert type
const FIX = {
    delivered_not_billing: { label: 'Start billing', event: 'start_billing' },
    billing_past_calloff: { label: 'Stop billing', event: 'stop_billing' },
    billing_at_hq: { label: 'Stop billing', event: 'stop_billing' },
}

// Billing workspace home: is the money right, and what needs fixing.
export default function BillingHome() {
    const navigate = useNavigate()
    const month = todayISO().slice(0, 7)
    const summaryFn = useCallback(() => fetchBillingSummary(), [])
    const alertsFn = useCallback(() => fetchBillingAlerts(), [])
    const stmtFn = useCallback(() => fetchBillingStatements(month), [month])
    const { data: summaryData, loading, refetch: refetchSummary } = useApiPolling(summaryFn, 60000)
    const { data: alertsData, refetch: refetchAlerts } = useApiPolling(alertsFn, 60000)
    const { data: stmt } = useApiPolling(stmtFn, 300000)

    const flow = useRentalEventFlow(() => { refetchSummary(); refetchAlerts() })
    const s = summaryData?.summary || {}
    const rentals = summaryData?.rentals || []
    const alerts = alertsData?.alerts || []
    const rentalById = useMemo(() => new Map(rentals.map(r => [r.id, r])), [rentals])
    const billingNow = rentals.filter(r => r.status === 'billing' || r.status === 'called_off')
    const missingRate = billingNow.filter(r => r.accrued_amount == null)

    const columns = [
        { key: 'unit', label: 'Unit', sort: r => r.unit_number, render: r => <span className="primary">{r.unit_number}</span> },
        { key: 'customer', label: 'Customer', sort: r => r.company_name, render: r => r.company_name || <span className="faint">—</span> },
        { key: 'site', label: 'Site', sort: r => r.job_site_name, render: r => r.job_site_id ? <Link className="link" to={`/site/${r.job_site_id}`} onClick={e => e.stopPropagation()}>{r.job_site_name}</Link> : '—' },
        { key: 'rate', label: 'Rate', render: r => pricingLabel(r) || <span className="badge crit">No rate</span> },
        { key: 'start', label: 'Billing since', sort: r => r.billing_start, render: r => fmtDate(r.billing_start) },
        { key: 'days', label: 'Days', align: 'r', sort: r => r.days_on_rent, render: r => <span className="num">{r.days_on_rent ?? '—'}</span> },
        { key: 'due', label: 'Accrued', align: 'r', sort: r => r.total_due, render: r => <span className="num">{fmtMoney(r.total_due ?? r.accrued_amount)}</span> },
        { key: 'status', label: 'Status', render: r => <RentalStatusBadge status={r.status} /> },
    ]

    return (
        <Page title="Billing" sub={`Revenue for ${new Date().toLocaleDateString([], { month: 'long', year: 'numeric' })}`}
            actions={<>
                <Link to="/statements" className="btn primary"><Icon name="doc" />Monthly statements</Link>
                <Link to="/rentals" className="btn">All rentals</Link>
            </>}>
            <Stats>
                <Stat label="Accrued this month" value={summaryData ? fmtMoney(s.accrued_mtd, { cents: false }) : '—'} hint={stmt ? `${plural(stmt.companies?.length || 0, 'customer')} billed` : null} />
                <Stat label="Billing now" value={s.rentals_billing ?? '—'} hint={`${s.rentals_open ?? 0} open rentals`} dot="ok" />
                <Stat label="Open accruals" value={summaryData ? fmtMoney(s.accrued_total_open, { cents: false }) : '—'} hint="Since billing start, all open rentals" />
                <Stat label="Needs fixing" value={alertsData ? alerts.length + missingRate.length : '—'} tone={alerts.length + missingRate.length ? 'crit' : 'ok'} hint="Leaks and missing rates" />
            </Stats>

            <Card title="Fix these" meta={alerts.length + missingRate.length || null} flush>
                {!alertsData ? <Loading /> : alerts.length + missingRate.length === 0 ? (
                    <AllClear>Billing matches the fleet — no leaks, no missing rates.</AllClear>
                ) : (
                    <div className="list">
                        {alerts.map((a, i) => {
                            const fix = FIX[a.type]
                            const rental = a.rental_id ? rentalById.get(a.rental_id) : null
                            return (
                                <div key={i} className="list-row">
                                    <Dot tone={a.severity === 'critical' ? 'crit' : 'warn'} />
                                    <div className="main">
                                        <div className="title">{a.unit_number}</div>
                                        <div className="desc">{a.message}</div>
                                    </div>
                                    {fix && rental && <button className="btn sm primary" onClick={() => flow.start(rental, fix.event)}>{fix.label}</button>}
                                    {a.type === 'unbilled_deployed' && (
                                        <button className="btn sm primary" onClick={() => navigate(`/rentals?new=1&trailer_id=${a.trailer_id}`)}>Create rental</button>
                                    )}
                                </div>
                            )
                        })}
                        {missingRate.map(r => (
                            <div key={`rate-${r.id}`} className="list-row">
                                <Dot tone="warn" />
                                <div className="main">
                                    <div className="title">{r.unit_number}</div>
                                    <div className="desc">Billing with no rate card match and no manual rate — accruals are understated.</div>
                                </div>
                                <button className="btn sm" onClick={() => navigate(`/rentals?edit=${r.id}`)}>Set rate</button>
                            </div>
                        ))}
                    </div>
                )}
            </Card>

            <Card title="Currently billing" meta={billingNow.length || null} flush>
                {loading && !summaryData ? <Loading /> : (
                    <DataTable columns={columns} rows={billingNow} initialSort={{ key: 'customer', dir: 'asc' }}
                        onRowClick={r => navigate(`/rentals?open=${r.id}`)}
                        empty={<AllClear>Nothing is billing right now.</AllClear>} />
                )}
            </Card>
            {flow.modal}
        </Page>
    )
}
