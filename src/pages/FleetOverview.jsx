import { useState, useCallback, useMemo } from 'react'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchSites, fetchFleetLatest, fetchFleetCombined, fetchJobSites, fetchFleetIntelligence, fetchActionQueue, acknowledgeAction, fetchHealthGrades } from '../api/vrm'
import KpiCard from '../components/KpiCard'
import TrailerCard from '../components/TrailerCard'
import JobSiteCard from '../components/JobSiteCard'
import QueryBar from '../components/QueryBar'
import DataFreshness from '../components/DataFreshness'
import { generateCSV, downloadCSV } from '../utils/csv'

function FleetOverview() {
    const [viewMode, setViewMode] = useState('sites') // 'sites' or 'trailers'
    const [sortBy, setSortBy] = useState('name')
    const [filterAlarm, setFilterAlarm] = useState('all')
    const [searchTerm, setSearchTerm] = useState('')
    const [actionQueueOpen, setActionQueueOpen] = useState(true)

    // Action queue data
    const fetchActionQueueFn = useCallback(() => fetchActionQueue(), [])
    const { data: actionQueueData, refetch: refetchActions } = useApiPolling(fetchActionQueueFn, 30000)
    const actionItems = actionQueueData?.actions || []

    // Health grades data
    const fetchHealthGradesFn = useCallback(() => fetchHealthGrades(), [])
    const { data: healthGradesData } = useApiPolling(fetchHealthGradesFn, 60000)
    const healthGradesMap = useMemo(() => {
        const grades = healthGradesData?.grades
        if (!grades || typeof grades !== 'object') return {}
        // Backend returns { siteId: gradeObj } already as a map
        if (Array.isArray(grades)) {
            const map = {}
            grades.forEach(g => { map[g.site_id] = g })
            return map
        }
        return grades
    }, [healthGradesData])

    // Action queue computed values
    const actionQueueSummary = useMemo(() => {
        const critical = actionItems.filter(a => a.priority <= 3 && !a.acknowledged_at).length
        const warnings = actionItems.filter(a => a.priority >= 4 && a.priority <= 5 && !a.acknowledged_at).length
        const acknowledged = actionItems.filter(a => a.acknowledged_at).length
        return { critical, warnings, acknowledged }
    }, [actionItems])

    const sortedActions = useMemo(() => {
        const unacked = actionItems
            .filter(a => !a.acknowledged_at)
            .sort((a, b) => a.priority - b.priority)
            .slice(0, 10)
        const acked = actionItems
            .filter(a => a.acknowledged_at)
            .sort((a, b) => a.priority - b.priority)
        return { unacked, acked }
    }, [actionItems])

    const handleAcknowledge = async (key) => {
        try {
            await acknowledgeAction(key, '')
            refetchActions()
        } catch (err) {
            console.error('Failed to acknowledge action:', err)
        }
    }

    // Job sites data
    const fetchJobSitesFn = useCallback(() => fetchJobSites(), [])
    const { data: jobSitesData, loading: jobSitesLoading, lastUpdated, refetch } = useApiPolling(fetchJobSitesFn, 30000)
    const jobSites = jobSitesData?.job_sites || []

    // Trailer-level data (for "All Trailers" view)
    const fetchSitesFn = useCallback(() => fetchSites(), [])
    const fetchLatestFn = useCallback(() => fetchFleetLatest(), [])
    const fetchCombinedFn = useCallback(() => fetchFleetCombined(), [])

    const { data: sitesData, loading: sitesLoading } = useApiPolling(fetchSitesFn, 60000)
    const { data: latestData } = useApiPolling(fetchLatestFn, 30000)
    const { data: combinedData } = useApiPolling(fetchCombinedFn, 60000)

    const fetchIntelFn = useCallback(() => fetchFleetIntelligence(), [])
    const { data: intelData } = useApiPolling(fetchIntelFn, 60000)
    const fleetIntel = intelData?.fleet || null

    const sites = sitesData?.records || []
    const snapshots = latestData?.records || []
    const pepwaveMap = combinedData?.pepwave || {}

    // Build lookup map: siteId -> latest snapshot
    const snapshotMap = useMemo(() => {
        const map = {}
        snapshots.forEach(s => { map[s.site_id] = s })
        return map
    }, [snapshots])

    // Build lookup: siteId -> job site name
    const trailerJobSiteMap = useMemo(() => {
        const map = {}
        for (const js of jobSites) {
            for (const t of (js.trailers || [])) {
                map[t.site_id] = js.name
            }
        }
        return map
    }, [jobSites])

    // KPIs — computed from job sites when in sites view, trailers when in trailers view
    const kpis = useMemo(() => {
        if (viewMode === 'sites') {
            const activeSites = jobSites.filter(js => js.status === 'active')
            const atRisk = activeSites.filter(js => js.worst_status === 'critical').length
            const totalTrailers = activeSites.reduce((s, js) => s + js.trailer_count, 0)
            const trailersOnline = activeSites.reduce((s, js) => s + js.trailers_online, 0)
            const totalYield = activeSites.reduce((s, js) => {
                const trailerYield = (js.trailers || []).reduce((ts, t) => ts + (t.solar_yield_today || 0), 0)
                return s + trailerYield
            }, 0)
            let totalSoc = 0, socCount = 0
            activeSites.forEach(js => {
                if (js.avg_soc != null) { totalSoc += js.avg_soc * js.trailer_count; socCount += js.trailer_count }
            })

            return {
                jobSiteCount: activeSites.length,
                totalTrailers,
                trailersOnline,
                atRisk,
                avgSoc: socCount > 0 ? (totalSoc / socCount).toFixed(1) : '--',
                totalYield: totalYield.toFixed(1),
            }
        }

        // Trailer view KPIs
        const total = sites.length
        let online = 0, alarmCount = 0, totalSoc = 0, socCount = 0, totalYield = 0
        sites.forEach(site => {
            const snap = snapshotMap[site.idSite]
            if (snap) {
                online++
                if (snap.battery_soc !== null && snap.battery_soc < 20) alarmCount++
                if (snap.battery_soc !== null) { totalSoc += snap.battery_soc; socCount++ }
                if (snap.solar_yield_today !== null) totalYield += snap.solar_yield_today
            }
        })

        return {
            jobSiteCount: jobSites.length,
            totalTrailers: total,
            trailersOnline: online,
            atRisk: alarmCount,
            avgSoc: socCount > 0 ? (totalSoc / socCount).toFixed(1) : '--',
            totalYield: totalYield.toFixed(1),
        }
    }, [viewMode, jobSites, sites, snapshotMap])

    // Filter + sort job sites
    const filteredJobSites = useMemo(() => {
        let result = [...jobSites]

        if (searchTerm) {
            const term = searchTerm.toLowerCase()
            result = result.filter(js =>
                js.name.toLowerCase().includes(term) ||
                (js.trailers || []).some(t => t.site_name.toLowerCase().includes(term))
            )
        }

        if (filterAlarm === 'alarm') result = result.filter(js => js.worst_status === 'critical')
        else if (filterAlarm === 'warning') result = result.filter(js => js.worst_status === 'warning' || js.worst_status === 'critical')

        result.sort((a, b) => {
            if (sortBy === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true })
            if (sortBy === 'soc') return (a.avg_soc ?? -1) - (b.avg_soc ?? -1)
            if (sortBy === 'soc-desc') return (b.avg_soc ?? -1) - (a.avg_soc ?? -1)
            if (sortBy === 'trailers') return b.trailer_count - a.trailer_count
            return 0
        })

        return result
    }, [jobSites, sortBy, filterAlarm, searchTerm])

    // Filter + sort trailers (existing logic)
    const filteredSites = useMemo(() => {
        let result = [...sites]

        if (searchTerm) {
            const term = searchTerm.toLowerCase()
            result = result.filter(s => s.name.toLowerCase().includes(term))
        }

        if (filterAlarm === 'alarm') {
            result = result.filter(s => {
                const snap = snapshotMap[s.idSite]
                return snap && snap.battery_soc !== null && snap.battery_soc < 20
            })
        } else if (filterAlarm === 'warning') {
            result = result.filter(s => {
                const snap = snapshotMap[s.idSite]
                return snap && snap.battery_soc !== null && snap.battery_soc < 40
            })
        } else if (filterAlarm === 'offline') {
            result = result.filter(s => !snapshotMap[s.idSite])
        } else if (filterAlarm === 'net-offline') {
            result = result.filter(s => {
                const pw = pepwaveMap[s.name]
                return pw && !pw.online
            })
        }

        result.sort((a, b) => {
            if (sortBy === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true })
            if (sortBy === 'soc') return (snapshotMap[a.idSite]?.battery_soc ?? -1) - (snapshotMap[b.idSite]?.battery_soc ?? -1)
            if (sortBy === 'soc-desc') return (snapshotMap[b.idSite]?.battery_soc ?? -1) - (snapshotMap[a.idSite]?.battery_soc ?? -1)
            if (sortBy === 'solar') return (snapshotMap[b.idSite]?.solar_watts ?? -1) - (snapshotMap[a.idSite]?.solar_watts ?? -1)
            if (sortBy === 'signal') return (pepwaveMap[a.name]?.rsrp ?? -999) - (pepwaveMap[b.name]?.rsrp ?? -999)
            return 0
        })

        return result
    }, [sites, snapshotMap, sortBy, filterAlarm, searchTerm, pepwaveMap])

    const isLoading = viewMode === 'sites' ? (jobSitesLoading && !jobSitesData) : (sitesLoading && !sitesData)

    const handleExport = () => {
        if (viewMode === 'sites') {
            const headers = ['Job Site', 'Status', 'Trailers', 'Online', 'Avg SOC (%)', 'Min SOC (%)', 'Total Solar (W)']
            const rows = filteredJobSites.map(js => [
                js.name, js.status, js.trailer_count, js.trailers_online,
                js.avg_soc != null ? Number(js.avg_soc).toFixed(1) : '',
                js.min_soc != null ? Number(js.min_soc).toFixed(1) : '',
                js.total_solar != null ? Math.round(js.total_solar) : '',
            ])
            downloadCSV(generateCSV(headers, rows), 'fleet-sites.csv')
        } else {
            const headers = ['Trailer', 'Job Site', 'SOC (%)', 'Voltage (V)', 'Solar (W)', 'Yield Today (kWh)', 'Network']
            const rows = filteredSites.map(s => {
                const snap = snapshotMap[s.idSite]
                const pw = pepwaveMap[s.name]
                return [
                    s.name, trailerJobSiteMap[s.idSite] || '',
                    snap?.battery_soc != null ? Number(snap.battery_soc).toFixed(1) : '',
                    snap?.battery_voltage != null ? Number(snap.battery_voltage).toFixed(1) : '',
                    snap?.solar_watts != null ? Math.round(snap.solar_watts) : '',
                    snap?.solar_yield_today != null ? Number(snap.solar_yield_today).toFixed(2) : '',
                    pw?.online ? 'Online' : 'Offline',
                ]
            })
            downloadCSV(generateCSV(headers, rows), 'fleet-trailers.csv')
        }
    }

    if (isLoading) {
        return (
            <div className="page-loading">
                <div className="spinner"></div>
                <p>Loading fleet data...</p>
            </div>
        )
    }

    return (
        <div className="fleet-overview">
            <div className="page-header">
                <div className="page-header-row">
                    <h1>Fleet Overview</h1>
                    <div className="page-header-actions">
                        <button className="btn btn-sm btn-ghost" onClick={handleExport} title="Export CSV">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                            </svg>
                            Export
                        </button>
                        <DataFreshness lastUpdated={lastUpdated} refetch={refetch} />
                    </div>
                </div>
                <p className="page-subtitle">
                    {kpis.jobSiteCount} job sites, {kpis.totalTrailers} trailers monitored
                </p>
            </div>

            <div className="kpi-row">
                <KpiCard title="Job Sites" value={kpis.jobSiteCount} color="blue" />
                <KpiCard title="Trailers Online" value={`${kpis.trailersOnline}/${kpis.totalTrailers}`} color="green" />
                <KpiCard title="Sites at Risk" value={kpis.atRisk} color={kpis.atRisk > 0 ? 'red' : 'teal'} />
                <KpiCard title="Fleet Avg SOC" value={kpis.avgSoc} unit="%" color="teal" />
                <KpiCard title="Total Yield" value={kpis.totalYield} unit="kWh" color="yellow" />
            </div>

            {fleetIntel && (
                <div className="kpi-row">
                    <KpiCard title="Avg Solar Score" value={fleetIntel.avg_solar_score !== null ? fleetIntel.avg_solar_score : '--'} unit="%" color="yellow" />
                    <KpiCard title="Avg Autonomy" value={fleetIntel.avg_days_autonomy !== null ? fleetIntel.avg_days_autonomy : '--'} unit="days" color={fleetIntel.avg_days_autonomy > 2 ? 'green' : 'red'} />
                    <KpiCard title="Underperforming" value={fleetIntel.underperforming_count} color={fleetIntel.underperforming_count > 0 ? 'red' : 'teal'} />
                    <KpiCard title="Low Autonomy" value={fleetIntel.low_autonomy_count} color={fleetIntel.low_autonomy_count > 0 ? 'red' : 'teal'} />
                </div>
            )}

            {/* Action Queue Section */}
            {actionItems.length > 0 && (
                <div className="action-queue">
                    <div
                        className="action-queue-header"
                        onClick={() => setActionQueueOpen(prev => !prev)}
                        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                    >
                        <h2>
                            Action Queue
                            <svg
                                width="16" height="16" viewBox="0 0 24 24" fill="none"
                                stroke="currentColor" strokeWidth="2"
                                style={{ marginLeft: 8, transform: actionQueueOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
                            >
                                <polyline points="6 9 12 15 18 9" />
                            </svg>
                        </h2>
                        <span className="action-queue-summary">
                            {actionQueueSummary.critical > 0 && <span className="priority-badge priority-badge-critical">{actionQueueSummary.critical} critical</span>}
                            {actionQueueSummary.warnings > 0 && <span className="priority-badge priority-badge-warning">{actionQueueSummary.warnings} warnings</span>}
                            <span className="priority-badge priority-badge-info">{actionQueueSummary.acknowledged} acknowledged</span>
                        </span>
                    </div>
                    {actionQueueOpen && (
                        <div className="action-queue-list">
                            {sortedActions.unacked.map(action => (
                                <div key={action.key} className="action-queue-item">
                                    <span className={`priority-badge ${action.priority <= 3 ? 'priority-badge-critical' : action.priority <= 5 ? 'priority-badge-warning' : 'priority-badge-info'}`}>
                                        {action.priority}
                                    </span>
                                    <span className="action-queue-category">
                                        {action.category === 'battery' ? '🔋' : action.category === 'solar' ? '☀️' : action.category === 'network' ? '📡' : '⚠️'}
                                        {' '}{action.category}
                                    </span>
                                    <div className="action-queue-text">
                                        <span className="action-queue-title">{action.title}</span>
                                        {action.subtitle && <span className="action-queue-subtitle">{action.subtitle}</span>}
                                    </div>
                                    <button
                                        className="action-ack-btn"
                                        onClick={(e) => { e.stopPropagation(); handleAcknowledge(action.key) }}
                                        title="Acknowledge"
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                            <polyline points="20 6 9 17 4 12" />
                                        </svg>
                                    </button>
                                </div>
                            ))}
                            {sortedActions.acked.length > 0 && sortedActions.acked.map(action => (
                                <div key={action.key} className="action-queue-item action-queue-item-acked">
                                    <span className={`priority-badge ${action.priority <= 3 ? 'priority-badge-critical' : action.priority <= 5 ? 'priority-badge-warning' : 'priority-badge-info'}`}>
                                        {action.priority}
                                    </span>
                                    <span className="action-queue-category">
                                        {action.category === 'battery' ? '🔋' : action.category === 'solar' ? '☀️' : action.category === 'network' ? '📡' : '⚠️'}
                                        {' '}{action.category}
                                    </span>
                                    <div className="action-queue-text">
                                        <span className="action-queue-title">{action.title}</span>
                                        {action.subtitle && <span className="action-queue-subtitle">{action.subtitle}</span>}
                                    </div>
                                    <span className="action-ack-done" title="Acknowledged">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                            <polyline points="20 6 9 17 4 12" />
                                        </svg>
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <QueryBar />

            <div className="fleet-controls">
                <div className="search-box">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                        type="text"
                        placeholder={viewMode === 'sites' ? 'Search sites or trailers...' : 'Search trailers...'}
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>

                {/* View Toggle */}
                <div className="view-toggle">
                    <button
                        className={`view-toggle-btn ${viewMode === 'sites' ? 'active' : ''}`}
                        onClick={() => setViewMode('sites')}
                    >
                        Sites
                    </button>
                    <button
                        className={`view-toggle-btn ${viewMode === 'trailers' ? 'active' : ''}`}
                        onClick={() => setViewMode('trailers')}
                    >
                        All Trailers
                    </button>
                </div>

                <div className="control-group">
                    <label>Sort:</label>
                    <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                        <option value="name">Name</option>
                        <option value="soc">SOC &#8593;</option>
                        <option value="soc-desc">SOC &#8595;</option>
                        {viewMode === 'sites' && <option value="trailers">Trailers &#8595;</option>}
                        {viewMode === 'trailers' && <option value="solar">Solar &#8595;</option>}
                        {viewMode === 'trailers' && <option value="signal">Signal &#8593;</option>}
                    </select>
                </div>

                <div className="control-group">
                    <label>Filter:</label>
                    <select value={filterAlarm} onChange={(e) => setFilterAlarm(e.target.value)}>
                        <option value="all">All</option>
                        <option value="alarm">{viewMode === 'sites' ? 'Critical Sites' : 'Low Battery'}</option>
                        <option value="warning">Warning</option>
                        {viewMode === 'trailers' && <option value="offline">VRM Offline</option>}
                        {viewMode === 'trailers' && <option value="net-offline">Network Offline</option>}
                    </select>
                </div>
            </div>

            <div className="site-grid">
                {viewMode === 'sites' ? (
                    <>
                        {filteredJobSites.map(js => (
                            <JobSiteCard key={js.id} jobSite={js} healthGrades={healthGradesMap} />
                        ))}
                        {filteredJobSites.length === 0 && (
                            <div className="no-results">
                                <p>No job sites found. GPS data needed for automatic clustering.</p>
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        {filteredSites.map(site => (
                            <TrailerCard
                                key={site.idSite}
                                site={site}
                                snapshot={snapshotMap[site.idSite]}
                                pepwave={pepwaveMap[site.name]}
                                jobSiteName={trailerJobSiteMap[site.idSite]}
                                healthGrade={healthGradesMap[site.idSite]}
                            />
                        ))}
                        {filteredSites.length === 0 && (
                            <div className="no-results">
                                <p>No trailers match your filters</p>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}

export default FleetOverview
