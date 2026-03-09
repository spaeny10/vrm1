import { useState, useCallback, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchSites, fetchFleetLatest, fetchFleetCombined, fetchJobSites, fetchActionQueue, acknowledgeAction, fetchHealthGrades, fetchTechStatus, fetchDeploymentSummary, createJobSite, fetchCompanies } from '../api/vrm'
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
    const [displayMode, setDisplayMode] = useState('list') // 'grid' or 'list'
    const [sortBy, setSortBy] = useState('name')
    const [filterAlarm, setFilterAlarm] = useState('all')
    const [searchTerm, setSearchTerm] = useState('')
    const [actionQueueOpen, setActionQueueOpen] = useState(false)
    const [deploymentFilter, setDeploymentFilter] = useState(null) // null | 'billing' | 'standby' | 'hq' | 'pickup'
    const [showDeployedOnly, setShowDeployedOnly] = useState(true)
    const [techStatusFilter, setTechStatusFilter] = useState(null) // null | 'good' | 'watch' | 'attention'
    const [generatingPdf, setGeneratingPdf] = useState(false)
    const [showAddSiteModal, setShowAddSiteModal] = useState(false)
    const [newSite, setNewSite] = useState({ name: '', address: '', company_id: '' })
    const [addingSite, setAddingSite] = useState(false)
    const [companiesList, setCompaniesList] = useState([])

    // Load companies when Add Site modal opens
    useEffect(() => {
        if (showAddSiteModal) {
            fetchCompanies().then(d => setCompaniesList(d?.companies || [])).catch(() => { })
        }
    }, [showAddSiteModal])

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

    // Tech status data
    const fetchTechStatusFn = useCallback(() => fetchTechStatus(), [])
    const { data: techStatusData } = useApiPolling(fetchTechStatusFn, 60000)
    const techStatusMap = techStatusData?.statuses || {}
    const techStatusSummary = techStatusData?.summary || { good: 0, watch: 0, attention: 0 }

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

    // Build set of HQ trailer IDs
    const hqTrailerIds = useMemo(() => {
        const set = new Set()
        for (const js of jobSites) {
            if (js.is_headquarters) {
                for (const t of (js.trailers || [])) set.add(t.site_id)
            }
        }
        return set
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
            } else if (site.ic2_only) {
                // IC2-only device — count as online if Pepwave is online
                const pw = pepwaveMap[site.name]
                if (pw?.online) online++
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

        // Tech status filter — show job sites that have at least one trailer matching
        if (techStatusFilter) {
            result = result.filter(js =>
                (js.trailers || []).some(t => techStatusMap[t.site_id]?.status === techStatusFilter)
            )
        }

        result.sort((a, b) => {
            if (sortBy === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true })
            if (sortBy === 'soc') return (a.avg_soc ?? -1) - (b.avg_soc ?? -1)
            if (sortBy === 'soc-desc') return (b.avg_soc ?? -1) - (a.avg_soc ?? -1)
            if (sortBy === 'trailers') return b.trailer_count - a.trailer_count
            return 0
        })

        return result
    }, [jobSites, sortBy, filterAlarm, searchTerm, deploymentFilter, techStatusFilter, techStatusMap])

    const handleDeploymentFilter = (filter) => {
        setDeploymentFilter(prev => prev === filter ? null : filter)
        setViewMode('sites')
    }

    const handleTechStatusFilter = (status) => {
        setTechStatusFilter(prev => prev === status ? null : status)
        if (viewMode === 'sites') setViewMode('trailers')
    }

    // Filter + sort trailers (existing logic)
    const filteredSites = useMemo(() => {
        let result = [...sites]

        // Hide HQ trailers by default
        if (showDeployedOnly) {
            result = result.filter(s => !hqTrailerIds.has(s.idSite))
        }

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

        // Tech status filter
        if (techStatusFilter) {
            result = result.filter(s => {
                const ts = techStatusMap[s.idSite]
                return ts?.status === techStatusFilter
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
    }, [sites, snapshotMap, sortBy, filterAlarm, searchTerm, pepwaveMap, techStatusFilter, techStatusMap, showDeployedOnly, hqTrailerIds])

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

    const handleAtRiskClick = () => {
        if (viewMode === 'sites') {
            // Navigate to first critical job site
            const criticalSite = jobSites.find(js => js.worst_status === 'critical')
            if (criticalSite) navigate(`/site/${criticalSite.id}`)
        } else {
            // Navigate to first at-risk trailer (SOC < 20%)
            const atRiskTrailer = sites.find(site => {
                const snap = snapshotMap[site.idSite]
                return snap && snap.battery_soc !== null && snap.battery_soc < 20
            })
            if (atRiskTrailer) navigate(`/trailer/${atRiskTrailer.idSite}`)
        }
    }

    if (isLoading) {
        return (
            <div className="fleet-overview">
                <div className="page-header">
                    <div className="skeleton skeleton-text" style={{ width: 200, height: 28 }}></div>
                    <div className="skeleton skeleton-text" style={{ width: 300, height: 16, marginTop: 8 }}></div>
                </div>
                <div className="kpi-row">
                    {[1, 2, 3, 4, 5].map(i => (
                        <div key={i} className="kpi-card skeleton-card">
                            <div className="skeleton skeleton-text" style={{ width: '60%', height: 14 }}></div>
                            <div className="skeleton skeleton-text" style={{ width: '40%', height: 28, marginTop: 8 }}></div>
                        </div>
                    ))}
                </div>
                <div className="site-grid">
                    {[1, 2, 3, 4, 5, 6].map(i => (
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
                        {canEdit && (
                            <button className="btn btn-sm btn-primary" onClick={() => setShowAddSiteModal(true)} title="Add new job site">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                Add Site
                            </button>
                        )}
                    </div>
                </div>
                <p className="page-subtitle">
                    {kpis.jobSiteCount} job sites, {kpis.totalTrailers} trailers monitored
                </p>
            </div>

            <QueryBar />

            <div className="fleet-stat-bar">
                <span className="fleet-stat"><strong>{kpis.jobSiteCount}</strong> sites</span>
                <span className="fleet-stat-sep" />
                <span className="fleet-stat"><strong>{kpis.trailersOnline}</strong>/{kpis.totalTrailers} online</span>
                <span className="fleet-stat-sep" />
                <span className="fleet-stat"><strong>{kpis.avgSoc}%</strong> avg SOC</span>
                <span className="fleet-stat-sep" />
                <span className="fleet-stat"><strong>{kpis.totalYield}</strong> kWh yield</span>
                {kpis.atRisk > 0 && (
                    <>
                        <span className="fleet-stat-sep" />
                        <span
                            className="fleet-stat fleet-stat-risk fleet-stat-clickable"
                            onClick={handleAtRiskClick}
                            style={{ cursor: 'pointer' }}
                            title="Click to view at-risk trailer"
                        >
                            <strong>{kpis.atRisk}</strong> at risk
                        </span>
                    </>
                )}
            </div>

            {/* Deployment Status */}
            {deployment.active_billing && (
                <div className="deploy-stat-bar">
                    <span className="deploy-stat-label">Deployment</span>
                    {deploymentFilter && (
                        <button className="btn btn-xs btn-ghost" onClick={() => setDeploymentFilter(null)}>clear</button>
                    )}
                    <span className="deploy-stat-sep" />
                    <span
                        className={`deploy-stat deploy-stat-clickable ${deploymentFilter === 'billing' ? 'deploy-stat-active' : ''}`}
                        onClick={() => handleDeploymentFilter('billing')}
                    >
                        <span className="deploy-dot deploy-dot-green" />
                        {deployment.active_billing.trailers} trailers on {deployment.active_billing.sites} sites
                    </span>
                    <span
                        className={`deploy-stat deploy-stat-clickable ${deploymentFilter === 'standby' ? 'deploy-stat-active' : ''}`}
                        onClick={() => handleDeploymentFilter('standby')}
                    >
                        <span className="deploy-dot deploy-dot-yellow" />
                        {deployment.standby?.trailers || 0} standby
                    </span>
                    <span
                        className={`deploy-stat deploy-stat-clickable ${deploymentFilter === 'hq' ? 'deploy-stat-active' : ''}`}
                        onClick={() => handleDeploymentFilter('hq')}
                    >
                        <span className="deploy-dot deploy-dot-blue" />
                        {deployment.available_at_hq?.trailers || 0} at HQ
                    </span>
                    {(deployment.awaiting_pickup?.sites || 0) > 0 && (
                        <span
                            className={`deploy-stat deploy-stat-clickable ${deploymentFilter === 'pickup' ? 'deploy-stat-active' : ''}`}
                            onClick={() => handleDeploymentFilter('pickup')}
                        >
                            <span className="deploy-dot deploy-dot-red" />
                            {deployment.awaiting_pickup.sites} pickup
                        </span>
                    )}
                </div>
            )}

            {/* Tech Status Summary */}
            <div className="tech-status-section">
                <div className="tech-status-header">
                    <h3>Tech Status</h3>
                    {techStatusFilter && (
                        <button className="btn btn-sm btn-ghost" onClick={() => setTechStatusFilter(null)}>
                            Clear filter
                        </button>
                    )}
                </div>
                <div className="tech-status-cards">
                    <div
                        className={`tech-status-card tech-status-attention ${techStatusFilter === 'attention' ? 'tech-status-active' : ''}`}
                        onClick={() => handleTechStatusFilter('attention')}
                    >
                        <span className="tech-status-count">{techStatusSummary.attention}</span>
                        <span className="tech-status-label">Need Attention</span>
                    </div>
                    <div
                        className={`tech-status-card tech-status-watch ${techStatusFilter === 'watch' ? 'tech-status-active' : ''}`}
                        onClick={() => handleTechStatusFilter('watch')}
                    >
                        <span className="tech-status-count">{techStatusSummary.watch}</span>
                        <span className="tech-status-label">Watch</span>
                    </div>
                    <div
                        className={`tech-status-card tech-status-good ${techStatusFilter === 'good' ? 'tech-status-active' : ''}`}
                        onClick={() => handleTechStatusFilter('good')}
                    >
                        <span className="tech-status-count">{techStatusSummary.good}</span>
                        <span className="tech-status-label">Good</span>
                    </div>
                </div>
            </div>

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
                                        {action.subtitle && (
                                            <span className="action-queue-subtitle">
                                                {action.subtitle}
                                                {action.details?.hasThrottledDays && (
                                                    <span className="action-throttle-note"> (includes throttled days)</span>
                                                )}
                                            </span>
                                        )}
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
                                        {action.subtitle && (
                                            <span className="action-queue-subtitle">
                                                {action.subtitle}
                                                {action.details?.hasThrottledDays && (
                                                    <span className="action-throttle-note"> (includes throttled days)</span>
                                                )}
                                            </span>
                                        )}
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

                {viewMode === 'trailers' && (
                    <label className="deployed-toggle">
                        <input
                            type="checkbox"
                            checked={showDeployedOnly}
                            onChange={(e) => setShowDeployedOnly(e.target.checked)}
                        />
                        Deployed only
                    </label>
                )}
            </div>

            {displayMode === 'list' ? (
                <div className="fleet-list">
                    <table className="fleet-table">
                        <thead>
                            <tr>
                                <th>Status</th>
                                <th onClick={() => setSortBy('name')} className={sortBy === 'name' ? 'sorted' : ''}>Trailer</th>
                                <th>Job Site</th>
                                <th onClick={() => setSortBy(sortBy === 'soc-desc' ? 'soc' : 'soc-desc')} className={sortBy.startsWith('soc') ? 'sorted' : ''}>SOC</th>
                                <th onClick={() => setSortBy('solar')} className={sortBy === 'solar' ? 'sorted' : ''}>Solar</th>
                                <th>Load</th>
                                <th onClick={() => setSortBy('signal')} className={sortBy === 'signal' ? 'sorted' : ''}>Network</th>
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
                                const ts = techStatusMap[site.idSite]
                                const soc = snap?.battery_soc
                                return (
                                    <tr key={site.idSite} onClick={() => navigate(`/trailer/${site.idSite}`)} className="fleet-table-row">
                                        <td>
                                            {ts ? (
                                                <span className="tech-status-dot" style={{ background: { good: '#27ae60', watch: '#f39c12', attention: '#e74c3c' }[ts.status] }}
                                                    title={`${{ good: 'Good', watch: 'Watch', attention: 'Needs Attention' }[ts.status]}${ts.reason ? ': ' + ts.reason : ''}`} />
                                            ) : '—'}
                                        </td>
                                        <td className="fleet-table-name">{site.name}</td>
                                        <td className="fleet-table-muted">{jobSiteName || '—'}</td>
                                        <td>
                                            {soc != null ? (
                                                <span className={`fleet-table-soc ${soc < 20 ? 'soc-critical' : soc < 50 ? 'soc-warning' : 'soc-good'}`}>
                                                    {soc.toFixed(0)}%
                                                </span>
                                            ) : <span className="fleet-table-muted">—</span>}
                                        </td>
                                        <td>{snap?.solar_watts != null ? `${Math.round(snap.solar_watts)}W` : '—'}</td>
                                        <td>{snap?.dc_load_watts != null ? `${Math.round(snap.dc_load_watts)}W` : '—'}</td>
                                        <td>
                                            {pw ? (
                                                <span className={`fleet-table-net ${pw.online ? 'net-online' : 'net-offline'}`}
                                                    title={pw.rsrp ? `${pw.rsrp} dBm · ${pw.carrier || ''}` : ''}>
                                                    {pw.online ? (pw.rsrp ? `${pw.rsrp} dBm` : 'Online') : 'Offline'}
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
                                    techStatus={techStatusMap[site.idSite]}
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

            {/* Add Site Modal */}
            {showAddSiteModal && (
                <div className="modal-overlay" onClick={() => setShowAddSiteModal(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
                        <div className="modal-header">
                            <h2>Add New Site</h2>
                            <button className="modal-close" onClick={() => setShowAddSiteModal(false)}>&times;</button>
                        </div>
                        <form onSubmit={async (e) => {
                            e.preventDefault()
                            if (!newSite.name.trim()) return
                            setAddingSite(true)
                            try {
                                const payload = { ...newSite }
                                if (payload.company_id) payload.company_id = parseInt(payload.company_id)
                                else delete payload.company_id
                                await createJobSite(payload)
                                setShowAddSiteModal(false)
                                setNewSite({ name: '', address: '', company_id: '' })
                                refetch()
                            } catch (err) {
                                console.error('Failed to create site:', err)
                            } finally {
                                setAddingSite(false)
                            }
                        }} style={{ padding: '20px' }}>
                            <div style={{ display: 'grid', gap: '14px' }}>
                                <div>
                                    <label className="form-label">Site Name *</label>
                                    <input className="input" required value={newSite.name} onChange={e => setNewSite(s => ({ ...s, name: e.target.value }))} placeholder="e.g. Downtown Construction" />
                                </div>
                                <div>
                                    <label className="form-label">Address</label>
                                    <input className="input" value={newSite.address} onChange={e => setNewSite(s => ({ ...s, address: e.target.value }))} placeholder="123 Main St, Kansas City, KS" />
                                </div>
                                <div>
                                    <label className="form-label">Company</label>
                                    <select className="input" value={newSite.company_id} onChange={e => setNewSite(s => ({ ...s, company_id: e.target.value }))}>
                                        <option value="">— No company —</option>
                                        {companiesList.map(c => (
                                            <option key={c.id} value={c.id}>{c.name}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-secondary" onClick={() => setShowAddSiteModal(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary" disabled={!newSite.name.trim() || addingSite}>
                                    {addingSite ? 'Creating...' : 'Create Site'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    )
}

export default FleetOverview
