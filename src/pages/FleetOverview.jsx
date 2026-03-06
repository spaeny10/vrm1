import { useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchSites, fetchFleetLatest, fetchFleetCombined, fetchJobSites, fetchActionQueue, acknowledgeAction, fetchHealthGrades, fetchDeploymentSummary } from '../api/vrm'
import KpiCard from '../components/KpiCard'
import TrailerCard from '../components/TrailerCard'
import JobSiteCard from '../components/JobSiteCard'
import QueryBar from '../components/QueryBar'
import DataFreshness from '../components/DataFreshness'
import { generateCSV, downloadCSV } from '../utils/csv'
import { generateFleetPDF } from '../utils/pdfReport'
import { fetchFleetReportData } from '../api/vrm'
import { useAuth } from '../components/AuthProvider'

function FleetOverview() {
    const navigate = useNavigate()
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const [viewMode, _setViewMode] = useState(() => localStorage.getItem('fleet_view_mode') || 'sites')
    const setViewMode = (v) => { _setViewMode(v); localStorage.setItem('fleet_view_mode', v); }
    const [displayMode, setDisplayMode] = useState('grid') // 'grid' or 'list'
    const [sortBy, setSortBy] = useState('name')
    const [filterAlarm, setFilterAlarm] = useState('all')
    const [searchTerm, setSearchTerm] = useState('')
    const [actionQueueOpen, setActionQueueOpen] = useState(false)
    const [deploymentFilter, setDeploymentFilter] = useState(null) // null | 'billing' | 'standby' | 'hq' | 'pickup'
    const [generatingPdf, setGeneratingPdf] = useState(false)

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

    // Deployment summary data
    const fetchDeploymentFn = useCallback(() => fetchDeploymentSummary(), [])
    const { data: deploymentData } = useApiPolling(fetchDeploymentFn, 30000)

    // Trailer-level data (for "All Trailers" view)
    const fetchSitesFn = useCallback(() => fetchSites(), [])
    const fetchLatestFn = useCallback(() => fetchFleetLatest(), [])
    const fetchCombinedFn = useCallback(() => fetchFleetCombined(), [])

    const { data: sitesData, loading: sitesLoading } = useApiPolling(fetchSitesFn, 60000)
    const { data: latestData } = useApiPolling(fetchLatestFn, 30000)
    const { data: combinedData } = useApiPolling(fetchCombinedFn, 60000)

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
    // Exclude HQ from health KPIs
    const kpis = useMemo(() => {
        if (viewMode === 'sites') {
            const activeSites = jobSites.filter(js => js.status === 'active' && !js.is_headquarters)
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
            jobSiteCount: jobSites.filter(js => !js.is_headquarters).length,
            totalTrailers: total,
            trailersOnline: online,
            atRisk: alarmCount,
            avgSoc: socCount > 0 ? (totalSoc / socCount).toFixed(1) : '--',
            totalYield: totalYield.toFixed(1),
        }
    }, [viewMode, jobSites, sites, snapshotMap])

    // Deployment KPIs from backend
    const deployment = deploymentData || {}

    // Filter + sort job sites
    const filteredJobSites = useMemo(() => {
        let result = [...jobSites]

        // Apply deployment filter (overrides the default completed exclusion)
        if (deploymentFilter === 'billing') {
            result = result.filter(js => js.status === 'active' && !js.is_headquarters)
        } else if (deploymentFilter === 'standby') {
            result = result.filter(js => js.status === 'standby' && !js.is_headquarters)
        } else if (deploymentFilter === 'hq') {
            result = result.filter(js => js.is_headquarters)
        } else if (deploymentFilter === 'pickup') {
            result = result.filter(js => js.status === 'completed')
        } else {
            // Default: exclude completed
            result = result.filter(js => js.status !== 'completed')
        }

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
    }, [jobSites, sortBy, filterAlarm, searchTerm, deploymentFilter])

    const handleDeploymentFilter = (filter) => {
        setDeploymentFilter(prev => prev === filter ? null : filter)
        setViewMode('sites')
    }

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

    const handleFleetReport = async () => {
        setGeneratingPdf(true)
        try {
            const data = await fetchFleetReportData()
            if (data?.report) generateFleetPDF(data.report)
        } catch (err) {
            console.error('PDF generation error:', err)
        }
        setGeneratingPdf(false)
    }

    if (isLoading) {
        return (
            <div className="fleet-overview">
                <div className="page-header">
                    <div className="skeleton skeleton-text" style={{ width: 200, height: 28 }}></div>
                    <div className="skeleton skeleton-text" style={{ width: 300, height: 16, marginTop: 8 }}></div>
                </div>
                <div className="kpi-row">
                    {[1,2,3,4,5].map(i => (
                        <div key={i} className="kpi-card skeleton-card">
                            <div className="skeleton skeleton-text" style={{ width: '60%', height: 14 }}></div>
                            <div className="skeleton skeleton-text" style={{ width: '40%', height: 28, marginTop: 8 }}></div>
                        </div>
                    ))}
                </div>
                <div className="site-grid">
                    {[1,2,3,4,5,6].map(i => (
                        <div key={i} className="skeleton-card" style={{ height: 160, borderRadius: 'var(--radius)' }}>
                            <div className="skeleton" style={{ width: '100%', height: '100%', borderRadius: 'var(--radius)' }}></div>
                        </div>
                    ))}
                </div>
            </div>
        )
    }

    return (
        <div className="fleet-overview">
            <div className="page-header">
                <div className="page-header-row">
                    <h1>Fleet Overview</h1>
                    <div className="page-header-actions">
                        <button className="btn btn-sm btn-secondary" onClick={handleFleetReport} disabled={generatingPdf} title="Generate Fleet PDF Report">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                                <line x1="16" y1="13" x2="8" y2="13" />
                                <line x1="16" y1="17" x2="8" y2="17" />
                            </svg>
                            {generatingPdf ? 'Generating...' : 'Fleet Report'}
                        </button>
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

            <QueryBar />

            <div className="kpi-row">
                <KpiCard title="Job Sites" value={kpis.jobSiteCount} color="blue" />
                <KpiCard title="Trailers Online" value={`${kpis.trailersOnline}/${kpis.totalTrailers}`} color="green" />
                <KpiCard title="Sites at Risk" value={kpis.atRisk} color={kpis.atRisk > 0 ? 'red' : 'teal'} />
                <KpiCard title="Fleet Avg SOC" value={kpis.avgSoc} unit="%" color="teal" />
                <KpiCard title="Total Yield" value={kpis.totalYield} unit="kWh" color="yellow" />
            </div>

            {/* Deployment KPIs */}
            {deployment.active_billing && (
                <div className="deployment-kpi-section">
                    <div className="deployment-kpi-header">
                        <h3 className="deployment-kpi-label">Deployment Status</h3>
                        {deploymentFilter && (
                            <button className="btn btn-sm btn-ghost" onClick={() => setDeploymentFilter(null)}>
                                Clear filter
                            </button>
                        )}
                    </div>
                    <div className="kpi-row">
                        <KpiCard
                            title="Actively Billing"
                            value={`${deployment.active_billing.sites} sites`}
                            unit={`${deployment.active_billing.trailers} trailers`}
                            color="green"
                            onClick={() => handleDeploymentFilter('billing')}
                            active={deploymentFilter === 'billing'}
                        />
                        <KpiCard
                            title="Standby"
                            value={`${deployment.standby?.sites || 0} sites`}
                            unit={`${deployment.standby?.trailers || 0} trailers`}
                            color="yellow"
                            onClick={() => handleDeploymentFilter('standby')}
                            active={deploymentFilter === 'standby'}
                        />
                        <KpiCard
                            title="Available at HQ"
                            value={deployment.available_at_hq?.trailers || 0}
                            unit="trailers"
                            color="blue"
                            onClick={() => handleDeploymentFilter('hq')}
                            active={deploymentFilter === 'hq'}
                        />
                        <KpiCard
                            title="Awaiting Pickup"
                            value={`${deployment.awaiting_pickup?.sites || 0} sites`}
                            unit={`${deployment.awaiting_pickup?.trailers || 0} trailers`}
                            color="red"
                            onClick={() => handleDeploymentFilter('pickup')}
                            active={deploymentFilter === 'pickup'}
                        />
                    </div>
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
                                    {canEdit && (
                                        <button
                                            className="action-ack-btn"
                                            onClick={(e) => { e.stopPropagation(); handleAcknowledge(action.key) }}
                                            title="Acknowledge"
                                        >
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                <polyline points="20 6 9 17 4 12" />
                                            </svg>
                                        </button>
                                    )}
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

                {/* Display Mode Toggle (Grid / List) */}
                <div className="view-toggle">
                    <button
                        className={`view-toggle-btn ${displayMode === 'grid' ? 'active' : ''}`}
                        onClick={() => setDisplayMode('grid')}
                        title="Grid view"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                            <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
                        </svg>
                    </button>
                    <button
                        className={`view-toggle-btn ${displayMode === 'list' ? 'active' : ''}`}
                        onClick={() => setDisplayMode('list')}
                        title="List view"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" />
                            <line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" />
                            <line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                        </svg>
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

            {displayMode === 'list' ? (
                <div className="fleet-list">
                    <table className="fleet-table">
                        <thead>
                            <tr>
                                <th onClick={() => setSortBy('name')} className={sortBy === 'name' ? 'sorted' : ''}>Trailer</th>
                                <th>Job Site</th>
                                <th onClick={() => setSortBy(sortBy === 'soc-desc' ? 'soc' : 'soc-desc')} className={sortBy.startsWith('soc') ? 'sorted' : ''}>SOC</th>
                                <th>Voltage</th>
                                <th onClick={() => setSortBy('solar')} className={sortBy === 'solar' ? 'sorted' : ''}>Solar</th>
                                <th>Yield</th>
                                <th>Charge</th>
                                <th>Network</th>
                                <th onClick={() => setSortBy('signal')} className={sortBy === 'signal' ? 'sorted' : ''}>Signal</th>
                                <th>Grade</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(viewMode === 'sites'
                                ? filteredJobSites.flatMap(js => (js.trailers || []).map(t => {
                                    const site = sites.find(s => s.idSite === t.site_id) || { idSite: t.site_id, name: t.site_name }
                                    return { site, jobSiteName: js.name }
                                }))
                                : filteredSites.map(site => ({ site, jobSiteName: trailerJobSiteMap[site.idSite] }))
                            ).map(({ site, jobSiteName }) => {
                                const snap = snapshotMap[site.idSite]
                                const pw = pepwaveMap[site.name]
                                const grade = healthGradesMap[site.idSite]
                                const soc = snap?.battery_soc
                                const hasVrm = snap && (snap.battery_voltage != null || snap.solar_watts != null || (snap.battery_soc != null && snap.battery_soc > 0))
                                return (
                                    <tr key={site.idSite} onClick={() => navigate(`/trailer/${site.idSite}`)} className="fleet-table-row">
                                        <td className="fleet-table-name">{site.name}</td>
                                        <td className="fleet-table-muted">{jobSiteName || '—'}</td>
                                        <td>
                                            {soc != null ? (
                                                <span className={`fleet-table-soc ${soc < 20 ? 'soc-critical' : soc < 50 ? 'soc-warning' : 'soc-good'}`}>
                                                    {soc.toFixed(0)}%
                                                </span>
                                            ) : <span className="fleet-table-muted">—</span>}
                                        </td>
                                        <td>{snap?.battery_voltage != null ? `${Number(snap.battery_voltage).toFixed(1)}V` : '—'}</td>
                                        <td>{snap?.solar_watts != null ? `${Math.round(snap.solar_watts)}W` : '—'}</td>
                                        <td>{snap?.solar_yield_today != null ? `${Number(snap.solar_yield_today).toFixed(2)}` : '—'}</td>
                                        <td className="fleet-table-muted">{snap?.charge_state || '—'}</td>
                                        <td>
                                            {pw ? (
                                                <span className={`fleet-table-net ${pw.online ? 'net-online' : 'net-offline'}`}>
                                                    {pw.online ? 'Online' : 'Offline'}
                                                </span>
                                            ) : hasVrm ? <span className="fleet-table-muted">—</span> : <span className="fleet-table-net net-online">Conn. Only</span>}
                                        </td>
                                        <td>
                                            {pw?.rsrp ? (
                                                <span className={pw.rsrp >= -90 ? 'netrow-good' : pw.rsrp >= -100 ? 'netrow-fair' : 'netrow-poor'}>
                                                    {pw.rsrp} dBm
                                                </span>
                                            ) : '—'}
                                        </td>
                                        <td>
                                            {grade ? (
                                                <span className="health-grade-badge" style={{ backgroundColor: grade.color }}>
                                                    {grade.grade}
                                                </span>
                                            ) : '—'}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                    {((viewMode === 'sites' && filteredJobSites.length === 0) || (viewMode === 'trailers' && filteredSites.length === 0)) && (
                        <div className="no-results"><p>No results match your filters</p></div>
                    )}
                </div>
            ) : (
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
            )}
        </div>
    )
}

export default FleetOverview
