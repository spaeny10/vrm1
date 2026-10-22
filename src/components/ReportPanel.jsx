import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchTrailerReport, fetchSiteReport, fetchFleetReportData } from '../api/vrm'
import { Badge, Grade, KV, Empty, Loading, Icon } from '../ui'
import { fmtDate, fmtDateTime, fmtAgo, fmtPct, fmtWatts, fmtKwh, fmtNum, toDate } from '../ui/format'
import { chargeStateLabel, fmtWh, STALE_MS } from './trailer/telemetry'

// ============================================================
// Printable report for a trailer, a job site, or the fleet.
// Props: { type: 'trailer' | 'site' | 'fleet', id, onClose }
// Rendered in a portal so "Print / Save PDF" prints only the report.
// ============================================================

const PRINT_CSS = `
@media print {
  @page { margin: 14mm; }
  html, body { background: #fff !important; height: auto !important; }
  body > *:not(.report-root) { display: none !important; }
  .report-root { position: static !important; display: block !important; padding: 0 !important; background: none !important; animation: none !important;
    --text: #111; --text-2: #333; --text-3: #666; --surface: #fff; --surface-2: #f5f5f5; --surface-3: #eee; --bg: #fff;
    --border: #d9d9d9; --border-strong: #c8c8c8; --ok: #1d7a45; --warn: #9a5c00; --crit: #b3261e; --off: #555; --info: #1f5fbf; color: #111; }
  .report-root .modal { max-width: none !important; max-height: none !important; overflow: visible !important; border: 0 !important; box-shadow: none !important; background: #fff !important; }
  .report-root .modal-body { padding: 0 !important; }
  .report-root .no-print { display: none !important; }
  .report-root .table th { position: static; }
  .report-section { break-inside: avoid; }
}`

const MAINT_STATUS = { scheduled: 'info', in_progress: 'warn', completed: 'ok', cancelled: 'plain' }
const MAINT_LABEL = { scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }
const VISIT = { inspection: 'Inspection', repair: 'Repair', scheduled: 'Scheduled service', emergency: 'Emergency', installation: 'Installation', decommission: 'Decommission' }

export default function ReportPanel({ type, id, onClose }) {
    const [report, setReport] = useState(null)
    const [error, setError] = useState('')

    useEffect(() => {
        let alive = true
        setReport(null); setError('')
        const p = type === 'trailer' ? fetchTrailerReport(id) : type === 'fleet' ? fetchFleetReportData() : fetchSiteReport(id)
        p.then(d => alive && setReport(d.report)).catch(err => alive && setError(err.message))
        return () => { alive = false }
    }, [type, id])

    useEffect(() => {
        const h = e => { if (e.key === 'Escape') onClose?.() }
        window.addEventListener('keydown', h)
        return () => window.removeEventListener('keydown', h)
    }, [onClose])

    const title = !report ? 'Report'
        : type === 'trailer' ? `${report.trailer?.site_name || 'Trailer'} report`
            : type === 'fleet' ? 'Fleet report' : `${report.job_site?.name || 'Site'} report`

    return createPortal(
        <div className="overlay report-root" onMouseDown={e => { if (e.target === e.currentTarget) onClose?.() }}>
            <style>{PRINT_CSS}</style>
            <div className="modal wide" role="dialog" aria-label={title} style={{ maxWidth: 880 }}>
                <div className="modal-head no-print">
                    <h2>{title}</h2>
                    <div className="btn-row" style={{ alignItems: 'center' }}>
                        <button className="btn primary sm" onClick={() => window.print()} disabled={!report}><Icon name="download" />Print / Save PDF</button>
                        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
                    </div>
                </div>
                <div className="modal-body">
                    {error ? <Empty title="Couldn't build the report">{error}</Empty>
                        : !report ? <Loading label="Building report…" />
                            : type === 'trailer' ? <TrailerReport r={report} />
                                : type === 'fleet' ? <FleetReport r={report} />
                                    : <SiteReport r={report} />}
                </div>
            </div>
        </div>,
        document.body,
    )
}

// ---------- shared pieces ----------
function DocHead({ title, kind, generated, right, sub }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, paddingBottom: 14, marginBottom: 18, borderBottom: '1px solid var(--border)' }}>
            <div>
                <div className="faint" style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>BIGView OMNI · {kind}</div>
                <div style={{ fontSize: 22, fontWeight: 650, marginTop: 4 }}>{title}</div>
                {sub && <div className="muted" style={{ marginTop: 2 }}>{sub}</div>}
                <div className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>Generated {fmtDateTime(generated)}</div>
            </div>
            {right}
        </div>
    )
}

function Section({ title, children }) {
    return (
        <section className="report-section" style={{ marginBottom: 22 }}>
            <h3 style={{ fontSize: 13, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-2)', marginBottom: 10 }}>{title}</h3>
            {children}
        </section>
    )
}

function TwoCol({ left, right }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 36px' }}>
            <KV items={left} /><KV items={right} />
        </div>
    )
}

function Table({ head, rows, align = [] }) {
    return (
        <div className="table-wrap">
            <table className="table">
                <thead><tr>{head.map((h, i) => <th key={i} className={align[i] === 'r' ? 'r' : ''}>{h}</th>)}</tr></thead>
                <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={align[j] === 'r' ? 'r num' : ''}>{c}</td>)}</tr>)}</tbody>
            </table>
        </div>
    )
}

function MaintenanceTable({ logs, showTrailer }) {
    if (!logs.length) return <div className="faint">No service visits on record.</div>
    return (
        <Table head={['Date', ...(showTrailer ? ['Trailer'] : []), 'Visit', 'Type', 'Status', 'Technician']}
            rows={logs.map(m => [
                fmtDate(Number(m.completed_date || m.scheduled_date || m.created_at)),
                ...(showTrailer ? [m.trailer_name || '—'] : []),
                m.title,
                VISIT[m.visit_type] || m.visit_type || '—',
                <Badge key="s" tone={MAINT_STATUS[m.status] || 'plain'}>{MAINT_LABEL[m.status] || m.status}</Badge>,
                m.assigned_technician_name || m.technician || '—',
            ])} />
    )
}

const num = (v, digits, unit = '') => v == null || isNaN(Number(v)) ? '—' : `${Number(v).toFixed(digits)}${unit}`

// ---------- trailer ----------
function TrailerReport({ r }) {
    const s = r.current_status
    const intel = r.intelligence
    const last = s?.vrm_timestamp || s?.timestamp || null
    const stale = !last || Date.now() - Number(last) > STALE_MS
    const g = r.health_grade

    // Merge recent and upcoming maintenance (they overlap)
    const maint = []
    const seen = new Set()
    for (const m of [...(r.maintenance?.upcoming || []), ...(r.maintenance?.recent || [])]) {
        if (seen.has(m.id)) continue
        seen.add(m.id); maint.push(m)
    }
    maint.sort((a, b) => Number(b.completed_date || b.scheduled_date || b.created_at) - Number(a.completed_date || a.scheduled_date || a.created_at))

    const socByDate = new Map((r.battery_history || []).map(b => [String(b.date).slice(0, 10), b]))
    const days = (r.energy_history || []).map(e => {
        const b = socByDate.get(e.date)
        const bal = e.yield_wh != null && e.consumed_wh != null ? e.yield_wh - e.consumed_wh : null
        return [
            fmtDate(e.date),
            fmtWh(e.yield_wh),
            e.expected_yield_wh ? fmtWh(e.expected_yield_wh) : '—',
            fmtWh(e.consumed_wh),
            bal == null ? '—' : <span key="b" style={{ color: bal >= 0 ? 'var(--ok)' : 'var(--warn)' }}>{bal >= 0 ? '+' : '−'}{fmtWh(Math.abs(bal))}</span>,
            b ? (Math.round(b.min_soc) === Math.round(b.max_soc) ? `${Math.round(b.max_soc)}%` : `${Math.round(b.min_soc)}–${Math.round(b.max_soc)}%`) : e.battery_soc_eod != null ? `${Math.round(e.battery_soc_eod)}% (end of day)` : '—',
        ]
    })

    return (
        <div>
            <DocHead title={r.trailer?.site_name} kind="Trailer report" generated={r.generated_at}
                right={g && (
                    <div style={{ textAlign: 'right' }}>
                        <div className="faint" style={{ fontSize: 12 }}>Health grade</div>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 4 }}><Grade grade={g.grade} /><span className="num" style={{ fontWeight: 600 }}>{g.score}/100</span></div>
                    </div>
                )} />

            <Section title="Current status">
                {!s ? <div className="faint">This trailer has not reported any battery or solar data.</div> : (
                    <>
                        {stale && <div className="callout warn" style={{ marginBottom: 12 }}><Icon name="alert" size={18} /><div>Not reporting. Values are from the last report{last ? `, ${fmtDateTime(Number(last))} (${fmtAgo(Number(last))})` : ''}.</div></div>}
                        <TwoCol
                            left={[
                                ['Battery charge', fmtPct(s.battery_soc, 1)],
                                ['Battery voltage', num(s.battery_voltage, 1, ' V')],
                                ['Battery current', num(s.battery_current, 1, ' A')],
                                ['Battery temperature', num(s.battery_temp, 1, '°C')],
                                ['DC load', fmtWatts(s.dc_load_watts)],
                            ]}
                            right={[
                                ['Solar now', fmtWatts(s.solar_watts)],
                                ['Solar today', fmtKwh(s.solar_yield_today, 2)],
                                ['Solar yesterday', fmtKwh(s.solar_yield_yesterday, 2)],
                                ['Charger state', chargeStateLabel(s.charge_state) || '—'],
                                ['Last data', last ? fmtDateTime(Number(last)) : '—'],
                            ]} />
                    </>
                )}
            </Section>

            {intel && (
                <Section title="Energy outlook">
                    <TwoCol
                        left={[
                            ['Solar score', intel.solar.score != null ? `${Math.round(intel.solar.score)}%${intel.solar.score_label ? ` (${intel.solar.score_label})` : ''}` : '—'],
                            ['7-day average score', intel.solar.avg_7d_score != null ? `${Math.round(intel.solar.avg_7d_score)}%` : '—'],
                            ['Panel output now', intel.solar.panel_performance_pct != null ? `${Math.round(intel.solar.panel_performance_pct)}% of ${fmtNum(intel.specs.solar_capacity_w)} W` : '—'],
                            ['Expected yield today', fmtWh(intel.location.expected_daily_yield_wh)],
                            ['Peak sun hours', num(intel.location.peak_sun_hours, 1, ' h')],
                        ]}
                        right={[
                            ['Stored energy', fmtWh(intel.battery.stored_wh)],
                            ['Average daily use', fmtWh(intel.energy.avg_daily_consumption_wh)],
                            ['Days of autonomy', intel.battery.days_of_autonomy != null ? `${intel.battery.days_of_autonomy} days` : '—'],
                            ['Time to full', intel.battery.charge_time_hours != null ? `${intel.battery.charge_time_hours} h` : '—'],
                            ['Energy balance today', intel.energy.today_balance_wh != null ? `${intel.energy.today_balance_wh >= 0 ? '+' : '−'}${fmtWh(Math.abs(intel.energy.today_balance_wh))}` : '—'],
                        ]} />
                </Section>
            )}

            <Section title="Active alerts">
                {(r.alerts || []).length === 0 ? <div className="faint">No active alerts.</div> : (
                    <div style={{ display: 'grid', gap: 8 }}>
                        {r.alerts.map((a, i) => (
                            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                <Badge tone={a.severity === 'critical' ? 'crit' : 'warn'}>{a.severity === 'critical' ? 'Critical' : 'Warning'}</Badge>
                                <span>Using more energy than solar provides, {a.streak_days} days in a row</span>
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            <Section title="Service history">
                <MaintenanceTable logs={maint} />
            </Section>

            {days.length > 0 && (
                <Section title={`Daily energy (last ${days.length} days)`}>
                    <Table head={['Date', 'Solar', 'Expected', 'Used', 'Balance', 'Battery range']} rows={days} align={['', 'r', 'r', 'r', 'r', 'r']} />
                </Section>
            )}
        </div>
    )
}

// ---------- site ----------
function SiteReport({ r }) {
    const js = r.job_site || {}
    const trailers = r.trailers || []
    const live = trailers.filter(t => t.battery_soc != null)
    const avgSoc = live.length ? live.reduce((a, t) => a + t.battery_soc, 0) / live.length : null
    const yieldToday = live.reduce((a, t) => a + (t.yield_today || 0), 0)

    return (
        <div>
            <DocHead title={js.name} kind="Site report" generated={r.generated_at}
                sub={[js.address, js.customer_name].filter(Boolean).join(' · ') || null} />
            <Section title="Summary">
                <TwoCol
                    left={[
                        ['Trailers on site', trailers.length],
                        ['Reporting now', `${live.length} of ${trailers.length}`],
                    ]}
                    right={[
                        ['Average battery', fmtPct(avgSoc)],
                        ['Solar today (all units)', fmtKwh(yieldToday)],
                    ]} />
            </Section>
            <Section title="Trailers">
                {trailers.length === 0 ? <div className="faint">No trailers assigned to this site.</div> : (
                    <Table head={['Trailer', 'Grade', 'Battery', 'Solar now', 'Solar today']} align={['', '', 'r', 'r', 'r']}
                        rows={trailers.map(t => [
                            <b key="n">{t.site_name}</b>,
                            t.health_grade ? <Grade key="g" grade={t.health_grade.grade} /> : <span key="g" className="faint">—</span>,
                            t.battery_soc != null ? fmtPct(t.battery_soc) : <span key="s" className="faint">Not reporting</span>,
                            t.solar_watts != null ? fmtWatts(t.solar_watts) : '—',
                            t.yield_today != null ? fmtKwh(t.yield_today, 2) : '—',
                        ])} />
                )}
            </Section>
            <Section title="Service history">
                <MaintenanceTable logs={r.maintenance?.recent || []} showTrailer />
            </Section>
        </div>
    )
}

// ---------- fleet ----------
function FleetReport({ r }) {
    const k = r.kpis || {}
    const trailers = [...(r.trailers || [])].sort((a, b) => (a.health_grade?.score ?? 999) - (b.health_grade?.score ?? 999))
    const gd = r.grade_distribution || {}
    return (
        <div>
            <DocHead title="Fleet overview" kind="Fleet report" generated={r.generated_at} />
            <Section title="Summary">
                <TwoCol
                    left={[
                        ['Trailers reporting', `${k.online ?? '—'} of ${k.total_trailers ?? '—'}`],
                        ['Average battery', fmtPct(k.avg_soc, 1)],
                        ['Active alerts', k.active_alerts ?? '—'],
                    ]}
                    right={[
                        ['Solar today', fmtKwh(k.total_yield_today_kwh)],
                        ['Grades', ['A', 'B', 'C', 'D', 'F'].map(x => `${x} ${gd[x] || 0}`).join(' · ')],
                    ]} />
            </Section>
            <Section title="Trailers (lowest grade first)">
                <Table head={['Trailer', 'Grade', 'Battery', 'Solar now', 'Solar today', 'Days of autonomy']} align={['', '', 'r', 'r', 'r', 'r']}
                    rows={trailers.map(t => [
                        <b key="n">{t.site_name}</b>,
                        t.health_grade ? <Grade key="g" grade={t.health_grade.grade} /> : '—',
                        fmtPct(t.battery_soc),
                        fmtWatts(t.solar_watts),
                        fmtKwh(t.yield_today, 2),
                        t.intelligence?.battery?.days_of_autonomy ?? '—',
                    ])} />
            </Section>
            {(r.energy_trends || []).length > 0 && (
                <Section title="Fleet energy by day">
                    <Table head={['Date', 'Solar', 'Used']} align={['', 'r', 'r']}
                        rows={r.energy_trends.map(e => [fmtDate(toDate(e.date)), fmtWh(e.yield_wh), fmtWh(e.consumed_wh)])} />
                </Section>
            )}
        </div>
    )
}
