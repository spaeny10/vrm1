import { useCallback, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchBoardTrailers } from '../api/vrm'
import { Page, Card, Stats, Stat, Dot, HealthBadge, Soc, Signal, AllClear, Loading, KV } from '../ui'
import { HEALTH, fmtAgo, fmtKwh, fmtPct, plural } from '../ui/format'
import RecordsToFix from '../components/RecordsToFix'

// Tech workspace home: which trailers in service need remote attention, and why.
// Units in the yard are counted apart: being off there is not an outage.
export default function TechHome() {
    const navigate = useNavigate()
    const fetchFn = useCallback(() => fetchBoardTrailers(), [])
    const { data, loading, lastUpdated } = useApiPolling(fetchFn, 60000)
    const rows = data?.trailers || []
    const s = data?.summary || {}
    const issues = data?.issues || []

    const urgent = rows.filter(r => r.health === 'offline' || r.health === 'attention')
    // While the server is still warming up, 'unknown' only means 'not polled yet'
    const watch = rows.filter(r => r.health === 'watch' || (r.health === 'unknown' && !data?.warming))
    const inService = useMemo(() => rows.filter(r => r.in_service), [rows])
    const weakSignal = inService.filter(r => r.online && r.signal_bars != null && r.signal_bars <= 1)

    const fleet = useMemo(() => {
        const live = inService.filter(r => r.soc != null)
        const avgSoc = live.length ? live.reduce((a, r) => a + r.soc, 0) / live.length : null
        const yieldToday = live.reduce((a, r) => a + (r.yield_today_kwh || 0), 0)
        // Only quote a forecast when it covers nearly every trailer, or the two numbers aren't comparable
        const forecast = live.filter(r => r.expected_yield_kwh != null)
        const expected = forecast.length >= live.length * 0.9 ? forecast.reduce((a, r) => a + r.expected_yield_kwh, 0) : 0
        const net = inService.filter(r => r.has_router)
        return {
            avgSoc, yieldToday, expected,
            netOnline: net.filter(r => r.online).length, netTotal: net.length,
            deficits: inService.filter(r => r.deficit_streak >= 2).length,
        }
    }, [inService])

    const go = (health) => navigate(`/trailers?health=${health}`)
    const yard = s.inactive || 0

    return (
        <Page title="Fleet health"
            sub={loading && !data ? 'Loading…' : `${plural(s.total || 0, 'trailer')} in service · updated ${fmtAgo(lastUpdated)}`}>
            <Stats>
                <Stat label="Needs attention" value={s.attention ?? '—'} tone={s.attention ? 'crit' : null} dot="crit" onClick={() => go('attention')} />
                <Stat label="Offline" value={s.offline ?? '—'} dot="off" onClick={() => go('offline')} />
                <Stat label="Watch" value={s.watch ?? '—'} tone={s.watch ? 'warn' : null} dot="warn" onClick={() => go('watch')} />
                <Stat label="Healthy" value={s.good ?? '—'} dot="ok" onClick={() => go('good')} />
            </Stats>

            {data?.warming && (
                <div className="callout">The server just restarted and is still reading VRM and InControl. The numbers settle within a minute or two.</div>
            )}

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
                    <Card title="In service today">
                        <KV items={[
                            ['Average battery', fmtPct(fleet.avgSoc)],
                            ['Solar today', fleet.expected ? `${fmtKwh(fleet.yieldToday, 0)} (forecast ${fmtKwh(fleet.expected, 0)})` : fmtKwh(fleet.yieldToday, 0)],
                            ['Routers online', `${fleet.netOnline} / ${fleet.netTotal}`],
                            ['Energy deficits', plural(fleet.deficits, 'trailer')],
                        ]} />
                    </Card>
                    <RecordsToFix issues={issues} />
                    {yard > 0 && (
                        <Card title="Not in service" meta={yard} flush>
                            <div className="list">
                                <Link to="/trailers?health=inactive" className="list-row">
                                    <div className="main">
                                        <div className="title">{plural(yard, 'unit')} in the yard or shop</div>
                                        <div className="desc">
                                            {s.yard_ready ? `${s.yard_ready} ready to deploy` : 'None ready to deploy'}
                                            {s.yard_not_ready ? ` · ${s.yard_not_ready} powered down or out of service` : ''}
                                        </div>
                                        <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>Not counted in fleet health or alerts</div>
                                    </div>
                                </Link>
                            </div>
                        </Card>
                    )}
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
                <Link key={r.key} to={r.site_id != null ? `/trailer/${r.site_id}` : '/trailers?health=unknown'} className="list-row">
                    <Dot tone={HEALTH[r.health]?.tone} pulse={r.health === 'attention'} />
                    <div className="main">
                        <div className="title">{r.unit} <HealthBadge health={r.health} /></div>
                        <div className="desc">{r.diagnosis || '—'}</div>
                        <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>
                            {[r.site?.name, r.customer?.name].filter(Boolean).join(' · ') || 'No site'}
                        </div>
                    </div>
                    <div className="side" style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
                        <Soc value={r.soc} />
                        <span>{r.health === 'offline' || r.soc == null ? (r.last_seen ? `last data ${fmtAgo(r.last_seen)}` : '') : ''}</span>
                    </div>
                </Link>
            ))}
        </div>
    )
}
