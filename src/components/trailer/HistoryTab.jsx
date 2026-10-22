import { useEffect, useMemo, useState } from 'react'
import { Line } from 'react-chartjs-2'
import { fetchHistory } from '../../api/vrm'
import { Card, Seg, Empty, Loading } from '../../ui'
import { baseOptions, chartColors, alpha } from '../../ui/chart'
import { RANGES, RANGE_OPTIONS, points } from './telemetry'

// History: battery, solar, load and voltage over 24h / 7d / 30d.
export default function HistoryTab({ siteId }) {
    const [range, setRange] = useState('24h')
    const [rows, setRows] = useState(null)
    const [error, setError] = useState(null)

    useEffect(() => {
        let alive = true
        setRows(null); setError(null)
        const end = Date.now()
        fetchHistory(siteId, end - RANGES[range], end)
            .then(res => { if (alive) setRows((res.records || []).slice().sort((a, b) => Number(a.timestamp) - Number(b.timestamp))) })
            .catch(err => { if (alive) { setError(err.message); setRows([]) } })
        return () => { alive = false }
    }, [siteId, range])

    const c = chartColors()
    const unit = range === '24h' ? 'hour' : 'day'
    const series = useMemo(() => rows ? {
        soc: points(rows, 'battery_soc'),
        solar: points(rows, 'solar_watts'),
        load: points(rows, 'dc_load_watts'),
        volts: points(rows, 'battery_voltage'),
    } : null, [rows])

    const stat = (pts, fn, digits = 0, suffix = '') => {
        if (!pts?.length) return null
        const ys = pts.map(p => p.y)
        return fn(ys).toFixed(digits) + suffix
    }
    const min = ys => Math.min(...ys), max = ys => Math.max(...ys), avg = ys => ys.reduce((a, b) => a + b, 0) / ys.length

    return (
        <div className="stack">
            <div className="toolbar" style={{ marginBottom: 0 }}>
                <Seg options={RANGE_OPTIONS} value={range} onChange={setRange} />
                <span className="spacer" />
                {rows && <span className="faint" style={{ fontSize: 12.5 }}>{rows.length} readings</span>}
            </div>
            {!rows ? <Card><Loading /></Card> : error ? (
                <Card><Empty compact title="Couldn't load history">{error}</Empty></Card>
            ) : rows.length === 0 ? (
                <Card><Empty compact title="No history for this period">Readings build up as the trailer reports. Try a longer range.</Empty></Card>
            ) : (
                <div className="grid-2">
                    <ChartCard title="Battery charge" meta={series.soc.length ? `low ${stat(series.soc, min, 0, '%')} · high ${stat(series.soc, max, 0, '%')}` : null}
                        empty={!series.soc.length}
                        data={{ datasets: [{ label: 'Battery', data: series.soc, borderColor: c.ok, backgroundColor: alpha(c.ok, 0.1), fill: true }] }}
                        options={baseOptions({ time: true, unit, yMin: 0, yMax: 100, ySuffix: '%' })} />
                    <ChartCard title="Solar production" meta={series.solar.length ? `peak ${stat(series.solar, max, 0, ' W')}` : null}
                        empty={!series.solar.length}
                        data={{ datasets: [{ label: 'Solar', data: series.solar, borderColor: c.warn, backgroundColor: alpha(c.warn, 0.12), fill: true }] }}
                        options={baseOptions({ time: true, unit, yMin: 0, ySuffix: ' W' })} />
                    <ChartCard title="DC load" meta={series.load.length ? `avg ${stat(series.load, avg, 0, ' W')}` : null}
                        empty={!series.load.length}
                        data={{ datasets: [{ label: 'Load', data: series.load, borderColor: c.series[1], backgroundColor: alpha(c.series[1], 0.1), fill: true }] }}
                        options={baseOptions({ time: true, unit, yMin: 0, ySuffix: ' W' })} />
                    <ChartCard title="Battery voltage" meta={series.volts.length ? `${stat(series.volts, min, 1)}–${stat(series.volts, max, 1)} V` : null}
                        empty={!series.volts.length}
                        data={{ datasets: [{ label: 'Voltage', data: series.volts, borderColor: c.accent, backgroundColor: alpha(c.accent, 0.08), fill: false }] }}
                        options={baseOptions({ time: true, unit, ySuffix: ' V' })} />
                </div>
            )}
        </div>
    )
}

function ChartCard({ title, meta, data, options, empty }) {
    return (
        <Card title={title} meta={meta} style={{ minWidth: 0 }}>
            {empty ? <Empty compact>No readings for this series.</Empty> : (
                <div style={{ height: 220 }}><Line data={data} options={options} /></div>
            )}
        </Card>
    )
}
