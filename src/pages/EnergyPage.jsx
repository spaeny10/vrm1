import { useState, useCallback, useMemo } from 'react'
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, BarElement,
    Title, Tooltip, Legend
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchFleetEnergy, fetchFleetAlerts } from '../api/vrm'

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend)

function EnergyPage() {
    const [selectedSite, setSelectedSite] = useState(null)

    const fetchEnergyFn = useCallback(() => fetchFleetEnergy(), [])
    const fetchAlertsFn = useCallback(() => fetchFleetAlerts(), [])

    const { data: energyData, loading: energyLoading } = useApiPolling(fetchEnergyFn, 60000)
    const { data: alertsData } = useApiPolling(fetchAlertsFn, 60000)

    const sites = energyData?.records || []
    const alerts = alertsData?.alerts || []

    // Pick a site for the chart
    const activeSite = useMemo(() => {
        if (selectedSite) {
            return sites.find(s => s.site_id === selectedSite)
        }
        // Default to first site with data
        return sites.find(s => s.days && s.days.length > 0) || sites[0]
    }, [sites, selectedSite])

    // Chart data for the selected site
    const chartData = useMemo(() => {
        if (!activeSite?.days?.length) return null
        return {
            labels: activeSite.days.map(d => {
                const dt = new Date(d.date + 'T12:00:00')
                return dt.toLocaleDateString([], { month: 'short', day: 'numeric' })
            }),
            datasets: [
                {
                    label: 'Solar Yield (Wh)',
                    data: activeSite.days.map(d => d.yield_wh ?? 0),
                    backgroundColor: 'rgba(46, 204, 113, 0.8)',
                    borderColor: '#2ecc71',
                    borderWidth: 1,
                    borderRadius: 4,
                },
                {
                    label: 'Consumed (Wh)',
                    data: activeSite.days.map(d => d.consumed_wh ?? 0),
                    backgroundColor: 'rgba(231, 76, 60, 0.8)',
                    borderColor: '#e74c3c',
                    borderWidth: 1,
                    borderRadius: 4,
                },
            ],
        }
    }, [activeSite])

    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                labels: { color: '#bdc3c7', font: { family: 'Inter', size: 13 } }
            },
            tooltip: {
                callbacks: {
                    label: (ctx) => `${ctx.dataset.label}: ${Math.round(ctx.raw)} Wh`
                }
            },
        },
        scales: {
            x: {
                ticks: { color: '#7f8c8d', font: { family: 'Inter', size: 12 } },
                grid: { color: 'rgba(255,255,255,0.05)' },
            },
            y: {
                ticks: {
                    color: '#7f8c8d',
                    font: { family: 'Inter', size: 12 },
                    callback: (v) => `${v} Wh`,
                },
                grid: { color: 'rgba(255,255,255,0.05)' },
            },
        },
    }

    // Aggregate energy table data
    const tableData = useMemo(() => {
        return sites.map(site => {
            const todayData = site.days && site.days.length > 0
                ? site.days[site.days.length - 1]
                : null
            const yieldWh = todayData?.yield_wh ?? null
            const consumedWh = todayData?.consumed_wh ?? null
            const hasAlert = alerts.find(a => a.site_id === site.site_id)
            return {
                ...site,
                today_yield: yieldWh,
                today_consumed: consumedWh,
                balance: yieldWh !== null && consumedWh !== null ? yieldWh - consumedWh : null,
                alert: hasAlert,
            }
        })
    }, [sites, alerts])

    return (
        <div className="energy-page">
            <div className="page-header">
                <h1>⚡ Energy Analysis</h1>
                <p className="page-subtitle">Daily solar yield vs consumption across your fleet</p>
            </div>

            {/* Alert Banner */}
            {alerts.length > 0 && (
                <div className="energy-alerts-banner">
                    <div className="alert-banner-header">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>{alerts.length} site{alerts.length > 1 ? 's' : ''} with energy deficit alerts</span>
                    </div>
                    <div className="alert-banner-items">
                        {alerts.map(alert => (
                            <div key={alert.site_id} className={`alert-item alert-${alert.severity}`}>
                                <span className="alert-site-name">{alert.site_name}</span>
                                <span className="alert-streak">{alert.streak_days} day streak</span>
                                <span className="alert-badge">{alert.severity}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Chart Section */}
            <div className="energy-chart-section">
                <div className="energy-chart-header">
                    <h2>Daily Yield vs Consumed</h2>
                    <select
                        className="site-selector"
                        value={activeSite?.site_id || ''}
                        onChange={e => setSelectedSite(parseInt(e.target.value))}
                    >
                        {sites.map(site => (
                            <option key={site.site_id} value={site.site_id}>
                                {site.site_name}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="energy-chart-container">
                    {chartData ? (
                        <Bar data={chartData} options={chartOptions} />
                    ) : (
                        <div className="chart-empty">
                            {energyLoading ? 'Loading energy data...' : 'No energy data yet. Data accumulates after each polling cycle (every 5 min).'}
                        </div>
                    )}
                </div>
            </div>

            {/* Fleet Energy Table */}
            <div className="energy-table-section">
                <h2>Fleet Energy Summary (Today)</h2>
                <div className="energy-table-wrapper">
                    <table className="energy-table">
                        <thead>
                            <tr>
                                <th>Site</th>
                                <th>Yield (Wh)</th>
                                <th>Consumed (Wh)</th>
                                <th>Balance</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tableData.length === 0 ? (
                                <tr>
                                    <td colSpan="5" className="empty-state">
                                        {energyLoading ? 'Loading...' : 'No data yet. Wait for first polling cycle.'}
                                    </td>
                                </tr>
                            ) : (
                                tableData.map(site => (
                                    <tr
                                        key={site.site_id}
                                        className={`energy-row ${site.alert ? 'has-alert' : ''}`}
                                        onClick={() => setSelectedSite(site.site_id)}
                                    >
                                        <td className="site-name-cell">
                                            {site.alert && <span className="inline-alert-dot" />}
                                            {site.site_name}
                                        </td>
                                        <td className="yield-cell">
                                            {site.today_yield !== null ? Math.round(site.today_yield) : '—'}
                                        </td>
                                        <td className="consumed-cell">
                                            {site.today_consumed !== null ? Math.round(site.today_consumed) : '—'}
                                        </td>
                                        <td className={`balance-cell ${site.balance !== null ? (site.balance >= 0 ? 'positive' : 'negative') : ''}`}>
                                            {site.balance !== null ? `${site.balance >= 0 ? '+' : ''}${Math.round(site.balance)}` : '—'}
                                        </td>
                                        <td>
                                            {site.alert ? (
                                                <span className={`energy-status-badge ${site.alert.severity}`}>
                                                    {site.alert.streak_days}d deficit
                                                </span>
                                            ) : (
                                                <span className="energy-status-badge ok">OK</span>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}

export default EnergyPage
