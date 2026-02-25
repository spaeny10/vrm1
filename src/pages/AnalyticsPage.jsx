import { useState, useCallback, useMemo } from 'react'
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
} from 'chart.js'
import { Line, Bar } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import {
    fetchFleetAnalytics, fetchAnalyticsRankings, fetchJobSites, backfillAnalytics
} from '../api/vrm'

ChartJS.register(
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
)

const RANGE_OPTIONS = [
    { value: 7, label: '7d' },
    { value: 30, label: '30d' },
    { value: 90, label: '90d' },
]

function AnalyticsPage() {
    const [days, setDays] = useState(30)
    const [backfilling, setBackfilling] = useState(false)
    const [backfillMsg, setBackfillMsg] = useState('')

    const fetchFleetFn = useCallback(() => fetchFleetAnalytics(days), [days])
    const fetchRankingsFn = useCallback(() => fetchAnalyticsRankings(days), [days])
    const fetchJobSitesFn = useCallback(() => fetchJobSites(), [])

    const { data: fleetData, loading: fleetLoading, refetch: refetchFleet } = useApiPolling(fetchFleetFn, 120000)
    const { data: rankingsData, refetch: refetchRankings } = useApiPolling(fetchRankingsFn, 120000)
    const { data: jobSitesData } = useApiPolling(fetchJobSitesFn, 60000)

    const daily = fleetData?.daily || []
    const dateRange = fleetData?.date_range || {}
    const rankings = rankingsData?.rankings || []
    const jobSites = jobSitesData?.job_sites || []

    const handleBackfill = async () => {
        setBackfilling(true)
        setBackfillMsg('')
        try {
            const result = await backfillAnalytics(days)
            setBackfillMsg(`Computed ${result.rows_computed} metrics across ${result.days_processed} days`)
            refetchFleet()
            refetchRankings()
        } catch (err) {
            setBackfillMsg('Error: ' + err.message)
        }
        setBackfilling(false)
    }

    // Fleet SOC trend chart
    const socChartData = useMemo(() => {
        if (!daily.length) return null
        return {
            labels: daily.map(d => {
                const dt = new Date(d.date)
                return dt.toLocaleDateString([], { month: 'short', day: 'numeric' })
            }),
            datasets: [
                {
                    label: 'Avg SOC (%)',
                    data: daily.map(d => d.fleet_avg_soc ? +Number(d.fleet_avg_soc).toFixed(1) : null),
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2,
                },
                {
                    label: 'Min SOC (%)',
                    data: daily.map(d => d.fleet_min_soc ? +Number(d.fleet_min_soc).toFixed(1) : null),
                    borderColor: '#e74c3c',
                    backgroundColor: 'rgba(231, 76, 60, 0.05)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2,
                    borderDash: [5, 3],
                },
            ],
        }
    }, [daily])

    // Fleet yield chart
    const yieldChartData = useMemo(() => {
        if (!daily.length) return null
        return {
            labels: daily.map(d => {
                const dt = new Date(d.date)
                return dt.toLocaleDateString([], { month: 'short', day: 'numeric' })
            }),
            datasets: [
                {
                    label: 'Solar Yield (kWh)',
                    data: daily.map(d => d.fleet_yield_kwh ? +Number(d.fleet_yield_kwh).toFixed(2) : 0),
                    backgroundColor: 'rgba(46, 204, 113, 0.7)',
                    borderColor: '#2ecc71',
                    borderWidth: 1,
                    borderRadius: 3,
                },
            ],
        }
    }, [daily])

    const chartOptions = (title, yLabel) => ({
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                labels: { color: '#bdc3c7', font: { family: 'Inter', size: 12 } }
            },
            tooltip: {
                mode: 'index',
                intersect: false,
            },
        },
        scales: {
            x: {
                ticks: { color: '#7f8c8d', font: { family: 'Inter', size: 11 } },
                grid: { color: 'rgba(255,255,255,0.05)' },
            },
            y: {
                ticks: {
                    color: '#7f8c8d',
                    font: { family: 'Inter', size: 11 },
                    callback: (v) => `${v}${yLabel}`,
                },
                grid: { color: 'rgba(255,255,255,0.05)' },
            },
        },
    })

    // Summary KPIs from daily data
    const summaryKpis = useMemo(() => {
        if (!daily.length) return null
        const avgSoc = daily.reduce((s, d) => s + (Number(d.fleet_avg_soc) || 0), 0) / daily.length
        const totalYield = daily.reduce((s, d) => s + (Number(d.fleet_yield_kwh) || 0), 0)
        const avgUptime = daily.reduce((s, d) => s + (Number(d.fleet_uptime) || 0), 0) / daily.length
        const totalData = daily.reduce((s, d) => s + (Number(d.fleet_data_mb) || 0), 0)
        return {
            avgSoc: avgSoc.toFixed(1),
            totalYield: totalYield.toFixed(1),
            avgUptime: avgUptime.toFixed(0),
            totalData: totalData >= 1024 ? `${(totalData / 1024).toFixed(1)} GB` : `${Math.round(totalData)} MB`,
        }
    }, [daily])

    return (
        <div className="analytics-page">
            <div className="page-header">
                <h1>Analytics</h1>
                <p className="page-subtitle">
                    Fleet performance trends and site rankings
                    {dateRange.days_count ? ` — ${dateRange.days_count} days of data` : ''}
                </p>
            </div>

            {/* Controls */}
            <div className="analytics-controls">
                <div className="analytics-range-selector">
                    {RANGE_OPTIONS.map(opt => (
                        <button
                            key={opt.value}
                            className={`range-btn ${days === opt.value ? 'active' : ''}`}
                            onClick={() => setDays(opt.value)}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
                <div className="analytics-actions">
                    <button
                        className="btn btn-secondary"
                        onClick={handleBackfill}
                        disabled={backfilling}
                    >
                        {backfilling ? 'Computing...' : 'Backfill Data'}
                    </button>
                    {backfillMsg && <span className="analytics-msg">{backfillMsg}</span>}
                </div>
            </div>

            {/* KPI Summary */}
            {summaryKpis && (
                <div className="kpi-row">
                    <div className="kpi-card kpi-teal">
                        <div className="kpi-label">Avg SOC ({days}d)</div>
                        <div className="kpi-value">{summaryKpis.avgSoc}%</div>
                    </div>
                    <div className="kpi-card kpi-green">
                        <div className="kpi-label">Total Yield ({days}d)</div>
                        <div className="kpi-value">{summaryKpis.totalYield} kWh</div>
                    </div>
                    <div className="kpi-card kpi-blue">
                        <div className="kpi-label">Avg Uptime</div>
                        <div className="kpi-value">{summaryKpis.avgUptime}%</div>
                    </div>
                    <div className="kpi-card kpi-yellow">
                        <div className="kpi-label">Data Usage</div>
                        <div className="kpi-value">{summaryKpis.totalData}</div>
                    </div>
                </div>
            )}

            {/* Charts */}
            {daily.length > 0 ? (
                <div className="analytics-charts">
                    <div className="analytics-chart-card">
                        <h3>Fleet SOC Trend</h3>
                        <div className="analytics-chart-container">
                            {socChartData && <Line data={socChartData} options={chartOptions('SOC Trend', '%')} />}
                        </div>
                    </div>
                    <div className="analytics-chart-card">
                        <h3>Daily Solar Yield</h3>
                        <div className="analytics-chart-container">
                            {yieldChartData && <Bar data={yieldChartData} options={chartOptions('Solar Yield', ' kWh')} />}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="analytics-empty">
                    {fleetLoading ? (
                        <p>Loading analytics data...</p>
                    ) : (
                        <>
                            <p>No analytics data yet. Click "Backfill Data" to compute metrics from existing snapshots.</p>
                            <p className="text-muted">Daily metrics are automatically computed after each VRM poll.</p>
                        </>
                    )}
                </div>
            )}

            {/* Rankings Table */}
            <div className="analytics-rankings">
                <h2>Site Rankings ({days}d average)</h2>
                {rankings.length > 0 ? (
                    <div className="rankings-table-wrapper">
                        <table className="rankings-table">
                            <thead>
                                <tr>
                                    <th>#</th>
                                    <th>Site</th>
                                    <th>Trailers</th>
                                    <th>Avg SOC</th>
                                    <th>Min SOC</th>
                                    <th>Avg Daily Yield</th>
                                    <th>Uptime</th>
                                    <th>Avg Voltage</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rankings.map((r, i) => {
                                    const avgSoc = r.avg_soc ? +Number(r.avg_soc).toFixed(1) : null
                                    const socColor = avgSoc === null ? '' : avgSoc >= 60 ? 'rank-good' : avgSoc >= 30 ? 'rank-warn' : 'rank-bad'
                                    return (
                                        <tr key={r.job_site_id} className="rankings-row">
                                            <td className="rank-num">{i + 1}</td>
                                            <td className="rank-name">{r.job_site_name}</td>
                                            <td>{r.trailer_count}</td>
                                            <td className={socColor}>{avgSoc !== null ? `${avgSoc}%` : '—'}</td>
                                            <td className={r.min_soc != null && r.min_soc < 20 ? 'rank-bad' : ''}>
                                                {r.min_soc != null ? `${Number(r.min_soc).toFixed(1)}%` : '—'}
                                            </td>
                                            <td>{r.avg_daily_yield_kwh != null ? `${Number(r.avg_daily_yield_kwh).toFixed(2)} kWh` : '—'}</td>
                                            <td>{r.avg_uptime != null ? `${Number(r.avg_uptime).toFixed(0)}%` : '—'}</td>
                                            <td>{r.avg_voltage != null ? `${Number(r.avg_voltage).toFixed(1)}V` : '—'}</td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <div className="empty-section">
                        <p>No ranking data. Backfill analytics data first.</p>
                    </div>
                )}
            </div>
        </div>
    )
}

export default AnalyticsPage
