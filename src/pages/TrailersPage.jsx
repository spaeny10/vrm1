import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useWorkspace } from '../components/WorkspaceProvider'
import { fetchBoardTrailers } from '../api/vrm'
import { Page, Card, DataTable, Chips, Search, HealthBadge, Soc, Signal, Grade, Loading, Icon, Empty } from '../ui'
import { fmtAgo, fmtKwh, fmtDate } from '../ui/format'
import { RentalStatusBadge, TrailerStatusBadge } from '../components/RentalLifecycle'
import TrailerFormModal from '../components/TrailerFormModal'
import { generateCSV, downloadCSV } from '../utils/csv'

const HEALTH_CHIPS = [
    { key: 'all', label: 'All' },
    { key: 'attention', label: 'Needs attention', dot: 'crit' },
    { key: 'offline', label: 'Offline', dot: 'off' },
    { key: 'watch', label: 'Watch', dot: 'warn' },
    { key: 'good', label: 'Healthy', dot: 'ok' },
]

const ASSET_CHIPS = [
    { key: 'all', label: 'All' },
    { key: 'on_rent', label: 'On rent' },
    { key: 'available', label: 'Available' },
    { key: 'reserved', label: 'Reserved' },
    { key: 'in_transit', label: 'In transit' },
    { key: 'issues', label: 'Has issues', dot: 'crit' },
]

// One list of every trailer. Tech sees health and telemetry; Fleet sees
// location, customer and rental. Both share the same board data.
export default function TrailersPage() {
    const navigate = useNavigate()
    const { user } = useAuth()
    const { workspace } = useWorkspace()
    const [params, setParams] = useSearchParams()
    const isTech = workspace === 'tech'
    const canEdit = user?.role === 'admin' || user?.role === 'technician'

    const [q, setQ] = useState('')
    const filter = params.get(isTech ? 'health' : 'status') || (params.get('health') && !isTech ? 'issues' : 'all')
    const setFilter = (v) => setParams(v === 'all' ? {} : { [isTech ? 'health' : 'status']: v }, { replace: true })
    const [editing, setEditing] = useState(null) // trailer id or 'new'

    const fetchFn = useCallback(() => fetchBoardTrailers(), [])
    const { data, loading, refetch } = useApiPolling(fetchFn, 60000)
    const rows = data?.trailers || []

    const counts = useMemo(() => {
        const c = { all: rows.length, issues: 0 }
        for (const r of rows) {
            c[r.health] = (c[r.health] || 0) + 1
            if (r.asset_status) c[r.asset_status] = (c[r.asset_status] || 0) + 1
            if (r.health === 'attention' || r.health === 'offline') c.issues++
        }
        return c
    }, [rows])

    const filtered = useMemo(() => {
        const term = q.trim().toLowerCase()
        return rows.filter(r => {
            if (filter !== 'all') {
                if (isTech && r.health !== filter) return false
                if (!isTech && filter === 'issues' && !(r.health === 'attention' || r.health === 'offline')) return false
                if (!isTech && filter !== 'issues' && r.asset_status !== filter) return false
            }
            if (!term) return true
            return [r.unit, r.vin, r.site?.name, r.customer?.name, r.diagnosis].some(v => v && String(v).toLowerCase().includes(term))
        })
    }, [rows, q, filter, isTech])

    const open = (r) => {
        if (r.site_id != null) navigate(`/trailer/${r.site_id}`)
        else if (r.trailer_id && canEdit) setEditing(r.trailer_id)
    }

    const techColumns = [
        { key: 'unit', label: 'Trailer', sort: r => r.unit, render: r => <span className="primary">{r.unit}</span> },
        {
            key: 'health', label: 'Health', sort: r => ['offline', 'attention', 'watch', 'good', 'unknown'].indexOf(r.health),
            render: r => <div><HealthBadge health={r.health} />{r.diagnosis && r.health !== 'good' && <div className="sub" style={{ marginTop: 4, maxWidth: 360 }}>{r.diagnosis}</div>}</div>
        },
        { key: 'soc', label: 'Battery', sort: r => r.soc, render: r => <Soc value={r.soc} /> },
        {
            key: 'solar', label: 'Solar today', align: 'r', sort: r => r.yield_today_kwh,
            render: r => r.yield_today_kwh == null ? <span className="faint">—</span> : <span className="num">{fmtKwh(r.yield_today_kwh)}{r.expected_yield_kwh ? <span className="faint"> / {r.expected_yield_kwh.toFixed(1)}</span> : null}</span>
        },
        { key: 'signal', label: 'Signal', sort: r => (r.online ? r.signal_bars ?? 0 : -1), render: r => r.site_id == null ? <span className="faint">—</span> : <Signal bars={r.signal_bars} online={r.online} /> },
        { key: 'grade', label: 'Grade', sort: r => r.grade, render: r => <Grade grade={r.grade} /> },
        { key: 'site', label: 'Site', sort: r => r.site?.name, render: r => r.site ? <span className="muted">{r.site.name}</span> : <span className="faint">Unassigned</span> },
        { key: 'seen', label: 'Last data', align: 'r', sort: r => -(r.last_seen || 0), render: r => <span className="faint">{fmtAgo(r.last_seen)}</span> },
    ]

    const fleetColumns = [
        { key: 'unit', label: 'Trailer', sort: r => r.unit, render: r => <div><span className="primary">{r.unit}</span>{r.product_code && <div className="sub">{r.product_code}</div>}</div> },
        { key: 'asset', label: 'Status', sort: r => r.asset_status, render: r => <TrailerStatusBadge status={r.asset_status} /> },
        {
            key: 'where', label: 'Location', sort: r => r.site?.name,
            render: r => r.site ? <div><Link to={`/site/${r.site.id}`} className="link" onClick={e => e.stopPropagation()}>{r.site.name}</Link>{r.customer && <div className="sub">{r.customer.name}</div>}</div> : <span className="faint">Unassigned</span>
        },
        {
            key: 'rental', label: 'Rental', sort: r => r.rental?.status,
            render: r => r.rental ? <div><RentalStatusBadge status={r.rental.status} />{r.rental.billing_start && <div className="sub" style={{ marginTop: 4 }}>since {fmtDate(r.rental.billing_start)}</div>}</div> : <span className="faint">—</span>
        },
        { key: 'health', label: 'Health', sort: r => ['offline', 'attention', 'watch', 'good', 'unknown'].indexOf(r.health), render: r => <HealthBadge health={r.health} /> },
        { key: 'seen', label: 'Last data', align: 'r', sort: r => -(r.last_seen || 0), render: r => <span className="faint">{fmtAgo(r.last_seen)}</span> },
    ]

    const exportCsv = () => {
        const headers = ['Unit', 'Health', 'Diagnosis', 'Battery %', 'Solar today kWh', 'Signal bars', 'Site', 'Customer', 'Rental', 'Asset status']
        downloadCSV(generateCSV(headers, filtered.map(r => [
            r.unit, r.health, r.diagnosis || '', r.soc ?? '', r.yield_today_kwh ?? '', r.signal_bars ?? '',
            r.site?.name || '', r.customer?.name || '', r.rental?.status || '', r.asset_status || '',
        ])), `trailers-${new Date().toISOString().slice(0, 10)}.csv`)
    }

    const chips = (isTech ? HEALTH_CHIPS : ASSET_CHIPS).map(c => ({ ...c, count: counts[c.key] ?? 0 }))

    return (
        <Page title="Trailers" sub={isTech ? 'Health and telemetry for every unit' : 'Where every unit is and whether it’s earning'}
            actions={<>
                <button className="btn" onClick={exportCsv} disabled={!filtered.length}><Icon name="download" />Export</button>
                {canEdit && !isTech && <button className="btn primary" onClick={() => setEditing('new')}><Icon name="plus" />Add trailer</button>}
            </>}>
            <div>
                <div className="toolbar">
                    <Search value={q} onChange={setQ} placeholder="Search unit, site, customer…" />
                    <Chips options={chips} value={filter} onChange={setFilter} />
                </div>
                <Card flush>
                    {loading && !data ? <Loading /> : (
                        <DataTable columns={isTech ? techColumns : fleetColumns} rows={filtered} rowKey="key" onRowClick={open}
                            empty={<Empty compact title={rows.length ? 'No trailers match' : 'No trailers yet'}>{rows.length ? 'Try a different search or filter.' : 'Trailers appear here as they report in, or add one to the registry.'}</Empty>} />
                    )}
                </Card>
            </div>
            {editing && <TrailerFormModal trailerId={editing === 'new' ? null : editing} onSaved={refetch} onClose={() => setEditing(null)} />}
        </Page>
    )
}
