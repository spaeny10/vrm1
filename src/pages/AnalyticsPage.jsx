import { useState, useCallback, useMemo, useEffect } from 'react'
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
} from 'chart.js'
import { Line, Bar } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import {
    fetchFleetAnalytics, fetchAnalyticsRankings, fetchJobSites,
    fetchJobSiteAnalytics, backfillAnalytics
} from '../api/vrm'
import { generateCSV, downloadCSV } from '../utils/csv'

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

    const [selectedSites, setSelectedSites] = useState([])
    const [comparisonData, setComparisonData] = useState({})
    const [comparisonLoading, setComparisonLoading] = useState(false)

    const daily = fleetData?.daily || []
    const dateRange = fleetData?.date_range || {}
    const rankings = rankingsData?.rankings || []
    const jobSites = jobSitesData?.job_sites || []
    const activeJobSites = useMemo(() => jobSites.filter(js => js.status === 'active'), [jobSites])

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

    const handleExportCSV = () => {
        const headers = ['Date', 'Avg SOC (%)', 'Min SOC (%)', 'Solar Yield (kWh)', 'Data Usage (MB)', 'Uptime (%)']
        const rows = daily.map(d => [
            d.date,
            d.fleet_avg_soc ? Number(d.fleet_avg_soc).toFixed(1) : '',
            d.fleet_min_soc ? Number(d.fleet_min_soc).toFixed(1) : '',
            d.fleet_yield_kwh ? Number(d.fleet_yield_kwh).toFixed(2) : '',
            d.fleet_data_mb ? Number(d.fleet_data_mb).toFixed(1) : '',
            d.fleet_uptime ? Number(d.fleet_uptime).toFixed(1) : '',
        ])
        const csv = generateCSV(headers, rows)
        downloadCSV(csv, `fleet-analytics-${days}d-${new Date().toISOString().slice(0, 10)}.csv`)
    }

    // Fetch comparison data when sites selected
    useEffect(() => {
        if (selectedSites.length < 2) {
            setComparisonData({})
            return
        }
        let cancelled = false
        setComparisonLoading(true)
        Promise.all(
            selectedSites.map(id =>
                fetchJobSiteAnalytics(id, days).then(res => ({ id, data: res.data || [] }))
            )
        ).then(results => {
            if (cancelled) return
            const map = {}
            for (const r of results) map[r.id] = r.data
            setComparisonData(map)
            setComparisonLoading(false)
        }).catch(() => {
            if (!cancelled) setComparisonLoading(false)
        })
        return () => { cancelled = true }
    }, [selectedSites, days])

    const toggleSite = (id) => {
        setSelectedSites(prev => {
            if (prev.includes(id)) return prev.filter(s => s !== id)
            if (prev.length >= 4) return prev
            return [...prev, id]
        })
    }

    const COMPARISON_COLORS = ['#3498db', '#2ecc71', '#f39c12', '#e74c3c']

    const comparisonSocChart = useMemo(() => {
        if (selectedSites.length < 2 || !Object.keys(comparisonData).length) return null
        const allDates = new Set()
        for (const siteData of Object.values(comparisonData)) {
            for (const d of siteData) allDates.add(d.date)
        }
        const dates = [...allDates].sort()
        const labels = dates.map(d => new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }))
        const datasets = selectedSites.map((siteId, i) => {
            const site = activeJobSites.find(js => js.id === siteId)
            const siteData = comparisonData[siteId] || []
            const dateMap = Object.fromEntries(siteData.map(d => [d.date, d]))
            return {
                label: site?.name || `Site ${siteId}`,
                data: dates.map(d => dateMap[d] ? +Number(dateMap[d].avg_soc).toFixed(1) : null),
                borderColor: COMPARISON_COLORS[i],
                backgroundColor: 'transparent',
                tension: 0.3,
                pointRadius: 2,
                spanGaps: true,
            }
        })
        return { labels, datasets }
    }, [selectedSites, comparisonData, activeJobSites])

    const comparisonYieldChart = useMemo(() => {
        if (selectedSites.length < 2 || !Object.keys(comparisonData).length) return null
        const allDates = new Set()
        for (const siteData of Object.values(comparisonData)) {
            for (const d of siteData) allDates.add(d.date)
        }
        const dates = [...allDates].sort()
        const labels = dates.map(d => new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }))
        const datasets = selectedSites.map((siteId, i) => {
            const site = activeJobSites.find(js => js.id === siteId)
            const siteData = comparisonData[siteId] || []
            const dateMap = Object.fromEntries(siteData.map(d => [d.date, d]))
            return {
                label: site?.name || `Site ${siteId}`,
                data: dates.map(d => dateMap[d] ? +Number(dateMap[d].total_yield_kwh).toFixed(2) : 0),
                backgroundColor: COMPARISON_COLORS[i] + 'BB',
                borderColor: COMPARISON_COLORS[i],
                borderWidth: 1,
                borderRadius: 3,
            }
        })
        return { labels, datasets }
    }, [selectedSites, comparisonData, activeJobSites])

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
                    <button className="btn btn-secondary" onClick={handleExportCSV} disabled={daily.length === 0}>
                        Export CSV
                    </button>
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

            {/* Site Comparison */}
            {activeJobSites.length >= 2 && (
                <div className="comparison-section">
                    <div className="comparison-header">
                        <h2>Site Comparison</h2>
                        <span className="comparison-hint">Select 2–4 sites to compare</span>
                    </div>
                    <div className="comparison-site-selector">
                        {activeJobSites.map(js => (
                            <button
                                key={js.id}
                                className={`comparison-chip ${selectedSites.includes(js.id) ? 'active' : ''}`}
                                onClick={() => toggleSite(js.id)}
                                style={selectedSites.includes(js.id) ? {
                                    borderColor: COMPARISON_COLORS[selectedSites.indexOf(js.id)],
                                    backgroundColor: COMPARISON_COLORS[selectedSites.indexOf(js.id)] + '22',
                                } : undefined}
                            >
                                {js.name}
                            </button>
                        ))}
                    </div>
                    {comparisonLoading && <p className="text-muted" style={{ padding: '1rem' }}>Loading comparison...</p>}
                    {selectedSites.length >= 2 && !comparisonLoading && comparisonSocChart && (
                        <div className="comparison-charts">
                            <div className="analytics-chart-card">
                                <h3>SOC Comparison</h3>
                                <div className="analytics-chart-container">
                                    <Line data={comparisonSocChart} options={chartOptions('SOC Comparison', '%')} />
                                </div>
                            </div>
                            <div className="analytics-chart-card">
                                <h3>Yield Comparison</h3>
                                <div className="analytics-chart-container">
                                    {comparisonYieldChart && <Bar data={comparisonYieldChart} options={chartOptions('Yield Comparison', ' kWh')} />}
                                </div>
                            </div>
                        </div>
                    )}
                    {selectedSites.length === 1 && (
                        <p className="text-muted" style={{ padding: '1rem' }}>Select at least one more site to compare.</p>
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
