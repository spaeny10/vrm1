import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Bar, Line } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useToast } from '../components/ToastProvider'
import {
    fetchFleetEnergy, fetchFleetAlerts, fetchAlertHistory, fetchFleetAnalytics, fetchAnalyticsRankings,
    fetchFleetIntelligence, fetchFleetNetwork, fetchBoardTrailers, backfillAnalytics,
} from '../api/vrm'
import {
    Page, Card, Stats, Stat, Dot, Badge, Soc, Signal, Tabs, Seg, Chips, Search, Drawer, Empty, AllClear,
    Loading, DataTable, KV, Icon,
} from '../ui'
import { fmtDate, fmtDateShort, fmtAgo, fmtNum, fmtPct, fmtKwh, plural } from '../ui/format'
import { baseOptions, chartColors, alpha } from '../ui/chart'
import { generateCSV, downloadCSV } from '../utils/csv'

// Fleet-level analysis for the Technical Manager: energy balance and
// deficits, long-range trends, and cellular network health. No money here.

const TAB_KEYS = ['energy', 'trends', 'network']
// Keep wide tables scrolling inside their card instead of widening the page
const STACK = { gridTemplateColumns: 'minmax(0, 1fr)' }

export default function InsightsPage() {
    const [params, setParams] = useSearchParams()
    const tab = TAB_KEYS.includes(params.get('tab')) ? params.get('tab') : 'energy'
    const setTab = (t) => setParams(p => { const n = new URLSearchParams(p); n.set('tab', t); return n }, { replace: true })
    const theme = useTheme()

    // Shared by the tab badges and the tabs themselves
    const alertsFn = useCallback(() => fetchFleetAlerts(), [])
    const alertsQ = useApiPolling(alertsFn, 60000)
    const netFn = useCallback(() => fetchFleetNetwork(), [])
    const netQ = useApiPolling(netFn, 60000)
    const alertCount = alertsQ.data?.alerts?.length || 0
    const offlineCount = (netQ.data?.records || []).filter(d => !d.online).length

    return (
        <Page title="Insights" sub="Fleet-wide energy balance, performance trends and network health">
            <div style={{ minWidth: 0 }}>
                <Tabs value={tab} onChange={setTab} tabs={[
                    { key: 'energy', label: 'Energy', count: alertCount || null },
                    { key: 'trends', label: 'Trends' },
                    { key: 'network', label: 'Network', count: offlineCount || null },
                ]} />
                {tab === 'energy' && <EnergyTab alertsQ={alertsQ} theme={theme} />}
                {tab === 'trends' && <TrendsTab theme={theme} />}
                {tab === 'network' && <NetworkTab netQ={netQ} />}
            </div>
        </Page>
    )
}

// Re-render charts when the user flips light/dark (colors come from CSS vars)
function useTheme() {
    const read = () => document.documentElement.dataset.theme || 'dark'
    const [theme, setTheme] = useState(read)
    useEffect(() => {
        const obs = new MutationObserver(() => setTheme(read()))
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        return () => obs.disconnect()
    }, [])
    return theme
}

function Section({ title, children }) {
    return (
        <div>
            <div className="faint" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 10 }}>{title}</div>
            {children}
        </div>
    )
}

// ============================================================
// Energy
// ============================================================
const SEVERITY = {
    critical: { tone: 'crit', label: 'Critical' },
    warning: { tone: 'warn', label: 'Warning' },
    caution: { tone: 'warn', label: 'Caution' },
}

function EnergyTab({ alertsQ, theme }) {
    const energyFn = useCallback(() => fetchFleetEnergy(), [])
    const histFn = useCallback(() => fetchAlertHistory(30), [])
    const { data: energy, loading } = useApiPolling(energyFn, 120000)
    const { data: hist, loading: histLoading } = useApiPolling(histFn, 120000)
    const [siteId, setSiteId] = useState('all')

    const records = useMemo(() => energy?.records || [], [energy])
    const alerts = alertsQ.data?.alerts || []
    const history = hist?.alerts || []

    // Sum every trailer's daily totals; only complete days (the server's "today" is UTC)
    const series = useMemo(() => {
        const today = new Date().toISOString().slice(0, 10)
        const src = siteId === 'all' ? records : records.filter(r => String(r.site_id) === siteId)
        const byDate = new Map()
        for (const r of src) {
            for (const d of r.days || []) {
                if (d.date >= today) continue
                const e = byDate.get(d.date) || { date: d.date, yield: 0, used: 0 }
                e.yield += Number(d.yield_wh) || 0
                e.used += Number(d.consumed_wh) || 0
                byDate.set(d.date, e)
            }
        }
        return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-14)
    }, [records, siteId])

    const chart = useMemo(() => {
        const c = chartColors()
        return {
            data: {
                labels: series.map(d => fmtDateShort(d.date)),
                datasets: [
                    { label: 'Solar yield', data: series.map(d => +(d.yield / 1000).toFixed(2)), backgroundColor: c.accent, borderRadius: 3, maxBarThickness: 22 },
                    { label: 'Consumption', data: series.map(d => +(d.used / 1000).toFixed(2)), backgroundColor: c.series[5], borderRadius: 3, maxBarThickness: 22 },
                ],
            },
            options: baseOptions({ legend: true, ySuffix: ' kWh' }),
        }
    }, [series, theme])

    const totals = series.reduce((a, d) => ({ y: a.y + d.yield, u: a.u + d.used }), { y: 0, u: 0 })

    const exportCsv = () => {
        const rows = []
        for (const r of records) for (const d of r.days || []) {
            rows.push([r.site_name, d.date, d.yield_wh ?? '', d.consumed_wh ?? '',
                d.yield_wh != null && d.consumed_wh != null ? Math.round(d.yield_wh - d.consumed_wh) : ''])
        }
        downloadCSV(generateCSV(['Trailer', 'Date', 'Yield (Wh)', 'Consumed (Wh)', 'Balance (Wh)'], rows), 'fleet-energy.csv')
    }

    const historyCols = [
        { key: 'site', label: 'Trailer', sort: a => a.site_name, render: a => <Link className="link" to={`/trailer/${a.site_id}`} onClick={e => e.stopPropagation()}>{a.site_name}</Link> },
        { key: 'sev', label: 'Severity', sort: a => ['critical', 'warning', 'caution'].indexOf(a.severity), render: a => <Badge tone={SEVERITY[a.severity]?.tone || 'plain'}>{SEVERITY[a.severity]?.label || a.severity}</Badge> },
        { key: 'streak', label: 'Streak', align: 'r', sort: a => a.streak_days, render: a => <span className="num">{plural(a.streak_days, 'day')}</span> },
        { key: 'deficit', label: 'Total shortfall', align: 'r', sort: a => Number(a.deficit_wh), render: a => <span className="num">{a.deficit_wh != null ? fmtKwh(Number(a.deficit_wh) / 1000) : '—'}</span> },
        { key: 'start', label: 'Started', sort: a => a.created_at, render: a => fmtDate(a.created_at) },
        { key: 'end', label: 'Resolved', sort: a => a.resolved_at || '9999', render: a => a.resolved_at ? fmtDate(a.resolved_at) : <Badge tone="crit">Still active</Badge> },
    ]

    return (
        <div className="stack" style={STACK}>
            <Card title="Solar yield vs consumption" meta={siteId === 'all' ? 'whole fleet · last 14 days' : 'last 14 days'}
                actions={<>
                    <select className="select" style={{ width: 170, height: 30 }} value={siteId} onChange={e => setSiteId(e.target.value)} aria-label="Trailer">
                        <option value="all">Whole fleet</option>
                        {records.map(r => <option key={r.site_id} value={String(r.site_id)}>{r.site_name}</option>)}
                    </select>
                    <button className="btn ghost sm" onClick={exportCsv} disabled={!records.length}><Icon name="download" />Export</button>
                </>}
                foot={series.length ? `${plural(series.length, 'complete day')}: ${fmtNum(totals.y / 1000)} kWh harvested, ${fmtNum(totals.u / 1000)} kWh used (${totals.y >= totals.u ? 'surplus' : 'deficit'} of ${fmtNum(Math.abs(totals.y - totals.u) / 1000)} kWh).` : null}>
                {loading && !energy ? <Loading /> : series.length === 0
                    ? <Empty compact title="No energy history yet">Daily totals build up after each telemetry poll.</Empty>
                    : <div style={{ height: 260 }}><Bar key={theme} data={chart.data} options={chart.options} /></div>}
            </Card>

            <Card title="Energy deficits" meta={alerts.length || null} flush
                foot="A real deficit is a complete day where a trailer used more energy than its panels made. An alert opens after 2 such days in a row (3+ is a warning, 5+ is critical). Days that end with the battery 88%+ full, the charger in Float or Storage and a shortfall under 1 kWh don't count: the battery was full, so the charger simply throttled.">
                {alertsQ.loading && !alertsQ.data ? <Loading /> : alerts.length === 0
                    ? <AllClear>No trailer is running an energy deficit.</AllClear>
                    : <div className="list">{alerts.map(a => <DeficitRow key={a.site_id} a={a} />)}</div>}
            </Card>

            <Card title="Deficit alert history" meta="last 30 days" flush>
                {histLoading && !hist ? <Loading /> : (
                    <DataTable columns={historyCols} rows={history} rowKey="id"
                        empty={<AllClear>No energy deficit alerts in the last 30 days.</AllClear>} />
                )}
            </Card>
        </div>
    )
}

function DeficitRow({ a }) {
    const [open, setOpen] = useState(false)
    const sev = SEVERITY[a.severity] || { tone: 'warn', label: a.severity }
    const days = a.deficit_days || []
    const real = days.filter(d => !d.throttled)
    const avg = real.length ? real.reduce((s, d) => s + (Number(d.deficit_wh) || 0), 0) / real.length : null
    return (
        <>
            <div className="list-row clickable" role="button" aria-expanded={open} onClick={() => setOpen(o => !o)}>
                <Dot tone={sev.tone} pulse={a.severity === 'critical'} />
                <div className="main">
                    <div className="title">{a.site_name} <Badge tone={sev.tone}>{sev.label}</Badge></div>
                    <div className="desc">
                        Short of power {plural(a.streak_days, 'day')} in a row{avg != null ? ` · averaging ${fmtKwh(avg / 1000, 2)} short per day` : ''}
                    </div>
                    {a.job_site_name && <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>{a.job_site_name}</div>}
                </div>
                <span className="side" style={{ display: 'inline-flex', transition: 'transform .12s', transform: open ? 'rotate(90deg)' : 'none' }}><Icon name="chevron" size={16} /></span>
            </div>
            {open && (
                <div style={{ padding: '6px 18px 14px 38px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                    <div className="table-wrap">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th style={{ background: 'var(--surface-2)' }}>Day</th>
                                    <th className="r" style={{ background: 'var(--surface-2)' }}>Solar</th>
                                    <th className="r" style={{ background: 'var(--surface-2)' }}>Used</th>
                                    <th className="r" style={{ background: 'var(--surface-2)' }}>Shortfall</th>
                                    <th style={{ background: 'var(--surface-2)' }}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {days.map(d => (
                                    <tr key={d.date} className={d.throttled ? 'faint' : ''}>
                                        <td>{fmtDate(d.date)}</td>
                                        <td className="r num">{fmtKwh(d.yield_wh / 1000, 2)}</td>
                                        <td className="r num">{fmtKwh(d.consumed_wh / 1000, 2)}</td>
                                        <td className="r num" style={d.throttled ? undefined : { color: 'var(--crit)' }}>{fmtKwh(d.deficit_wh / 1000, 2)}</td>
                                        <td>
                                            {d.throttled
                                                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} title={d.throttle_details || undefined}><Badge tone="off">Throttled</Badge>Battery full, charger throttling — not a problem</span>
                                                : <span className="muted">Real deficit</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div style={{ marginTop: 10 }}>
                        <Link className="link" to={`/trailer/${a.site_id}`}>Open {a.site_name} →</Link>
                    </div>
                </div>
            )}
        </>
    )
}

// ============================================================
// Trends
// ============================================================
function TrendsTab({ theme }) {
    const { user } = useAuth()
    const isAdmin = user?.role === 'admin'
    const toast = useToast()
    const navigate = useNavigate()
    const [days, setDays] = useState(30)
    const [intelFilter, setIntelFilter] = useState('all')
    const [backfilling, setBackfilling] = useState(false)
    const intelRef = useRef(null)

    const summaryFn = useCallback(() => fetchFleetAnalytics(days), [days])
    const rankFn = useCallback(() => fetchAnalyticsRankings(days), [days])
    const intelFn = useCallback(() => fetchFleetIntelligence(), [])
    const sumQ = useApiPolling(summaryFn, 300000)
    const rankQ = useApiPolling(rankFn, 300000)
    const intelQ = useApiPolling(intelFn, 120000)

    const daily = useMemo(() => sumQ.data?.daily || [], [sumQ.data])
    const rankings = useMemo(() => (rankQ.data?.rankings || []).map((r, i) => ({ ...r, rank: i + 1 })), [rankQ.data])
    const intel = useMemo(() => intelQ.data?.trailers || [], [intelQ.data])
    const fleet = intelQ.data?.fleet

    // A full battery throttles the charger, so a low score there is expected, not a panel problem
    const isFull = t => !!t.solar?.score_adjustment_reason
    const isUnder = t => !isFull(t) && t.solar?.avg_7d_score != null && t.solar.avg_7d_score < 50
    const isLow = t => t.battery?.days_of_autonomy != null && t.battery.days_of_autonomy < 1.5

    const kpi = useMemo(() => {
        const soc = daily.map(d => d.fleet_avg_soc).filter(v => v != null).map(Number)
        const yields = daily.map(d => Number(d.fleet_yield_kwh) || 0)
        const total = yields.reduce((a, v) => a + v, 0)
        return {
            avgSoc: soc.length ? soc.reduce((a, v) => a + v, 0) / soc.length : null,
            total, perDay: daily.length ? total / daily.length : null,
        }
    }, [daily])

    const charts = useMemo(() => {
        const c = chartColors()
        const labels = daily.map(d => fmtDateShort(d.date))
        return {
            soc: {
                data: {
                    labels, datasets: [
                        { label: 'Fleet average', data: daily.map(d => d.fleet_avg_soc != null ? +Number(d.fleet_avg_soc).toFixed(1) : null), borderColor: c.accent, backgroundColor: alpha(c.accent, 0.12), fill: true, spanGaps: true },
                        { label: 'Lowest trailer', data: daily.map(d => d.fleet_min_soc != null ? +Number(d.fleet_min_soc).toFixed(1) : null), borderColor: c.series[5], borderDash: [5, 4], borderWidth: 1.5, fill: false, spanGaps: true },
                    ],
                },
                options: baseOptions({ legend: true, yMin: 0, yMax: 100, ySuffix: '%' }),
            },
            yield: {
                data: { labels, datasets: [{ label: 'Fleet solar', data: daily.map(d => +(Number(d.fleet_yield_kwh) || 0).toFixed(1)), backgroundColor: c.accent, borderRadius: 3, maxBarThickness: 22 }] },
                options: baseOptions({ ySuffix: ' kWh' }),
            },
        }
    }, [daily, theme])

    const showIntel = (f) => {
        setIntelFilter(f)
        intelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    const runBackfill = async () => {
        setBackfilling(true)
        try {
            const r = await backfillAnalytics(days)
            toast.success(`Recomputed ${fmtNum(r.metrics_rows)} daily metrics over ${plural(r.days_processed, 'day')}.`)
            sumQ.refetch(); rankQ.refetch()
        } catch (err) {
            toast.error(`Backfill failed: ${err.message}`)
        } finally {
            setBackfilling(false)
        }
    }

    const noData = (
        <Empty compact title="No analytics yet">
            Daily metrics are computed after each telemetry poll.{isAdmin ? ' Use Backfill analytics to compute them from stored history.' : ''}
        </Empty>
    )

    const rankCols = [
        { key: 'rank', label: '#', width: 44, sort: r => r.rank, render: r => <span className="faint num">{r.rank}</span> },
        { key: 'name', label: 'Site', sort: r => r.job_site_name, render: r => <div><span className="primary">{r.job_site_name}</span><div className="sub">{plural(r.trailer_count, 'trailer')}</div></div> },
        { key: 'avg', label: 'Avg battery', sort: r => Number(r.avg_soc), render: r => <Soc value={r.avg_soc != null ? Number(r.avg_soc) : null} /> },
        { key: 'min', label: 'Lowest battery', align: 'r', sort: r => Number(r.min_soc), render: r => <span className="num" style={r.min_soc != null && r.min_soc < 20 ? { color: 'var(--crit)' } : undefined}>{fmtPct(r.min_soc)}</span> },
        { key: 'yield', label: 'Solar per day', align: 'r', sort: r => Number(r.avg_daily_yield_kwh), render: r => <span className="num">{fmtKwh(r.avg_daily_yield_kwh)}</span> },
        { key: 'up', label: 'Uptime', align: 'r', sort: r => Number(r.avg_uptime), render: r => <span className="num">{fmtPct(r.avg_uptime)}</span> },
        { key: 'v', label: 'Avg voltage', align: 'r', sort: r => Number(r.avg_voltage), render: r => <span className="num">{r.avg_voltage != null ? `${Number(r.avg_voltage).toFixed(1)} V` : '—'}</span> },
    ]

    const intelRows = intel.filter(t => intelFilter === 'under' ? isUnder(t) : intelFilter === 'low' ? isLow(t) : true)
    const scoreTone = (label) => label === 'Poor' ? 'crit' : label === 'Fair' ? 'warn' : null
    const intelCols = [
        { key: 'name', label: 'Trailer', sort: t => t.site_name, render: t => <span className="primary">{t.site_name}</span> },
        {
            key: 'score', label: 'Solar score', sort: t => t.solar.score, render: t => t.solar.score == null ? <span className="faint">—</span> : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span className="num">{fmtPct(t.solar.score)}</span>
                    {isFull(t) ? <Badge tone="off">Battery full</Badge> : scoreTone(t.solar.score_label) ? <Badge tone={scoreTone(t.solar.score_label)}>{t.solar.score_label}</Badge> : <span className="faint">{t.solar.score_label}</span>}
                </span>
            ),
        },
        { key: 'avg7d', label: '7-day avg', align: 'r', sort: t => t.solar.avg_7d_score, render: t => <div className="num" style={isUnder(t) ? { color: 'var(--crit)' } : undefined}>{fmtPct(t.solar.avg_7d_score)}{isFull(t) && <div className="sub">charger throttling</div>}</div> },
        { key: 'panel', label: 'Panel output', align: 'r', sort: t => t.solar.panel_performance_pct, render: t => <div className="num">{fmtPct(t.solar.panel_performance_pct)}<div className="sub">{t.solar.current_watts != null ? `${Math.round(t.solar.current_watts)} W now` : ''}</div></div> },
        {
            key: 'auto', label: 'Autonomy', align: 'r', sort: t => t.battery.days_of_autonomy,
            render: t => t.battery.days_of_autonomy == null ? <span className="faint">—</span>
                : <span className="num" style={isLow(t) ? { color: 'var(--crit)', fontWeight: 600 } : undefined}>{fmtNum(t.battery.days_of_autonomy, 1)} days</span>,
        },
        { key: 'today', label: 'Solar today', align: 'r', sort: t => t.solar.yield_today_wh, render: t => <span className="num">{t.solar.yield_today_wh != null ? fmtKwh(t.solar.yield_today_wh / 1000) : '—'}</span> },
        { key: 'exp', label: 'Expected / day', align: 'r', sort: t => t.location.expected_daily_yield_wh, render: t => <div className="num">{fmtKwh(t.location.expected_daily_yield_wh / 1000)}<div className="sub">{t.location.peak_sun_hours != null ? `${fmtNum(t.location.peak_sun_hours, 1)} sun hrs` : ''}</div></div> },
        { key: 'batt', label: 'Battery', sort: t => t.battery.soc_pct, render: t => <div><Soc value={t.battery.soc_pct} /><div className="sub">{t.battery.stored_wh != null ? `${fmtKwh(t.battery.stored_wh / 1000)} stored` : ''}</div></div> },
        { key: 'charge', label: 'To full', align: 'r', sort: t => t.battery.charge_time_hours, render: t => <span className="num">{t.battery.charge_time_hours != null ? `${fmtNum(t.battery.charge_time_hours, 1)} h` : '—'}</span> },
    ]

    const specs = fleet?.specs
    return (
        <div className="stack" style={STACK}>
            <div className="toolbar" style={{ marginBottom: 0 }}>
                <Seg value={days} onChange={setDays} options={[{ key: 7, label: '7 days' }, { key: 30, label: '30 days' }, { key: 90, label: '90 days' }]} />
                <span className="faint">{daily.length ? `${fmtDate(daily[0].date)} – ${fmtDate(daily[daily.length - 1].date)}` : ''}</span>
            </div>

            <Stats>
                <Stat label="Average battery" value={fmtPct(kpi.avgSoc)} hint={`fleet average, last ${days} days`} />
                <Stat label="Solar harvested" value={fmtNum(kpi.total)} unit="kWh" hint={kpi.perDay != null ? `about ${fmtNum(kpi.perDay)} kWh per day` : null} />
                <Stat label="Panels underperforming" value={intelQ.data ? intel.filter(isUnder).length : '—'} tone={intel.some(isUnder) ? 'warn' : null}
                    hint="7-day solar score under 50%" onClick={() => showIntel('under')} active={intelFilter === 'under'} />
                <Stat label="Low battery autonomy" value={intelQ.data ? intel.filter(isLow).length : '—'} tone={intel.some(isLow) ? 'crit' : null}
                    hint="under 1.5 days without sun" onClick={() => showIntel('low')} active={intelFilter === 'low'} />
            </Stats>

            <div className="grid-2">
                <Card title="Fleet battery level"
                    actions={isAdmin && (
                        <button className="btn ghost sm" onClick={runBackfill} disabled={backfilling} title="Recompute daily analytics from stored telemetry">
                            <Icon name="refresh" />{backfilling ? 'Backfilling…' : 'Backfill analytics'}
                        </button>
                    )}>
                    {sumQ.loading && !sumQ.data ? <Loading /> : daily.length === 0 ? noData
                        : <div style={{ height: 240 }}><Line key={theme} data={charts.soc.data} options={charts.soc.options} /></div>}
                </Card>
                <Card title="Fleet solar yield" meta="per day">
                    {sumQ.loading && !sumQ.data ? <Loading /> : daily.length === 0 ? noData
                        : <div style={{ height: 240 }}><Bar key={theme} data={charts.yield.data} options={charts.yield.options} /></div>}
                </Card>
            </div>

            <Card title="Site rankings" meta={`${days}-day averages, best battery first`} flush>
                {rankQ.loading && !rankQ.data ? <Loading /> : (
                    <DataTable columns={rankCols} rows={rankings} rowKey="job_site_id" onRowClick={r => navigate(`/site/${r.job_site_id}`)}
                        empty={noData} />
                )}
            </Card>

            <div ref={intelRef} style={{ scrollMarginTop: 16 }}>
                <Card title="Trailer solar and battery" meta={intel.length ? plural(intel.length, 'trailer') : null} flush
                    foot={specs ? `Each trailer has ${fmtNum(specs.solar.total_watts)} W of solar and ${fmtNum(specs.battery.total_wh / 1000, 1)} kWh of battery. Solar score is yesterday's yield as a share of what the location and weather should have produced. Autonomy is how long the battery lasts with no sun at the current draw. A trailer with a full battery isn't counted as underperforming: its charger is just throttling.` : null}>
                    <div className="toolbar" style={{ padding: '14px 18px 0' }}>
                        <Chips value={intelFilter} onChange={setIntelFilter} options={[
                            { key: 'all', label: 'All', count: intel.length },
                            { key: 'under', label: 'Underperforming', dot: 'warn', count: intel.filter(isUnder).length },
                            { key: 'low', label: 'Low autonomy', dot: 'crit', count: intel.filter(isLow).length },
                        ]} />
                    </div>
                    {intelQ.loading && !intelQ.data ? <Loading label="Calculating trailer intelligence…" /> : (
                        <DataTable columns={intelCols} rows={intelRows} rowKey="site_id" initialSort={{ key: 'avg7d', dir: 'asc' }}
                            onRowClick={t => navigate(`/trailer/${t.site_id}`)}
                            empty={intelFilter === 'all'
                                ? <Empty compact title="No trailer data yet">Intelligence appears once trailers report battery and solar telemetry.</Empty>
                                : <AllClear>{intelFilter === 'under' ? 'No panels are underperforming.' : 'Every trailer has at least 1.5 days of battery autonomy.'}</AllClear>} />
                    )}
                </Card>
            </div>
        </div>
    )
}

// ============================================================
// Network
// ============================================================
function fmtMB(mb) {
    if (mb == null || isNaN(Number(mb))) return '—'
    const n = Number(mb)
    return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`
}

function fmtUptime(sec) {
    if (!sec) return '—'
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

function rsrpWord(rsrp) {
    if (rsrp == null) return null
    return rsrp >= -80 ? 'Excellent' : rsrp >= -90 ? 'Good' : rsrp >= -100 ? 'Fair' : 'Poor'
}

const LED_TONE = { green: 'ok', yellow: 'warn', orange: 'warn', red: 'crit' }

function NetworkTab({ netQ }) {
    const boardFn = useCallback(() => fetchBoardTrailers(), [])
    const { data: board } = useApiPolling(boardFn, 120000)
    const [q, setQ] = useState('')
    const [filter, setFilter] = useState('all')
    const [selected, setSelected] = useState(null)

    const rows = useMemo(() => {
        const byUnit = new Map((board?.trailers || []).map(t => [t.unit, t]))
        const list = (netQ.data?.records || []).map(d => {
            const rsrp = d.cellular?.signal?.rsrp ?? null
            const bars = d.cellular?.signal_bar ?? null
            return {
                ...d, rsrp, bars,
                carrier: d.cellular?.carrier || null,
                tech: d.cellular?.technology || null,
                trailer: byUnit.get(d.name) || null,
                weak: !!d.online && ((bars != null && bars <= 1) || (rsrp != null && rsrp < -105)),
            }
        })
        // Exceptions first: offline, then weak signal, then by name
        const rank = r => !r.online ? 0 : r.weak ? 1 : 2
        return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    }, [netQ.data, board])

    const online = rows.filter(r => r.online)
    const offline = rows.filter(r => !r.online)
    const weak = rows.filter(r => r.weak)
    const totalMb = rows.reduce((a, r) => a + (Number(r.usage_mb) || 0), 0)
    const topUsage = [...rows].sort((a, b) => (b.usage_mb || 0) - (a.usage_mb || 0)).slice(0, 8)
    const maxUsage = topUsage[0]?.usage_mb || 1

    const carriers = useMemo(() => {
        const m = new Map()
        for (const r of rows) {
            const k = r.carrier || 'Unknown'
            const e = m.get(k) || { name: k, total: 0, online: 0, rsrpSum: 0, rsrpN: 0 }
            e.total++
            if (r.online) e.online++
            if (r.online && r.rsrp != null) { e.rsrpSum += r.rsrp; e.rsrpN++ }
            m.set(k, e)
        }
        return [...m.values()].sort((a, b) => b.total - a.total)
    }, [rows])

    const filtered = rows.filter(r => {
        if (filter === 'online' && !r.online) return false
        if (filter === 'offline' && r.online) return false
        if (filter === 'weak' && !r.weak) return false
        const term = q.trim().toLowerCase()
        return !term || [r.name, r.carrier, r.trailer?.site?.name, r.trailer?.customer?.name, r.model].some(v => v && v.toLowerCase().includes(term))
    })

    const exportCsv = () => {
        downloadCSV(generateCSV(
            ['Router', 'Site', 'Status', 'Signal (bars)', 'RSRP (dBm)', 'Carrier', 'Technology', 'Uptime', 'Data today (MB)', 'Clients'],
            rows.map(r => [r.name, r.trailer?.site?.name || '', r.online ? 'Online' : 'Offline', r.bars ?? '', r.rsrp ?? '', r.carrier || '', r.tech || '', fmtUptime(r.uptime), Math.round(r.usage_mb || 0), r.client_count || 0]),
        ), 'network-routers.csv')
    }

    const columns = [
        { key: 'name', label: 'Router', sort: r => r.name, render: r => <div><span className="primary">{r.name}</span><div className="sub">{r.trailer?.site?.name || 'Unassigned'}</div></div> },
        {
            key: 'status', label: 'Status', sort: r => (r.online ? 1 : 0), render: r => r.online ? <Badge tone="ok" dot>Online</Badge>
                : <div><Badge tone="off" dot>Offline</Badge>{r.offline_since && <div className="sub">since {fmtAgo(r.offline_since)}</div>}</div>,
        },
        { key: 'carrier', label: 'Carrier', sort: r => r.carrier, render: r => r.carrier || <span className="faint">—</span> },
        { key: 'tech', label: 'Technology', sort: r => r.tech, render: r => r.tech ? <span className="muted">{r.tech}</span> : <span className="faint">—</span> },
        {
            key: 'signal', label: 'Signal', sort: r => (r.online ? r.rsrp ?? -999 : -1000), render: r => (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Signal bars={r.bars} online={r.online} />
                    {r.online && r.rsrp != null && <span className="num" style={r.weak ? { color: 'var(--warn)' } : { color: 'var(--text-2)' }}>{r.rsrp} dBm</span>}
                </span>
            ),
        },
        { key: 'usage', label: 'Data today', align: 'r', sort: r => r.usage_mb, render: r => <span className="num">{fmtMB(r.usage_mb)}</span> },
        { key: 'uptime', label: 'Uptime', align: 'r', sort: r => r.uptime, render: r => <span className="num">{r.online ? fmtUptime(r.uptime) : '—'}</span> },
    ]

    if (netQ.loading && !netQ.data) return <Card><Loading label="Loading routers…" /></Card>
    if (netQ.error && !netQ.data) return <Card><Empty title="Couldn't load the network">{netQ.error}</Empty></Card>

    return (
        <div className="stack" style={STACK}>
            <Stats>
                <Stat label="Routers online" value={online.length} unit={`/ ${rows.length}`} dot="ok" onClick={() => setFilter('online')} active={filter === 'online'} />
                <Stat label="Offline" value={offline.length} dot="off" onClick={() => setFilter('offline')} active={filter === 'offline'} />
                <Stat label="Weak signal" value={weak.length} tone={weak.length ? 'warn' : null} dot="warn" onClick={() => setFilter('weak')} active={filter === 'weak'} />
                <Stat label="Data today" value={fmtMB(totalMb)} hint={rows.length ? `about ${fmtMB(totalMb / rows.length)} per router` : null} />
            </Stats>

            <div className="grid-3">
                <Card title="Needs attention" meta={offline.length + weak.length || null} flush>
                    {offline.length + weak.length === 0 ? <AllClear>Every router is online with usable signal.</AllClear> : (
                        <div className="list">
                            {[...offline, ...weak].map(r => (
                                <div key={r.id} className="list-row clickable" onClick={() => setSelected(r)}>
                                    {r.online ? <Signal bars={r.bars} online /> : <Dot tone="off" />}
                                    <div className="main">
                                        <div className="title">{r.name}</div>
                                        <div className="desc">
                                            {r.online
                                                ? `Weak signal${r.rsrp != null ? `: ${r.rsrp} dBm` : ''}${r.carrier ? ` on ${r.carrier}` : ''}`
                                                : `Offline${r.offline_since ? ` since ${fmtAgo(r.offline_since)}` : ''}`}
                                        </div>
                                    </div>
                                    <div className="side">{r.trailer?.site?.name || ''}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>

                <Card title="Carriers" flush>
                    {carriers.length === 0 ? <Empty compact>No routers reporting.</Empty> : (
                        <div className="list">
                            {carriers.map(c => (
                                <div key={c.name} className="list-row">
                                    <div className="main">
                                        <div className="title">{c.name}</div>
                                        <div className="desc">{plural(c.total, 'router')}{c.online < c.total ? ` · ${c.total - c.online} offline` : ''}</div>
                                        <div className="meter" style={{ marginTop: 8 }}><i style={{ width: `${(c.total / rows.length) * 100}%`, background: 'var(--accent)' }} /></div>
                                    </div>
                                    <div className="side">
                                        <div className="num">{c.rsrpN ? `${Math.round(c.rsrpSum / c.rsrpN)} dBm` : '—'}</div>
                                        <div>{c.rsrpN ? `avg · ${rsrpWord(c.rsrpSum / c.rsrpN).toLowerCase()}` : ''}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>

                <Card title="Top data users today" meta={`${fmtMB(totalMb)} fleet total`} flush>
                    {topUsage.length === 0 ? <Empty compact>No usage reported yet.</Empty> : (
                        <div className="list">
                            {topUsage.map(r => (
                                <div key={r.id} className="list-row clickable" style={{ padding: '9px 18px' }} onClick={() => setSelected(r)}>
                                    <div style={{ width: 64, fontWeight: 600 }}>{r.name}</div>
                                    <div className="main"><div className="meter"><i style={{ width: `${((r.usage_mb || 0) / maxUsage) * 100}%`, background: 'var(--accent)' }} /></div></div>
                                    <div className="num" style={{ width: 64, textAlign: 'right' }}>{fmtMB(r.usage_mb)}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            </div>

            <Card title="All routers" meta={filtered.length !== rows.length ? `${filtered.length} of ${rows.length}` : rows.length} flush
                actions={<button className="btn ghost sm" onClick={exportCsv} disabled={!rows.length}><Icon name="download" />Export</button>}
                foot={netQ.data?.last_poll ? `Router data from Peplink InControl, updated ${fmtAgo(netQ.data.last_poll)}.` : null}>
                <div className="toolbar" style={{ padding: '14px 18px 0' }}>
                    <Search value={q} onChange={setQ} placeholder="Search router, site, carrier…" />
                    <Chips value={filter} onChange={setFilter} options={[
                        { key: 'all', label: 'All', count: rows.length },
                        { key: 'online', label: 'Online', dot: 'ok', count: online.length },
                        { key: 'offline', label: 'Offline', dot: 'off', count: offline.length },
                        { key: 'weak', label: 'Weak signal', dot: 'warn', count: weak.length },
                    ]} />
                </div>
                <DataTable columns={columns} rows={filtered} onRowClick={setSelected}
                    empty={<Empty compact title="No routers match">Try a different search or filter.</Empty>} />
            </Card>

            {selected && <RouterDrawer device={rows.find(r => r.id === selected.id) || selected} onClose={() => setSelected(null)} />}
        </div>
    )
}

function RouterDrawer({ device: d, onClose }) {
    const cell = d.cellular
    const sig = cell?.signal
    return (
        <Drawer title={d.name} onClose={onClose}
            sub={[d.model, d.trailer?.site?.name].filter(Boolean).join(' · ')}
            actions={d.trailer?.site_id != null && <Link className="btn sm" to={`/trailer/${d.trailer.site_id}`}>Open trailer</Link>}>
            {!d.online ? (
                <div className="callout"><Dot tone="off" /><div><b>Offline</b>{d.offline_since ? ` since ${fmtAgo(d.offline_since)}` : ''}. The router hasn't checked in with InControl; values below are from its last report.</div></div>
            ) : d.weak ? (
                <div className="callout warn"><Icon name="signal" size={16} /><div><b>Weak signal.</b> Video and remote access may be unreliable. Consider an antenna check or a different carrier.</div></div>
            ) : null}

            {cell && (
                <Section title="Cellular">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                        <Signal bars={d.bars} online={d.online} />
                        <div>
                            <div style={{ fontWeight: 600 }}>{cell.carrier || 'Unknown carrier'}</div>
                            <div className="faint" style={{ fontSize: 12.5 }}>{[cell.technology, cell.status].filter(Boolean).join(' · ')}</div>
                        </div>
                    </div>
                    <KV items={[
                        ['RSRP', sig?.rsrp != null ? `${sig.rsrp} dBm (${rsrpWord(sig.rsrp).toLowerCase()})` : null],
                        ['RSRQ', sig?.rsrq != null ? `${sig.rsrq} dB` : null],
                        ['RSSI', sig?.rssi != null ? `${sig.rssi} dBm` : null],
                        ['SINR', sig?.sinr != null ? `${sig.sinr} dB` : null],
                        ['Band', cell.band || null],
                        ['APN', cell.apn || null],
                        ['IMEI', cell.imei ? <span className="mono">{cell.imei}</span> : null],
                    ]} />
                </Section>
            )}

            {cell?.sims?.length > 0 && (
                <Section title="SIM cards">
                    <div className="card"><div className="list">
                        {cell.sims.map(s => (
                            <div key={s.id} className="list-row" style={{ padding: '10px 14px' }}>
                                <div className="main">
                                    <div className="title">SIM {s.id}{s.carrier ? ` · ${s.carrier}` : ''}</div>
                                    <div className="desc">{s.iccid ? <span className="mono">ICCID {s.iccid}</span> : (s.detected ? 'Detected' : 'Not detected')}{s.apn ? ` · APN ${s.apn}` : ''}</div>
                                </div>
                                {s.active ? <Badge tone="ok">Active</Badge> : <Badge tone="plain">Standby</Badge>}
                            </div>
                        ))}
                    </div></div>
                </Section>
            )}

            {d.wan_interfaces?.length > 0 && (
                <Section title="WAN interfaces">
                    <div className="card"><div className="list">
                        {d.wan_interfaces.map(w => (
                            <div key={w.id} className="list-row" style={{ padding: '10px 14px' }}>
                                <Dot tone={LED_TONE[w.status_led] || 'off'} />
                                <div className="main">
                                    <div className="title">{w.name} <span className="faint" style={{ fontWeight: 400, fontSize: 12.5 }}>{w.type}</span></div>
                                    <div className="desc">{w.message || w.status || '—'}</div>
                                </div>
                                {w.ip && <span className="mono faint">{w.ip}</span>}
                            </div>
                        ))}
                    </div></div>
                </Section>
            )}

            <Section title="Data today">
                <KV items={[
                    ['Total', fmtMB(d.usage_mb)],
                    ['Upload', fmtMB(d.tx_mb)],
                    ['Download', fmtMB(d.rx_mb)],
                    ['Connected clients', d.client_count ?? null],
                ]} />
            </Section>

            <Section title="Device">
                <KV items={[
                    ['Model', d.model],
                    ['Serial', d.sn ? <span className="mono">{d.sn}</span> : null],
                    ['Firmware', d.firmware],
                    ['WAN IP', d.wan_ip ? <span className="mono">{d.wan_ip}</span> : null],
                    ['Uptime', d.online ? fmtUptime(d.uptime) : null],
                    ['Site', d.trailer?.site?.name || null],
                    ['Customer', d.trailer?.customer?.name || null],
                ]} />
            </Section>
        </Drawer>
    )
}
