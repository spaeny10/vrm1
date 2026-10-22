import { useCallback } from 'react'
import { Line } from 'react-chartjs-2'
import { useApiPolling } from '../../hooks/useApiPolling'
import { fetchBatteryHealth } from '../../api/vrm'
import { Card, Badge, Empty, AllClear, Loading, Icon } from '../../ui'
import { fmtAgo, fmtDateTime, fmtNum, toDate } from '../../ui/format'
import { baseOptions, chartColors, alpha } from '../../ui/chart'
import AlarmBadge from '../AlarmBadge'
import { fmtWh } from './telemetry'

const SCORE_TONE = { Excellent: 'ok', Good: 'ok', Fair: 'warn', Poor: 'crit' }

// Overview: alarms and predictions first, then the energy picture and
// the 30-day battery trend.
export default function OverviewTab({ siteId, intel, alarms, stale, d }) {
    const vrmFaults = [
        d.alarmReason && { key: 'ar', type: 'alarm', name: `Battery monitor alarm: ${d.alarmReason}`, device: 'Battery Monitor' },
        d.errorCode && { key: 'err', type: 'alarm', name: `Charger error: ${d.errorCode}`, device: 'Solar Charger' },
    ].filter(Boolean)
    const allAlarms = [...vrmFaults, ...alarms]

    return (
        <div className="grid-main">
            <div className="stack">
                <IntelligenceCard intel={intel} stale={stale} />
                <BatteryHealthCard siteId={siteId} />
            </div>
            <div className="stack">
                <Card title="Active alarms" meta={allAlarms.length || null} flush>
                    {allAlarms.length === 0 ? <AllClear>No active alarms from the Victron system.</AllClear> : (
                        <div className="list">
                            {allAlarms.map((a, i) => (
                                <div key={a.key || i} className="list-row">
                                    <div className="main">
                                        <div className="title"><AlarmBadge level={a.type === 'alarm' ? 'alarm' : 'warning'} />{a.name || a.description || 'Alarm'}</div>
                                        <div className="desc">{a.device || 'Victron system'}</div>
                                    </div>
                                    {a.started ? <div className="side" title={fmtDateTime(a.started * 1000)}>since {fmtAgo(a.started * 1000)}</div> : null}
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
                {intel && <TodayCard intel={intel} />}
            </div>
        </div>
    )
}

function Metric({ label, value, unit, hint, tone }) {
    return (
        <div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500 }}>{label}</div>
            <div className="num" style={{ fontSize: 22, fontWeight: 650, marginTop: 4, letterSpacing: '-0.01em', color: tone ? `var(--${tone})` : undefined }}>
                {value}{unit && <small style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-2)', marginLeft: 3 }}>{unit}</small>}
            </div>
            {hint && <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3 }}>{hint}</div>}
        </div>
    )
}

function IntelligenceCard({ intel, stale }) {
    if (!intel) {
        return (
            <Card title="Energy outlook">
                <Empty compact title={stale ? 'Waiting for live data' : 'Not available yet'}>
                    {stale ? 'Solar score, autonomy and charge estimates need live battery data. They return when the trailer reports again.' : 'Estimates appear once the trailer has reported for a little while.'}
                </Empty>
            </Card>
        )
    }
    const { solar, battery, energy, specs, predictive } = intel
    const autonomy = battery.days_of_autonomy
    const autonomyTone = autonomy == null ? null : autonomy < 1 ? 'crit' : autonomy < 2 ? 'warn' : null
    const showPredict = predictive?.days_to_critical != null && predictive.days_to_critical <= (predictive.warning_threshold_days ?? 3)

    return (
        <Card title="Energy outlook" meta={`${fmtNum(specs.solar_capacity_w)} W solar · ${(specs.battery_capacity_wh / 1000).toFixed(1)} kWh battery`}>
            <div className="stack" style={{ gap: 16 }}>
                {showPredict && (
                    <div className={`callout ${predictive.status === 'critical' ? 'crit' : 'warn'}`}>
                        <Icon name="battery" size={18} />
                        <div>
                            {predictive.days_to_critical <= 0
                                ? <><b>Battery is below {predictive.critical_soc_pct}%.</b> At current usage it won't recover without more sun or less load.</>
                                : <><b>Battery reaches {predictive.critical_soc_pct}% in about {predictive.days_to_critical} {predictive.days_to_critical === 1 ? 'day' : 'days'}</b> at the current rate of use.</>}
                        </div>
                    </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 18 }}>
                    <Metric label="Solar score" value={solar.score != null ? Math.round(solar.score) : '—'} unit={solar.score != null ? '%' : null}
                        tone={SCORE_TONE[solar.score_label] === 'crit' ? 'crit' : SCORE_TONE[solar.score_label] === 'warn' ? 'warn' : null}
                        hint={<>{solar.score_label && <Badge tone={SCORE_TONE[solar.score_label] || 'plain'}>{solar.score_label}</Badge>}{solar.avg_7d_score != null && <span style={{ marginLeft: 6 }}>7-day avg {Math.round(solar.avg_7d_score)}%</span>}</>} />
                    <Metric label="Days of autonomy" value={autonomy ?? '—'} unit={autonomy != null ? 'days' : null} tone={autonomyTone}
                        hint={battery.stored_wh != null && energy.avg_daily_consumption_wh ? `${fmtWh(battery.stored_wh)} stored, uses ${fmtWh(energy.avg_daily_consumption_wh)}/day` : 'Without any sun'} />
                    <Metric label="Time to full" value={battery.charge_time_hours ?? '—'} unit={battery.charge_time_hours != null ? 'hrs' : null}
                        hint={battery.charge_time_hours != null ? `${fmtWh(battery.remaining_to_full_wh)} to go at current solar` : battery.remaining_to_full_wh === 0 ? 'Battery full' : 'Not enough sun right now'} />
                    <Metric label="Panel output" value={solar.panel_performance_pct != null ? Math.round(solar.panel_performance_pct) : '—'} unit={solar.panel_performance_pct != null ? '%' : null}
                        hint={solar.current_watts != null ? `${Math.round(solar.current_watts)} W of ${fmtNum(specs.solar_capacity_w)} W rated` : null} />
                </div>
                {solar.score_adjustment_reason && (
                    <div className="faint" style={{ fontSize: 12.5 }}>Score adjusted up: the battery is full, so the charger is deliberately throttling solar.</div>
                )}
            </div>
        </Card>
    )
}

function TodayCard({ intel }) {
    const { energy, location } = intel
    const expected = location.expected_daily_yield_wh
    const y = energy.today_yield_wh, c = energy.today_consumed_wh
    const scale = Math.max(expected || 0, y || 0, c || 0, 1)
    const bal = energy.today_balance_wh
    const source = location.data_source === 'open-meteo' ? 'Open-Meteo forecast' : location.data_source === 'default' ? null : 'astronomical estimate'

    return (
        <Card title="Today's energy" meta={bal != null ? <span style={{ color: bal >= 0 ? 'var(--ok)' : 'var(--warn)', fontWeight: 600 }}>{bal >= 0 ? '+' : '−'}{fmtWh(Math.abs(bal))}</span> : null}>
            <div className="stack" style={{ gap: 14 }}>
                <Bar label="Solar in" value={y} scale={scale} tone="" />
                <Bar label="Used" value={c} scale={scale} tone="warn" />
                <div className="faint" style={{ fontSize: 12.5 }}>
                    Expected {fmtWh(expected)} from {location.peak_sun_hours != null ? `${Number(location.peak_sun_hours).toFixed(1)} peak sun hours` : 'typical sun'}
                    {location.cloud_cover_pct != null && `, ${location.cloud_cover_pct}% cloud cover`}
                    {location.sunshine_hours != null && `, ${Number(location.sunshine_hours).toFixed(1)} h sunshine`}.
                    {' '}{source ? `Weather from ${source}.` : 'Using a 5-hour U.S. average (no GPS weather).'}
                </div>
            </div>
        </Card>
    )
}

function Bar({ label, value, scale, tone }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 72px', gap: 10, alignItems: 'center', fontSize: 13 }}>
            <span className="muted">{label}</span>
            <span className={`meter ${tone}`}><i style={{ width: `${value != null ? Math.max(2, Math.min(100, (value / scale) * 100)) : 0}%` }} /></span>
            <span className="num" style={{ textAlign: 'right' }}>{fmtWh(value)}</span>
        </div>
    )
}

const TREND = {
    improving: { tone: 'ok', label: 'Improving' },
    stable: { tone: 'plain', label: 'Stable' },
    declining: { tone: 'warn', label: 'Declining' },
}

function BatteryHealthCard({ siteId }) {
    const fn = useCallback(() => fetchBatteryHealth(siteId, 30), [siteId])
    const { data, loading } = useApiPolling(fn, 600000)
    const pts = data?.data_points || data?.dataPoints || []
    const t = TREND[data?.trend]
    const c = chartColors()

    return (
        <Card title="Battery health" meta="Daily peak and low charge, 30 days" actions={t && <Badge tone={t.tone}>{t.label}</Badge>}>
            {loading && !data ? <Loading /> : !t || pts.length < 3 ? (
                <Empty compact title="Not enough history yet">The trend appears after three days of data.</Empty>
            ) : (
                <div className="stack" style={{ gap: 12 }}>
                    <div className="muted" style={{ fontSize: 13 }}>
                        Peak charge is {data.trend === 'stable' ? 'holding steady' : data.trend === 'improving' ? 'rising' : 'falling'}
                        {data.avg_daily_change != null && ` (${data.avg_daily_change > 0 ? '+' : ''}${data.avg_daily_change}% a day)`}.
                        {data.days_until_critical != null && ` At this rate it drops to 20% in about ${data.days_until_critical} days.`}
                    </div>
                    <div style={{ height: 180 }}>
                        <Line
                            data={{
                                datasets: [
                                    { label: 'Peak', data: pts.map(p => ({ x: toDate(p.date)?.getTime(), y: p.max_soc })), borderColor: c.accent, backgroundColor: alpha(c.accent, 0.12), fill: '+1' },
                                    { label: 'Low', data: pts.map(p => ({ x: toDate(p.date)?.getTime(), y: p.min_soc })), borderColor: c.faint, borderDash: [4, 4], borderWidth: 1.5 },
                                ],
                            }}
                            options={baseOptions({ time: true, unit: 'day', yMin: 0, yMax: 100, ySuffix: '%', legend: true })}
                        />
                    </div>
                </div>
            )}
        </Card>
    )
}
