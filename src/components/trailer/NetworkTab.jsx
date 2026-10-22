import { useEffect, useMemo, useState } from 'react'
import { Line, Bar } from 'react-chartjs-2'
import { fetchPepwaveHistory } from '../../api/vrm'
import { Card, KV, Badge, Seg, Empty, Loading, Dot } from '../../ui'
import { fmtAgo, fmtDateTime, isoDate, toDate } from '../../ui/format'
import { baseOptions, chartColors, alpha } from '../../ui/chart'
import { RANGES, RANGE_OPTIONS, points, rsrpQuality, sinrQuality, fmtUptime, fmtMB } from './telemetry'

// Network: Peplink router status, SIMs/WAN, and signal + data history.
export default function NetworkTab({ device }) {
    if (!device) {
        return <Card><Empty title="No router linked">No Peplink router reports under this trailer's name, so there's no cellular data to show.</Empty></Card>
    }
    const cell = device.cellular || {}
    const sig = cell.signal || {}
    const rq = rsrpQuality(sig.rsrp), sq = sinrQuality(sig.sinr)

    return (
        <div className="stack">
            <div className="grid-2">
                <Card title="Router" meta={device.model} actions={device.online ? <Badge tone="ok" dot>Online</Badge> : <Badge tone="off" dot>Offline</Badge>}>
                    <KV items={[
                        !device.online && device.offline_since && ['Offline since', `${fmtDateTime(device.offline_since)} (${fmtAgo(device.offline_since)})`],
                        ['Carrier', cell.carrier || '—'],
                        ['Technology', [cell.technology, cell.band && `band ${cell.band}`].filter(Boolean).join(' · ') || '—'],
                        ['RSRP (strength)', sig.rsrp != null ? <span>{sig.rsrp} dBm {rq && <Badge tone={rq.tone}>{rq.label}</Badge>}</span> : '—'],
                        ['SINR (quality)', sig.sinr != null ? <span>{sig.sinr} dB {sq && <Badge tone={sq.tone}>{sq.label}</Badge>}</span> : '—'],
                        ['RSRQ', sig.rsrq != null ? `${sig.rsrq} dB` : '—'],
                        ['Clients', device.client_count ?? '—'],
                        ['Data today', fmtMB(device.usage_mb)],
                        ['Uptime', fmtUptime(device.uptime)],
                        ['WAN IP', device.wan_ip ? <span className="mono">{device.wan_ip}</span> : '—'],
                    ]} />
                </Card>
                <Card title="SIMs and WAN" flush>
                    <div className="list">
                        {(cell.sims || []).map(sim => (
                            <div key={`sim${sim.id}`} className="list-row">
                                <Dot tone={sim.active ? 'ok' : 'off'} />
                                <div className="main">
                                    <div className="title">SIM {sim.id} {sim.active ? <Badge tone="ok">Active</Badge> : <Badge tone="plain">{sim.detected ? 'Standby' : 'Empty'}</Badge>}</div>
                                    <div className="desc">{[sim.carrier, sim.apn && `APN ${sim.apn}`].filter(Boolean).join(' · ') || '—'}</div>
                                </div>
                                {sim.iccid && <div className="side mono">ICCID {sim.iccid}</div>}
                            </div>
                        ))}
                        {(device.wan_interfaces || []).map(w => (
                            <div key={`wan${w.id}`} className="list-row">
                                <Dot tone={w.status_led === 'green' ? 'ok' : w.status_led === 'red' ? 'crit' : w.status_led === 'yellow' || w.status_led === 'orange' ? 'warn' : 'off'} />
                                <div className="main">
                                    <div className="title">{w.name} <span className="faint" style={{ fontWeight: 400 }}>{w.type}</span></div>
                                    <div className="desc">{w.message || w.status || '—'}</div>
                                </div>
                                {w.ip && <div className="side mono">{w.ip}</div>}
                            </div>
                        ))}
                        {!(cell.sims || []).length && !(device.wan_interfaces || []).length && <Empty compact>No SIM or WAN details reported.</Empty>}
                    </div>
                </Card>
            </div>
            <NetworkHistory name={device.name} />
        </div>
    )
}

function NetworkHistory({ name }) {
    const [range, setRange] = useState('24h')
    const [rows, setRows] = useState(null)

    useEffect(() => {
        let alive = true
        setRows(null)
        const end = Date.now()
        fetchPepwaveHistory(name, end - RANGES[range], end)
            .then(res => { if (alive) setRows((res.records || []).slice().sort((a, b) => Number(a.timestamp) - Number(b.timestamp))) })
            .catch(() => { if (alive) setRows([]) })
        return () => { alive = false }
    }, [name, range])

    const c = chartColors()
    const unit = range === '24h' ? 'hour' : 'day'

    // usage_mb is a running total for the current day: take each day's max
    const daily = useMemo(() => {
        if (!rows) return []
        const byDay = new Map()
        for (const r of rows) {
            if (r.usage_mb == null) continue
            const day = isoDate(Number(r.timestamp))
            byDay.set(day, Math.max(byDay.get(day) || 0, Number(r.usage_mb)))
        }
        return [...byDay.entries()].map(([day, mb]) => ({ x: toDate(day).getTime(), y: mb }))
    }, [rows])

    const signalOpts = useMemo(() => {
        const o = baseOptions({ time: true, unit, legend: true })
        o.scales.y.title = { display: true, text: 'RSRP dBm', color: c.faint }
        o.scales.y1 = { position: 'right', grid: { display: false }, border: { display: false }, ticks: { color: c.faint }, title: { display: true, text: 'SINR dB', color: c.faint } }
        return o
    }, [unit, c.faint])

    return (
        <Card title="Signal and data history" actions={<Seg options={RANGE_OPTIONS} value={range} onChange={setRange} />}>
            {!rows ? <Loading /> : rows.length === 0 ? (
                <Empty compact title="No history for this period">Signal history builds up as the router is polled.</Empty>
            ) : (
                <div className="grid-2">
                    <div style={{ minWidth: 0 }}>
                        <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Signal strength and quality</div>
                        <div style={{ height: 220 }}>
                            <Line data={{
                                datasets: [
                                    { label: 'RSRP (dBm)', data: points(rows, 'rsrp'), borderColor: c.accent, backgroundColor: alpha(c.accent, 0.1), yAxisID: 'y' },
                                    { label: 'SINR (dB)', data: points(rows, 'sinr'), borderColor: c.series[2], yAxisID: 'y1' },
                                ],
                            }} options={signalOpts} />
                        </div>
                    </div>
                    <div style={{ minWidth: 0 }}>
                        <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>{range === '24h' ? 'Data used today (running total)' : 'Data used per day'}</div>
                        <div style={{ height: 220 }}>
                            {range === '24h' ? (
                                <Line data={{ datasets: [{ label: 'Data', data: points(rows, 'usage_mb'), borderColor: c.series[1], backgroundColor: alpha(c.series[1], 0.12), fill: true, stepped: true }] }}
                                    options={baseOptions({ time: true, unit, yMin: 0, ySuffix: ' MB' })} />
                            ) : (
                                <Bar data={{ datasets: [{ label: 'Data', data: daily, backgroundColor: alpha(c.series[1], 0.7), borderRadius: 3 }] }}
                                    options={baseOptions({ time: true, unit: 'day', yMin: 0, ySuffix: ' MB' })} />
                            )}
                        </div>
                    </div>
                </div>
            )}
        </Card>
    )
}
