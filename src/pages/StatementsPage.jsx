import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchBillingStatements } from '../api/vrm'
import { generateCSV, downloadCSV } from '../utils/csv'
import { Page, Card, Stats, Stat, DataTable, Empty, Loading, Icon } from '../ui'
import { fmtMoney, todayISO, plural } from '../ui/format'
import { TERM_LABELS, CYCLE_LABELS } from '../components/RentalLifecycle'

function monthLabel(ym) {
    const [y, m] = ym.split('-').map(Number)
    return new Date(y, m - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })
}

function shiftMonth(ym, n) {
    const [y, m] = ym.split('-').map(Number)
    const d = new Date(y, m - 1 + n, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Invoice-ready charges per customer for a calendar month
export default function StatementsPage() {
    const [month, setMonth] = useState(todayISO().slice(0, 7))
    const fetchFn = useCallback(() => fetchBillingStatements(month), [month])
    const { data, loading } = useApiPolling(fetchFn, 300000)
    const companies = data?.companies || []
    const lines = companies.reduce((n, c) => n + c.lines.length, 0)
    const rollbacks = companies.reduce((s, c) => s + (c.rollback_total || 0), 0)

    const columns = [
        { key: 'unit', label: 'Unit', render: l => <span className="primary">{l.unit_number}</span> },
        { key: 'site', label: 'Site', render: l => l.job_site_name || <span className="faint">—</span> },
        { key: 'po', label: 'PO', render: l => l.po_number || <span className="faint">—</span> },
        {
            key: 'rate', label: 'Rate', render: l => l.effective_rate
                ? <span className="muted">{fmtMoney(l.effective_rate)} / {CYCLE_LABELS[l.billing_cycle] || l.billing_cycle}{l.pricing_source === 'manual' ? ' (manual)' : ` · ${TERM_LABELS[l.commitment_term] || ''}`}{l.volume_tier?.discount_pct > 0 ? ` · ${l.volume_tier.name} −${l.volume_tier.discount_pct}%` : ''}</span>
                : '—'
        },
        { key: 'days', label: 'Days', align: 'r', render: l => <span className="num">{l.days_in_month}</span> },
        { key: 'amount', label: 'Amount', align: 'r', render: l => <span className="num">{fmtMoney(l.amount)}</span> },
        { key: 'rb', label: 'Roll-back', align: 'r', render: l => l.rollback_adjustment ? <span className="num">{fmtMoney(l.rollback_adjustment)}</span> : <span className="faint">—</span> },
        { key: 'total', label: 'Line total', align: 'r', render: l => <b className="num">{fmtMoney(l.line_total)}</b> },
    ]

    const exportCsv = (c) => {
        const headers = ['Unit', 'Site', 'PO', 'Rate', 'Days', 'Amount', 'Roll-back', 'Line total']
        const rows = c.lines.map(l => [l.unit_number, l.job_site_name || '', l.po_number || '', l.effective_rate ?? '', l.days_in_month, l.amount, l.rollback_adjustment || '', l.line_total])
        rows.push([], ['', '', '', '', '', 'Subtotal', '', c.subtotal], ['', '', '', '', '', 'Roll-back', '', c.rollback_total], ['', '', '', '', '', 'Total', '', c.total])
        downloadCSV(generateCSV(headers, rows), `statement-${c.company_name.replace(/[^\w-]+/g, '_')}-${month}.csv`)
    }

    return (
        <Page title="Statements" sub="Charges per customer for the month — ready to invoice"
            actions={<>
                <button className="btn ghost" onClick={() => setMonth(m => shiftMonth(m, -1))} aria-label="Previous month"><Icon name="back" /></button>
                <input type="month" className="input" style={{ width: 170 }} value={month} onChange={e => e.target.value && setMonth(e.target.value)} />
                <button className="btn ghost" onClick={() => setMonth(m => shiftMonth(m, 1))} aria-label="Next month"><Icon name="chevron" /></button>
            </>}>
            <Stats>
                <Stat label={`Total for ${monthLabel(month)}`} value={data ? fmtMoney(data.grand_total) : '—'} />
                <Stat label="Customers" value={data ? companies.length : '—'} />
                <Stat label="Billed units" value={data ? lines : '—'} />
                <Stat label="Roll-back adjustments" value={data ? fmtMoney(rollbacks) : '—'} hint="Early-terminated commitments" />
            </Stats>

            {loading && !data ? <Card><Loading label="Building statements…" /></Card> : companies.length === 0 ? (
                <Card><Empty title={`No billable activity in ${monthLabel(month)}`}>Statements fill in as rentals bill.</Empty></Card>
            ) : companies.map(c => (
                <Card key={c.company_id ?? 'none'} flush
                    title={c.company_id ? <Link to={`/customers?company=${c.company_id}`} className="link">{c.company_name}</Link> : c.company_name}
                    meta={plural(c.lines.length, 'unit')}
                    actions={<>
                        <b className="num" style={{ marginRight: 8 }}>{fmtMoney(c.total)}</b>
                        <button className="btn sm" onClick={() => exportCsv(c)}><Icon name="download" />CSV</button>
                        <button className="btn sm primary" onClick={() => import('../utils/statementPdf').then(m => m.generateStatementPDF(c, month))}><Icon name="doc" />PDF</button>
                    </>}
                    foot={<span>Subtotal {fmtMoney(c.subtotal)}{c.rollback_total > 0 ? ` · Roll-back ${fmtMoney(c.rollback_total)}` : ''} · <b style={{ color: 'var(--text)' }}>Total {fmtMoney(c.total)}</b></span>}>
                    <DataTable columns={columns} rows={c.lines} rowKey="rental_id" />
                </Card>
            ))}
        </Page>
    )
}
