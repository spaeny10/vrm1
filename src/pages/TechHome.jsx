import { useCallback, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchBoardTrailers } from '../api/vrm'
import { Page, Card, Stats, Stat, Dot, HealthBadge, Soc, Signal, AllClear, Loading, KV } from '../ui'
import { HEALTH, fmtAgo, fmtKwh, fmtPct, plural } from '../ui/format'

// Tech workspace home: which trailers need remote attention, and why.
export default function TechHome() {
    const navigate = useNavigate()
    const fetchFn = useCallback(() => fetchBoardTrailers(), [])
    const { data, loading, lastUpdated } = useApiPolling(fetchFn, 60000)
    const rows = data?.trailers || []
    const s = data?.summary || {}

    const urgent = rows.filter(r => r.health === 'offline' || r.health === 'attention')
    const watch = rows.filter(r => r.health === 'watch')
    const weakSignal = rows.filter(r => r.online && r.signal_bars != null && r.signal_bars <= 1)

    const fleet = useMemo(() => {
        const live = rows.filter(r => r.soc != null)
        const avgSoc = live.length ? live.reduce((a, r) => a + r.soc, 0) / live.length : null
        const yieldToday = live.reduce((a, r) => a + (r.yield_today_kwh || 0), 0)
        const expected = live.reduce((a, r) => a + (r.expected_yield_kwh || 0), 0)
        const net = rows.filter(r => r.site_id != null)
        return {
            avgSoc, yieldToday, expected,
            netOnline: net.filter(r => r.online).length, netTotal: net.length,
        }
    }, [rows])

    const go = (health) => navigate(`/trailers?health=${health}`)

    return (
        <Page title="Fleet health"
            sub={loading && !data ? 'Loading…' : `${plural(s.total || 0, 'trailer')} monitored · updated ${fmtAgo(lastUpdated)}`}>
            <Stats>
                <Stat label="Needs attention" value={s.attention ?? '—'} tone={s.attention ? 'crit' : null} dot="crit" onClick={() => go('attention')} />
                <Stat label="Offline" value={s.offline ?? '—'} dot="off" onClick={() => go('offline')} />
                <Stat label="Watch" value={s.watch ?? '—'} tone={s.watch ? 'warn' : null} dot="warn" onClick={() => go('watch')} />
                <Stat label="Healthy" value={s.good ?? '—'} dot="ok" onClick={() => go('good')} />
            </Stats>

            <div className="grid-main">
                <div className="stack">
                    <Card title="Needs attention or offline" meta={urgent.length || null} flush>
                        {loading && !data ? <Loading /> : urgent.length === 0
                            ? <AllClear>No trailers need attention right now.</AllClear>
                            : <TrailerList rows={urgent} />}
                    </Card>
                    <Card title="Watch list" meta={watch.length || null} flush>
                        {watch.length === 0
                            ? <AllClear>Nothing trending the wrong way.</AllClear>
                            : <TrailerList rows={watch} />}
                    </Card>
                </div>

                <div className="stack">
                    <Card title="Fleet today">
                        <KV items={[
                            ['Average battery', fmtPct(fleet.avgSoc)],
                            ['Solar today', fleet.expected ? `${fmtKwh(fleet.yieldToday, 0)} (forecast ${fmtKwh(fleet.expected, 0)})` : fmtKwh(fleet.yieldToday, 0)],
                            ['Routers online', `${fleet.netOnline} / ${fleet.netTotal}`],
                            ['Energy deficits', plural(rows.filter(r => r.deficit_streak >= 2).length, 'trailer')],
                        ]} />
                    </Card>
                    <Card title="Weak signal" meta={weakSignal.length || null} flush>
                        {weakSignal.length === 0 ? <AllClear>All routers have usable signal.</AllClear> : (
                            <div className="list">
                                {weakSignal.map(r => (
                                    <Link key={r.key} to={`/trailer/${r.site_id}`} className="list-row">
                                        <Signal bars={r.signal_bars} online={r.online} />
                                        <div className="main">
                                            <div className="title">{r.unit}</div>
                                            <div className="desc">{r.carrier || 'Unknown carrier'}{r.rsrp != null ? ` · ${r.rsrp} dBm` : ''}</div>
                                        </div>
                                        <div className="side">{r.site?.name}</div>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </Card>
                </div>
            </div>
        </Page>
    )
}

function TrailerList({ rows }) {
    return (
        <div className="list">
            {rows.map(r => (
                <Link key={r.key} to={r.site_id != null ? `/trailer/${r.site_id}` : '/trailers'} className="list-row">
                    <Dot tone={HEALTH[r.health]?.tone} pulse={r.health === 'attention'} />
                    <div className="main">
                        <div className="title">{r.unit} <HealthBadge health={r.health} /></div>
                        <div className="desc">{r.diagnosis || '—'}</div>
                        <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>
                            {[r.site?.name, r.customer?.name].filter(Boolean).join(' · ') || 'Unassigned'}
                        </div>
                    </div>
                    <div className="side" style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
                        <Soc value={r.soc} />
                        <span>{r.health === 'offline' ? `last seen ${fmtAgo(r.last_seen)}` : ''}</span>
                    </div>
                </Link>
            ))}
        </div>
    )
}
