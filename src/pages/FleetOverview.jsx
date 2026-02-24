import { useState, useCallback, useMemo } from 'react'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchSites, fetchFleetLatest, fetchFleetCombined } from '../api/vrm'
import KpiCard from '../components/KpiCard'
import SiteCard from '../components/SiteCard'
import QueryBar from '../components/QueryBar'

function FleetOverview() {
    const [sortBy, setSortBy] = useState('name')
    const [filterAlarm, setFilterAlarm] = useState('all')
    const [searchTerm, setSearchTerm] = useState('')

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

    // Compute KPIs
    const kpis = useMemo(() => {
        const total = sites.length
        let online = 0
        let alarmCount = 0
        let totalSoc = 0
        let socCount = 0
        let totalYield = 0

        sites.forEach(site => {
            const snap = snapshotMap[site.idSite]
            if (snap) {
                online++
                if (snap.battery_soc !== null && snap.battery_soc < 20) alarmCount++
                if (snap.battery_soc !== null) {
                    totalSoc += snap.battery_soc
                    socCount++
                }
                if (snap.solar_yield_today !== null) {
                    totalYield += snap.solar_yield_today
                }
            }
        })

        // Pepwave KPIs
        const pepValues = Object.values(pepwaveMap)
        const netOnline = pepValues.filter(p => p.online).length
        const netTotal = pepValues.length

        return {
            total,
            online,
            alarmCount,
            avgSoc: socCount > 0 ? (totalSoc / socCount).toFixed(1) : '—',
            totalYield: totalYield.toFixed(1),
            netOnline,
            netTotal,
        }
    }, [sites, snapshotMap, pepwaveMap])

    // Filter and sort
    const filteredSites = useMemo(() => {
        let result = [...sites]

        // Search
        if (searchTerm) {
            const term = searchTerm.toLowerCase()
            result = result.filter(s => s.name.toLowerCase().includes(term))
        }

        // Filter by alarm
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

        // Sort
        result.sort((a, b) => {
            if (sortBy === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true })
            if (sortBy === 'soc') {
                const socA = snapshotMap[a.idSite]?.battery_soc ?? -1
                const socB = snapshotMap[b.idSite]?.battery_soc ?? -1
                return socA - socB
            }
            if (sortBy === 'soc-desc') {
                const socA = snapshotMap[a.idSite]?.battery_soc ?? -1
                const socB = snapshotMap[b.idSite]?.battery_soc ?? -1
                return socB - socA
            }
            if (sortBy === 'solar') {
                const sA = snapshotMap[a.idSite]?.solar_watts ?? -1
                const sB = snapshotMap[b.idSite]?.solar_watts ?? -1
                return sB - sA
            }
            if (sortBy === 'signal') {
                const rsrpA = pepwaveMap[a.name]?.rsrp ?? -999
                const rsrpB = pepwaveMap[b.name]?.rsrp ?? -999
                return rsrpA - rsrpB // weakest first
            }
            return 0
        })

        return result
    }, [sites, snapshotMap, sortBy, filterAlarm, searchTerm, pepwaveMap])

    if (sitesLoading && !sitesData) {
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
                <h1>Fleet Overview</h1>
                <p className="page-subtitle">{sites.length} sites monitored</p>
            </div>

            <div className="kpi-row">
                <KpiCard
                    title="Total Sites"
                    value={kpis.total}
                    color="blue"
                    trend="ok"
                />
                <KpiCard
                    title="Online"
                    value={kpis.online}
                    color="green"
                    trend="up"
                />
                <KpiCard
                    title="Low Battery"
                    value={kpis.alarmCount}
                    color={kpis.alarmCount > 0 ? 'red' : 'teal'}
                    trend={kpis.alarmCount > 0 ? 'warning' : 'ok'}
                />
                <KpiCard
                    title="Avg SOC"
                    value={kpis.avgSoc}
                    unit="%"
                    color="teal"
                    trend="ok"
                />
                <KpiCard
                    title="Total Yield"
                    value={kpis.totalYield}
                    unit="kWh"
                    color="yellow"
                    trend="up"
                />
            </div>

            <QueryBar />

            <div className="fleet-controls">
                <div className="search-box">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                        type="text"
                        placeholder="Search sites..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>

                <div className="control-group">
                    <label>Sort:</label>
                    <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                        <option value="name">Name</option>
                        <option value="soc">SOC ↑</option>
                        <option value="soc-desc">SOC ↓</option>
                        <option value="solar">Solar ↓</option>
                        <option value="signal">Signal ↑</option>
                    </select>
                </div>

                <div className="control-group">
                    <label>Filter:</label>
                    <select value={filterAlarm} onChange={(e) => setFilterAlarm(e.target.value)}>
                        <option value="all">All Sites</option>
                        <option value="alarm">Low Battery</option>
                        <option value="warning">Warning</option>
                        <option value="offline">VRM Offline</option>
                        <option value="net-offline">Network Offline</option>
                    </select>
                </div>
            </div>

            <div className="site-grid">
                {filteredSites.map(site => (
                    <SiteCard
                        key={site.idSite}
                        site={site}
                        snapshot={snapshotMap[site.idSite]}
                        pepwave={pepwaveMap[site.name]}
                    />
                ))}
                {filteredSites.length === 0 && (
                    <div className="no-results">
                        <p>No sites match your filters</p>
                    </div>
                )}
            </div>
        </div>
    )
}

export default FleetOverview
