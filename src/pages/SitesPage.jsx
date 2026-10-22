import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchBoardSites } from '../api/vrm'
import { Page, Card, DataTable, Chips, Search, Badge, Dot, Loading, Empty } from '../ui'
import { plural } from '../ui/format'

const WORST = {
    offline: { tone: 'off', label: 'Trailer offline' },
    attention: { tone: 'crit', label: 'Needs attention' },
    watch: { tone: 'warn', label: 'Watch' },
    good: { tone: 'ok', label: 'Healthy' },
    empty: { tone: 'plain', label: 'No trailers' },
}

// Every job site with its health rollup and rental activity.
// New sites are created from a customer's page (Customers).
export default function SitesPage() {
    const navigate = useNavigate()
    const [q, setQ] = useState('')
    const [filter, setFilter] = useState('all')
    const fetchFn = useCallback(() => fetchBoardSites(), [])
    const { data, loading } = useApiPolling(fetchFn, 60000)
    const sites = data?.sites || []

    const counts = useMemo(() => ({
        all: sites.length,
        issues: sites.filter(s => s.worst === 'attention' || s.worst === 'offline').length,
        active: sites.filter(s => s.trailers > 0 && !s.is_hq).length,
        empty: sites.filter(s => s.trailers === 0).length,
    }), [sites])

    const filtered = useMemo(() => {
        const term = q.trim().toLowerCase()
        return sites.filter(s => {
            if (filter === 'issues' && !(s.worst === 'attention' || s.worst === 'offline')) return false
            if (filter === 'active' && !(s.trailers > 0 && !s.is_hq)) return false
            if (filter === 'empty' && s.trailers !== 0) return false
            return !term || [s.name, s.customer?.name, s.address, s.uid].some(v => v && v.toLowerCase().includes(term))
        })
    }, [sites, q, filter])

    const columns = [
        {
            key: 'name', label: 'Site', sort: s => s.name,
            render: s => <div><span className="primary">{s.name}</span>{s.is_hq && <Badge tone="info">HQ</Badge>}<div className="sub">{s.customer?.name || (s.is_hq ? 'Big View yard' : 'No customer')}</div></div>
        },
        {
            key: 'health', label: 'Health', sort: s => ['offline', 'attention', 'watch', 'good', 'empty'].indexOf(s.worst),
            render: s => {
                const w = WORST[s.worst]
                const issues = (s.health.attention || 0) + (s.health.offline || 0)
                return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Dot tone={w.tone} />{w.label}{issues > 0 && <span className="faint">({issues})</span>}</span>
            }
        },
        { key: 'trailers', label: 'Trailers', align: 'r', sort: s => s.trailers, render: s => <span className="num">{s.trailers}</span> },
        { key: 'billing', label: 'Billing', align: 'r', sort: s => s.rentals_billing, render: s => s.rentals_open ? <span className="num">{s.rentals_billing}<span className="faint"> / {s.rentals_open} open</span></span> : <span className="faint">—</span> },
        { key: 'address', label: 'Address', sort: s => s.address, render: s => <span className="muted">{s.address || '—'}</span> },
    ]

    return (
        <Page title="Sites" sub={data ? `${plural(counts.active, 'active site')} · ${plural(counts.all, 'site')} total` : 'Loading…'}>
            <div>
                <div className="toolbar">
                    <Search value={q} onChange={setQ} placeholder="Search site, customer, address…" />
                    <Chips value={filter} onChange={setFilter} options={[
                        { key: 'all', label: 'All', count: counts.all },
                        { key: 'issues', label: 'Has issues', dot: 'crit', count: counts.issues },
                        { key: 'active', label: 'Active', count: counts.active },
                        { key: 'empty', label: 'No trailers', count: counts.empty },
                    ]} />
                </div>
                <Card flush foot="New sites are added from the customer's page so every site belongs to a customer.">
                    {loading && !data ? <Loading /> : (
                        <DataTable columns={columns} rows={filtered} onRowClick={s => navigate(`/site/${s.id}`)}
                            empty={<Empty compact title="No sites match">Try a different search.</Empty>} />
                    )}
                </Card>
            </div>
        </Page>
    )
}
