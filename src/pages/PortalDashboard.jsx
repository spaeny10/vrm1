import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { fetchPortalSites } from '../api/vrm'
import { Page, Card, Stats, Stat, Dot, Badge, Empty, Loading, Icon } from '../ui'
import { fmtPct, plural } from '../ui/format'

const STATUS = {
    ok: { tone: 'ok', label: 'All systems normal' },
    warning: { tone: 'warn', label: 'Low battery on a unit' },
    critical: { tone: 'crit', label: 'Battery critical — we’re on it' },
    offline: { tone: 'off', label: 'A unit is offline — we’re on it' },
}

// Customer portal home: the customer's sites and how their units are doing
export default function PortalDashboard() {
    const { user } = useAuth()
    const fetchFn = useCallback(() => fetchPortalSites(), [])
    const { data, loading } = useApiPolling(fetchFn, 60000)
    const sites = data?.sites || []
    const trailers = sites.reduce((n, s) => n + s.trailer_count, 0)
    const online = sites.reduce((n, s) => n + s.trailers_online, 0)
    const socs = sites.filter(s => s.avg_soc != null)
    const avgSoc = socs.length ? socs.reduce((a, s) => a + s.avg_soc, 0) / socs.length : null

    return (
        <Page title={`Welcome${user?.display_name ? ', ' + user.display_name.split(' ')[0] : ''}`} sub="Live status of the BIGView units on your sites">
            <Stats>
                <Stat label="Your sites" value={data ? sites.length : '—'} />
                <Stat label="Units online" value={data ? `${online} / ${trailers}` : '—'} dot={online < trailers ? 'warn' : 'ok'} />
                <Stat label="Average battery" value={data ? fmtPct(avgSoc) : '—'} />
            </Stats>
            <Card title="Sites" flush>
                {loading && !data ? <Loading /> : sites.length === 0 ? (
                    <Empty title="No sites yet">Your BIGView contact will add your sites here.</Empty>
                ) : (
                    <div className="list">
                        {sites.map(s => {
                            const st = STATUS[s.worst_status] || STATUS.ok
                            return (
                                <Link key={s.id} to={`/site/${s.id}`} className="list-row">
                                    <Dot tone={st.tone} />
                                    <div className="main">
                                        <div className="title">{s.name}</div>
                                        <div className="desc">{s.address || '—'}</div>
                                    </div>
                                    <div className="side" style={{ display: 'grid', gap: 4, justifyItems: 'end' }}>
                                        <Badge tone={st.tone}>{st.label}</Badge>
                                        <span>{plural(s.trailer_count, 'unit')} · {s.trailers_online} online</span>
                                    </div>
                                    <Icon name="chevron" />
                                </Link>
                            )
                        })}
                    </div>
                )}
            </Card>
        </Page>
    )
}
