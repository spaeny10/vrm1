import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useWorkspace } from '../components/WorkspaceProvider'
import { fetchBoardTrailers } from '../api/vrm'
import { Page, Card, DataTable, Chips, Search, HealthBadge, Badge, Soc, Signal, Grade, Loading, Icon, Empty } from '../ui'
import { HEALTH, fmtAgo, fmtKwh, fmtDate, plural } from '../ui/format'
import RecordsToFix from '../components/RecordsToFix'
import { RentalStatusBadge, TrailerStatusBadge } from '../components/RentalLifecycle'
import TrailerFormModal from '../components/TrailerFormModal'
import { generateCSV, downloadCSV } from '../utils/csv'

const HEALTH_SORT = ['offline', 'attention', 'watch', 'unknown', 'good', 'inactive']

const HEALTH_CHIPS = [
    { key: 'all', label: 'All' },
    { key: 'attention', label: 'Needs attention', dot: 'crit' },
    { key: 'offline', label: 'Offline', dot: 'off' },
    { key: 'watch', label: 'Watch', dot: 'warn' },
    { key: 'unknown', label: 'Not monitored', dot: 'warn', hideEmpty: true },
    { key: 'good', label: 'Healthy', dot: 'ok' },
    { key: 'inactive', label: 'Not in service', dot: 'off' },
]

const ASSET_CHIPS = [
    { key: 'all', label: 'All' },
    { key: 'on_rent', label: 'On rent' },
    { key: 'reserved', label: 'Reserved', hideEmpty: true },
    { key: 'no_rental', label: 'At a site, no rental', dot: 'warn', hideEmpty: true },
    { key: 'ready', label: 'Ready to deploy', dot: 'ok' },
    { key: 'not_ready', label: 'In yard, not ready', dot: 'off' },
    { key: 'issues', label: 'Has issues', dot: 'crit' },
]

// Fleet filters describe where a unit is in its working life, which the
// registry status alone can't say (an "available" unit may be at a customer site)
const FLEET_FILTERS = {
    on_rent: r => !!r.rental && r.rental.status !== 'reserved',
    reserved: r => r.rental?.status === 'reserved',
    no_rental: r => r.in_service && !r.rental,
    ready: r => !r.in_service && !!r.yard?.ready,
    not_ready: r => !r.in_service && !r.yard?.ready,
    issues: r => r.health === 'attention' || r.health === 'offline',
}

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
    const [showIssues, setShowIssues] = useState(false)

    const fetchFn = useCallback(() => fetchBoardTrailers(), [])
    const { data, loading, refetch } = useApiPolling(fetchFn, 60000)
    const rows = data?.trailers || []

    const counts = useMemo(() => {
        const c = { all: rows.length }
        for (const r of rows) c[r.health] = (c[r.health] || 0) + 1
        for (const [key, test] of Object.entries(FLEET_FILTERS)) c[key] = rows.filter(test).length
        return c
    }, [rows])

    const filtered = useMemo(() => {
        const term = q.trim().toLowerCase()
        return rows.filter(r => {
            if (filter !== 'all') {
                if (isTech && r.health !== filter) return false
                if (!isTech && FLEET_FILTERS[filter] && !FLEET_FILTERS[filter](r)) return false
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
            key: 'health', label: 'Health', sort: r => HEALTH_SORT.indexOf(r.health),
            render: r => <div><HealthBadge health={r.health} />{r.diagnosis && r.health !== 'good' && <div className="sub" style={{ marginTop: 4, maxWidth: 360, whiteSpace: 'normal' }}>{r.diagnosis}</div>}</div>
        },
        { key: 'soc', label: 'Battery', sort: r => r.soc, render: r => <Soc value={r.soc} /> },
        {
            key: 'solar', label: 'Solar today', align: 'r', sort: r => r.yield_today_kwh,
            render: r => r.yield_today_kwh == null ? <span className="faint">—</span> : <span className="num">{fmtKwh(r.yield_today_kwh)}{r.expected_yield_kwh ? <span className="faint"> / {r.expected_yield_kwh.toFixed(1)}</span> : null}</span>
        },
        { key: 'signal', label: 'Signal', sort: r => (r.online ? r.signal_bars ?? 0 : -1), render: r => <Signal bars={r.signal_bars} online={r.online} hasRouter={r.has_router} /> },
        { key: 'grade', label: 'Grade', sort: r => r.grade, render: r => <Grade grade={r.grade} /> },
        { key: 'site', label: 'Site', sort: r => r.site?.name, render: r => r.site ? <span className="muted">{r.site.name}</span> : <span className="faint">No site</span> },
        { key: 'seen', label: 'Last data', align: 'r', sort: r => -(r.last_seen || 0), render: r => <span className="faint">{fmtAgo(r.last_seen)}</span> },
    ]

    const fleetColumns = [
        { key: 'unit', label: 'Trailer', sort: r => r.unit, render: r => <div><span className="primary">{r.unit}</span>{r.product_code && <div className="sub">{r.product_code}</div>}</div> },
        { key: 'asset', label: 'Status', sort: r => r.asset_status, render: r => <TrailerStatusBadge status={r.asset_status} /> },
        {
            key: 'where', label: 'Location', sort: r => r.site?.name,
            render: r => r.site ? <div><Link to={`/site/${r.site.id}`} className="link" onClick={e => e.stopPropagation()}>{r.site.name}</Link>{r.customer && <div className="sub">{r.customer.name}</div>}</div> : <span className="faint">No site</span>
        },
        {
            key: 'rental', label: 'Rental', sort: r => r.rental?.status,
            render: r => r.rental ? <div><RentalStatusBadge status={r.rental.status} />{r.rental.billing_start && <div className="sub" style={{ marginTop: 4 }}>since {fmtDate(r.rental.billing_start)}</div>}</div> : <span className="faint">—</span>
        },
        {
            // In the yard the question isn't health, it's whether the unit can ship
            key: 'health', label: 'Condition', sort: r => HEALTH_SORT.indexOf(r.health) + (r.yard?.ready ? 0.5 : 0),
            render: r => r.in_service
                ? <div><HealthBadge health={r.health} />{r.diagnosis && r.health !== 'good' && <div className="sub" style={{ marginTop: 4, maxWidth: 300, whiteSpace: 'normal' }}>{r.diagnosis}</div>}</div>
                : <div><Badge tone={r.yard?.ready ? 'ok' : 'off'} dot>{r.yard?.ready ? 'Ready to deploy' : 'Not ready'}</Badge>{!r.yard?.ready && r.diagnosis && <div className="sub" style={{ marginTop: 4, maxWidth: 300, whiteSpace: 'normal' }}>{r.diagnosis}</div>}</div>
        },
        { key: 'seen', label: 'Last data', align: 'r', sort: r => -(r.last_seen || 0), render: r => <span className="faint">{fmtAgo(r.last_seen)}</span> },
    ]

    const exportCsv = () => {
        const headers = ['Unit', 'In service', 'Health', 'Diagnosis', 'Battery %', 'Solar today kWh', 'Signal bars', 'Site', 'Customer', 'Rental', 'Asset status']
        downloadCSV(generateCSV(headers, filtered.map(r => [
            r.unit, r.in_service ? 'yes' : 'no', HEALTH[r.health]?.label || r.health, r.diagnosis || '', r.soc ?? '', r.yield_today_kwh ?? '', r.signal_bars ?? '',
            r.site?.name || '', r.customer?.name || '', r.rental?.status || '', r.asset_status || '',
        ])), `trailers-${new Date().toISOString().slice(0, 10)}.csv`)
    }

    const chips = (isTech ? HEALTH_CHIPS : ASSET_CHIPS)
        .map(c => ({ ...c, count: counts[c.key] ?? 0 }))
        .filter(c => !c.hideEmpty || c.count > 0 || c.key === filter)
    const issues = data?.issues || []
    const majorIssues = issues.filter(i => !i.minor)

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
                {/* The registry is the Fleet Manager's to keep straight */}
                {!isTech && majorIssues.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                        {showIssues
                            ? <RecordsToFix issues={issues} limit={5} />
                            : <div className="callout warn">
                                <span>{plural(majorIssues.length, 'trailer record')} need fixing: duplicates or missing telemetry links.</span>
                                <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setShowIssues(true)}>Review</button>
                            </div>}
                    </div>
                )}
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
