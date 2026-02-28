import { Fragment, useState, useCallback, useMemo } from 'react'
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, BarElement,
    Title, Tooltip, Legend
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchFleetEnergy, fetchFleetAlerts, fetchJobSites } from '../api/vrm'
import DataFreshness from '../components/DataFreshness'

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend)

function EnergyPage() {
    const [selectedSite, setSelectedSite] = useState(null)
    const [expandedJobSites, setExpandedJobSites] = useState(new Set())
    const [expandedAlerts, setExpandedAlerts] = useState(new Set())

    const fetchEnergyFn = useCallback(() => fetchFleetEnergy(), [])
    const fetchAlertsFn = useCallback(() => fetchFleetAlerts(), [])
    const fetchJobSitesFn = useCallback(() => fetchJobSites(), [])

    const { data: energyData, loading: energyLoading, lastUpdated } = useApiPolling(fetchEnergyFn, 60000)
    const { data: alertsData } = useApiPolling(fetchAlertsFn, 60000)
    const { data: jobSitesData } = useApiPolling(fetchJobSitesFn, 60000)

    const sites = energyData?.records || []
    const alerts = alertsData?.alerts || []
    const jobSites = jobSitesData?.job_sites || []

    // Build trailer-to-job-site mapping
    const trailerToJobSite = useMemo(() => {
        const map = {}
        for (const js of jobSites) {
            for (const t of (js.trailers || [])) {
                map[t.site_id] = { jobSiteId: js.id, jobSiteName: js.name }
            }
        }
        return map
    }, [jobSites])

    // Pick a site for the chart
    const activeSite = useMemo(() => {
        if (selectedSite) {
            return sites.find(s => s.site_id === selectedSite)
        }
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

    // Build table data grouped by job site
    const groupedTableData = useMemo(() => {
        // First, enrich each trailer with today's energy
        const trailerData = sites.map(site => {
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
                jobSite: trailerToJobSite[site.site_id] || null,
            }
        })

        // Group by job site
        const groups = new Map()
        const ungrouped = []
        for (const t of trailerData) {
            if (t.jobSite) {
                if (!groups.has(t.jobSite.jobSiteId)) {
                    groups.set(t.jobSite.jobSiteId, {
                        jobSiteId: t.jobSite.jobSiteId,
                        jobSiteName: t.jobSite.jobSiteName,
                        trailers: [],
                        total_yield: 0,
                        total_consumed: 0,
                        alertCount: 0,
                    })
                }
                const g = groups.get(t.jobSite.jobSiteId)
                g.trailers.push(t)
                if (t.today_yield != null) g.total_yield += t.today_yield
                if (t.today_consumed != null) g.total_consumed += t.today_consumed
                if (t.alert) g.alertCount++
            } else {
                ungrouped.push(t)
            }
        }

        const sorted = [...groups.values()].sort((a, b) =>
            a.jobSiteName.localeCompare(b.jobSiteName, undefined, { numeric: true })
        )

        return { groups: sorted, ungrouped }
    }, [sites, alerts, trailerToJobSite])

    const toggleExpand = (jobSiteId) => {
        setExpandedJobSites(prev => {
            const next = new Set(prev)
            if (next.has(jobSiteId)) next.delete(jobSiteId)
            else next.add(jobSiteId)
            return next
        })
    }

    return (
        <div className="energy-page">
            <div className="page-header">
                <div className="page-header-row">
                    <h1>Energy Analysis</h1>
                    <DataFreshness lastUpdated={lastUpdated} />
                </div>
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
                        <span>{alerts.length} trailer{alerts.length > 1 ? 's' : ''} with energy deficit alerts</span>
                    </div>
                    <div className="alert-banner-items">
                        {alerts.map(alert => {
                            const isExpanded = expandedAlerts.has(alert.site_id)
                            return (
                                <div key={alert.site_id} className={`alert-card alert-card-${alert.severity}`}>
                                    <div
                                        className="alert-card-header"
                                        onClick={() => setExpandedAlerts(prev => {
                                            const next = new Set(prev)
                                            if (next.has(alert.site_id)) next.delete(alert.site_id)
                                            else next.add(alert.site_id)
                                            return next
                                        })}
                                    >
                                        <span className="alert-severity-icon">
                                            {alert.severity === 'critical' ? '!!' : '!'}
                                        </span>
                                        <span className="alert-site-name">{alert.site_name}</span>
                                        <span className="alert-streak">{alert.streak_days} day streak</span>
                                        <span className="alert-badge">{alert.severity}</span>
                                        <span className="alert-expand-icon">{isExpanded ? '▾' : '▸'}</span>
                                    </div>
                                    {isExpanded && alert.deficit_days?.length > 0 && (
                                        <div className="alert-deficit-detail">
                                            <table className="alert-deficit-table">
                                                <thead>
                                                    <tr>
                                                        <th>Date</th>
                                                        <th>Yield</th>
                                                        <th>Consumed</th>
                                                        <th>Balance</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {alert.deficit_days.map(day => (
                                                        <tr key={day.date}>
                                                            <td>{new Date(day.date + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}</td>
                                                            <td>{Math.round(day.yield_wh)} Wh</td>
                                                            <td>{Math.round(day.consumed_wh)} Wh</td>
                                                            <td className={day.yield_wh - day.consumed_wh >= 0 ? 'positive' : 'negative'}>
                                                                {Math.round(day.yield_wh - day.consumed_wh)} Wh
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            )
                        })}
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

            {/* Fleet Energy Table - Grouped by Job Site */}
            <div className="energy-table-section">
                <h2>Fleet Energy Summary (Today)</h2>
                <div className="energy-table-wrapper">
                    <table className="energy-table">
                        <thead>
                            <tr>
                                <th>Site / Trailer</th>
                                <th>Yield (Wh)</th>
                                <th>Consumed (Wh)</th>
                                <th>Balance</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {groupedTableData.groups.length === 0 && groupedTableData.ungrouped.length === 0 ? (
                                <tr>
                                    <td colSpan="5" className="empty-state">
                                        {energyLoading ? 'Loading...' : 'No data yet. Wait for first polling cycle.'}
                                    </td>
                                </tr>
                            ) : (
                                <>
                                    {groupedTableData.groups.map(group => {
                                        const balance = group.total_yield - group.total_consumed
                                        const isExpanded = expandedJobSites.has(group.jobSiteId)
                                        return (
                                            <Fragment key={`js-${group.jobSiteId}`}>
                                                <tr
                                                    className={`energy-row energy-row-group ${group.alertCount > 0 ? 'has-alert' : ''}`}
                                                    onClick={() => toggleExpand(group.jobSiteId)}
                                                >
                                                    <td className="site-name-cell">
                                                        <span className="expand-icon">{isExpanded ? '▾' : '▸'}</span>
                                                        {group.alertCount > 0 && <span className="inline-alert-dot" />}
                                                        <strong>{group.jobSiteName}</strong>
                                                        <span className="trailer-count-badge">{group.trailers.length}</span>
                                                    </td>
                                                    <td className="yield-cell">{Math.round(group.total_yield)}</td>
                                                    <td className="consumed-cell">{Math.round(group.total_consumed)}</td>
                                                    <td className={`balance-cell ${balance >= 0 ? 'positive' : 'negative'}`}>
                                                        {`${balance >= 0 ? '+' : ''}${Math.round(balance)}`}
                                                    </td>
                                                    <td>
                                                        {group.alertCount > 0 ? (
                                                            <span className="energy-status-badge warning">{group.alertCount} alert{group.alertCount > 1 ? 's' : ''}</span>
                                                        ) : (
                                                            <span className="energy-status-badge ok">OK</span>
                                                        )}
                                                    </td>
                                                </tr>
                                                {isExpanded && group.trailers.map(trailer => (
                                                    <tr
                                                        key={trailer.site_id}
                                                        className={`energy-row energy-row-child ${trailer.alert ? 'has-alert' : ''}`}
                                                        onClick={() => setSelectedSite(trailer.site_id)}
                                                    >
                                                        <td className="site-name-cell site-name-indent">
                                                            {trailer.alert && <span className="inline-alert-dot" />}
                                                            {trailer.site_name}
                                                        </td>
                                                        <td className="yield-cell">
                                                            {trailer.today_yield !== null ? Math.round(trailer.today_yield) : '—'}
                                                        </td>
                                                        <td className="consumed-cell">
                                                            {trailer.today_consumed !== null ? Math.round(trailer.today_consumed) : '—'}
                                                        </td>
                                                        <td className={`balance-cell ${trailer.balance !== null ? (trailer.balance >= 0 ? 'positive' : 'negative') : ''}`}>
                                                            {trailer.balance !== null ? `${trailer.balance >= 0 ? '+' : ''}${Math.round(trailer.balance)}` : '—'}
                                                        </td>
                                                        <td>
                                                            {trailer.alert ? (
                                                                <span className={`energy-status-badge ${trailer.alert.severity}`}>
                                                                    {trailer.alert.streak_days}d deficit
                                                                </span>
                                                            ) : (
                                                                <span className="energy-status-badge ok">OK</span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </Fragment>
                                        )
                                    })}
                                    {/* Ungrouped trailers */}
                                    {groupedTableData.ungrouped.map(site => (
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
                                    ))}
                                </>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}

export default EnergyPage
