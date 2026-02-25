import { useState, useCallback, useMemo } from 'react'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchFleetNetwork, fetchJobSites } from '../api/vrm'

function SignalBars({ bars, size = 20 }) {
    const maxBars = 5
    const barWidth = Math.floor(size / 7)
    const gap = 1
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            {Array.from({ length: maxBars }, (_, i) => {
                const h = ((i + 1) / maxBars) * (size - 2) + 2
                const x = i * (barWidth + gap)
                const y = size - h
                const active = i < (bars ?? 0)
                return (
                    <rect
                        key={i}
                        x={x}
                        y={y}
                        width={barWidth}
                        height={h}
                        rx={1}
                        fill={active
                            ? (bars >= 4 ? '#2ecc71' : bars >= 2 ? '#f1c40f' : '#e74c3c')
                            : 'rgba(255,255,255,0.08)'}
                    />
                )
            })}
        </svg>
    )
}

function signalQuality(rsrp) {
    if (rsrp === null || rsrp === undefined) return { label: 'Unknown', color: '#888' }
    if (rsrp >= -80) return { label: 'Excellent', color: '#2ecc71' }
    if (rsrp >= -90) return { label: 'Good', color: '#27ae60' }
    if (rsrp >= -100) return { label: 'Fair', color: '#f1c40f' }
    if (rsrp >= -110) return { label: 'Poor', color: '#e67e22' }
    return { label: 'Weak', color: '#e74c3c' }
}

function formatUptime(seconds) {
    if (!seconds) return '—'
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    if (d > 0) return `${d}d ${h}h`
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h ${m}m`
}

function formatMB(mb) {
    if (!mb && mb !== 0) return '—'
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
    return `${Math.round(mb)} MB`
}

function NetworkPage() {
    const [searchTerm, setSearchTerm] = useState('')
    const [statusFilter, setStatusFilter] = useState('all')
    const [selectedDevice, setSelectedDevice] = useState(null)
    const [collapsedSites, setCollapsedSites] = useState(new Set())

    const fetchNetwork = useCallback(() => fetchFleetNetwork(), [])
    const fetchJobSitesFn = useCallback(() => fetchJobSites(), [])
    const { data, loading } = useApiPolling(fetchNetwork, 60000)
    const { data: jobSitesData } = useApiPolling(fetchJobSitesFn, 60000)

    const devices = data?.records || []
    const jobSites = jobSitesData?.job_sites || []

    // Build device-name-to-job-site mapping from job sites trailer data
    const deviceToJobSite = useMemo(() => {
        const map = {}
        for (const js of jobSites) {
            for (const t of (js.trailers || [])) {
                map[t.site_name] = { jobSiteId: js.id, jobSiteName: js.name }
            }
        }
        return map
    }, [jobSites])

    // KPIs
    const kpis = useMemo(() => {
        let online = 0, offline = 0, totalSignal = 0, signalCount = 0
        let totalUsage = 0, weakestRsrp = 0, weakestName = '—'
        let sitesAllOnline = 0, sitesWithOffline = 0

        devices.forEach(d => {
            if (d.online) online++
            else offline++
            totalUsage += d.usage_mb || 0

            const rsrp = d.cellular?.signal?.rsrp
            if (rsrp !== null && rsrp !== undefined) {
                totalSignal += rsrp
                signalCount++
                if (rsrp < weakestRsrp || weakestRsrp === 0) {
                    weakestRsrp = rsrp
                    weakestName = d.name
                }
            }
        })

        // Compute site-level online stats
        const siteDeviceStatus = new Map()
        devices.forEach(d => {
            const js = deviceToJobSite[d.name]
            if (js) {
                if (!siteDeviceStatus.has(js.jobSiteId)) {
                    siteDeviceStatus.set(js.jobSiteId, { total: 0, online: 0 })
                }
                const s = siteDeviceStatus.get(js.jobSiteId)
                s.total++
                if (d.online) s.online++
            }
        })
        for (const [, s] of siteDeviceStatus) {
            if (s.online === s.total) sitesAllOnline++
            else sitesWithOffline++
        }

        return {
            online, offline, total: devices.length,
            avgRsrp: signalCount > 0 ? Math.round(totalSignal / signalCount) : null,
            totalUsage,
            weakestRsrp: weakestRsrp || null,
            weakestName,
            sitesAllOnline,
            sitesWithOffline,
        }
    }, [devices, deviceToJobSite])

    // Filter and search
    const filtered = useMemo(() => {
        let result = [...devices]
        if (searchTerm) {
            const term = searchTerm.toLowerCase()
            result = result.filter(d =>
                d.name.toLowerCase().includes(term) ||
                (d.cellular?.carrier || '').toLowerCase().includes(term) ||
                (deviceToJobSite[d.name]?.jobSiteName || '').toLowerCase().includes(term)
            )
        }
        if (statusFilter === 'online') result = result.filter(d => d.online)
        else if (statusFilter === 'offline') result = result.filter(d => !d.online)
        else if (statusFilter === 'weak') {
            result = result.filter(d => {
                const rsrp = d.cellular?.signal?.rsrp
                return rsrp !== null && rsrp !== undefined && rsrp < -100
            })
        }
        return result
    }, [devices, searchTerm, statusFilter, deviceToJobSite])

    // Group filtered devices by job site
    const groupedDevices = useMemo(() => {
        const groups = new Map()
        const ungrouped = []

        for (const d of filtered) {
            const js = deviceToJobSite[d.name]
            if (js) {
                if (!groups.has(js.jobSiteId)) {
                    groups.set(js.jobSiteId, {
                        jobSiteId: js.jobSiteId,
                        jobSiteName: js.jobSiteName,
                        devices: [],
                        online: 0,
                        total: 0,
                    })
                }
                const g = groups.get(js.jobSiteId)
                g.devices.push(d)
                g.total++
                if (d.online) g.online++
            } else {
                ungrouped.push(d)
            }
        }

        const sorted = [...groups.values()].sort((a, b) =>
            a.jobSiteName.localeCompare(b.jobSiteName, undefined, { numeric: true })
        )

        return { groups: sorted, ungrouped }
    }, [filtered, deviceToJobSite])

    const toggleCollapse = (jobSiteId) => {
        setCollapsedSites(prev => {
            const next = new Set(prev)
            if (next.has(jobSiteId)) next.delete(jobSiteId)
            else next.add(jobSiteId)
            return next
        })
    }

    const renderDeviceCard = (device) => {
        const rsrp = device.cellular?.signal?.rsrp
        const quality = signalQuality(rsrp)

        return (
            <div
                key={device.id}
                className={`network-card ${device.online ? 'network-card-online' : 'network-card-offline'} ${selectedDevice?.id === device.id ? 'network-card-selected' : ''}`}
                onClick={() => setSelectedDevice(selectedDevice?.id === device.id ? null : device)}
            >
                <div className="network-card-header">
                    <h3 className="network-card-name">{device.name}</h3>
                    <span className={`network-status-badge network-status-${device.online ? 'online' : 'offline'}`}>
                        {device.online ? 'Online' : 'Offline'}
                    </span>
                </div>

                <div className="network-card-signal">
                    <SignalBars bars={device.cellular?.signal_bar} size={28} />
                    <div className="signal-info">
                        <span className="signal-carrier">
                            {device.cellular?.carrier || '—'}
                        </span>
                        <span className="signal-tech">
                            {device.cellular?.technology || ''}
                        </span>
                    </div>
                    <span className="signal-quality" style={{ color: quality.color }}>
                        {rsrp != null ? `${rsrp} dBm` : '—'}
                    </span>
                </div>

                <div className="network-card-stats">
                    <div className="net-stat">
                        <span className="net-stat-label">Clients</span>
                        <span className="net-stat-value">{device.client_count}</span>
                    </div>
                    <div className="net-stat">
                        <span className="net-stat-label">Data</span>
                        <span className="net-stat-value">{formatMB(device.usage_mb)}</span>
                    </div>
                    <div className="net-stat">
                        <span className="net-stat-label">Uptime</span>
                        <span className="net-stat-value">{formatUptime(device.uptime)}</span>
                    </div>
                </div>

                <div className="network-card-footer">
                    <span className="net-model">{device.model}</span>
                    <span className="net-fw">{device.firmware}</span>
                </div>
            </div>
        )
    }

    if (loading && !data) {
        return (
            <div className="page-loading">
                <div className="spinner"></div>
                <p>Loading network data...</p>
            </div>
        )
    }

    return (
        <div className="network-page">
            <div className="page-header">
                <h1>Network</h1>
                <p className="page-subtitle">
                    Pepwave InControl2 &bull; {devices.length} devices across {groupedDevices.groups.length} sites
                </p>
            </div>

            {/* KPI Row */}
            <div className="kpi-row">
                <div className="kpi-card kpi-blue">
                    <div className="kpi-label">Total Devices</div>
                    <div className="kpi-value">{kpis.total}</div>
                </div>
                <div className="kpi-card kpi-green">
                    <div className="kpi-label">Online</div>
                    <div className="kpi-value">{kpis.online}</div>
                </div>
                <div className="kpi-card kpi-red">
                    <div className="kpi-label">Offline</div>
                    <div className="kpi-value">{kpis.offline}</div>
                </div>
                <div className="kpi-card kpi-teal">
                    <div className="kpi-label">Sites All Online</div>
                    <div className="kpi-value">{kpis.sitesAllOnline}</div>
                </div>
                <div className="kpi-card kpi-yellow">
                    <div className="kpi-label">Total Data</div>
                    <div className="kpi-value">{formatMB(kpis.totalUsage)}</div>
                </div>
            </div>

            {/* Controls */}
            <div className="fleet-controls">
                <div className="search-box">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                        type="text"
                        placeholder="Search devices or sites..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
                <div className="control-group">
                    <label>Filter:</label>
                    <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                        <option value="all">All Devices</option>
                        <option value="online">Online</option>
                        <option value="offline">Offline</option>
                        <option value="weak">Weak Signal</option>
                    </select>
                </div>
            </div>

            {/* Device Grid — grouped by job site */}
            <div className="network-grouped">
                {groupedDevices.groups.map(group => {
                    const isCollapsed = collapsedSites.has(group.jobSiteId)
                    const allOnline = group.online === group.total

                    return (
                        <div key={group.jobSiteId} className="network-site-group">
                            <div
                                className={`network-site-header ${allOnline ? 'site-all-online' : 'site-has-offline'}`}
                                onClick={() => toggleCollapse(group.jobSiteId)}
                            >
                                <div className="network-site-header-left">
                                    <span className="expand-icon">{isCollapsed ? '▸' : '▾'}</span>
                                    <h3>{group.jobSiteName}</h3>
                                    <span className="network-site-count">
                                        {group.total} device{group.total !== 1 ? 's' : ''}
                                    </span>
                                </div>
                                <div className="network-site-header-right">
                                    <span className={`network-site-status ${allOnline ? 'all-online' : 'has-offline'}`}>
                                        {group.online}/{group.total} online
                                    </span>
                                </div>
                            </div>
                            {!isCollapsed && (
                                <div className="network-grid">
                                    {group.devices.map(renderDeviceCard)}
                                </div>
                            )}
                        </div>
                    )
                })}

                {/* Ungrouped devices */}
                {groupedDevices.ungrouped.length > 0 && (
                    <div className="network-site-group">
                        <div className="network-site-header site-unassigned">
                            <div className="network-site-header-left">
                                <h3>Unassigned Devices</h3>
                                <span className="network-site-count">
                                    {groupedDevices.ungrouped.length} device{groupedDevices.ungrouped.length !== 1 ? 's' : ''}
                                </span>
                            </div>
                        </div>
                        <div className="network-grid">
                            {groupedDevices.ungrouped.map(renderDeviceCard)}
                        </div>
                    </div>
                )}

                {filtered.length === 0 && (
                    <div className="no-results">
                        <p>No devices match your filters</p>
                    </div>
                )}
            </div>

            {/* Detail Panel */}
            {selectedDevice && (
                <div className="network-detail-overlay" onClick={() => setSelectedDevice(null)}>
                    <div className="network-detail-panel" onClick={(e) => e.stopPropagation()}>
                        <div className="detail-header">
                            <h2>{selectedDevice.name}</h2>
                            <button className="detail-close" onClick={() => setSelectedDevice(null)}>✕</button>
                        </div>

                        {deviceToJobSite[selectedDevice.name] && (
                            <div className="detail-site-tag">
                                Site: {deviceToJobSite[selectedDevice.name].jobSiteName}
                            </div>
                        )}

                        <div className="detail-section">
                            <h4>Device Info</h4>
                            <div className="detail-grid">
                                <div className="detail-item">
                                    <span className="detail-label">Model</span>
                                    <span className="detail-value">{selectedDevice.model}</span>
                                </div>
                                <div className="detail-item">
                                    <span className="detail-label">Serial</span>
                                    <span className="detail-value">{selectedDevice.sn}</span>
                                </div>
                                <div className="detail-item">
                                    <span className="detail-label">Firmware</span>
                                    <span className="detail-value">{selectedDevice.firmware}</span>
                                </div>
                                <div className="detail-item">
                                    <span className="detail-label">WAN IP</span>
                                    <span className="detail-value">{selectedDevice.wan_ip || '—'}</span>
                                </div>
                                <div className="detail-item">
                                    <span className="detail-label">Uptime</span>
                                    <span className="detail-value">{formatUptime(selectedDevice.uptime)}</span>
                                </div>
                                <div className="detail-item">
                                    <span className="detail-label">Clients</span>
                                    <span className="detail-value">{selectedDevice.client_count}</span>
                                </div>
                            </div>
                        </div>

                        {selectedDevice.cellular && (
                            <div className="detail-section">
                                <h4>Cellular</h4>
                                <div className="detail-signal-hero">
                                    <SignalBars bars={selectedDevice.cellular.signal_bar} size={48} />
                                    <div className="signal-hero-info">
                                        <span className="signal-hero-carrier">{selectedDevice.cellular.carrier}</span>
                                        <span className="signal-hero-tech">{selectedDevice.cellular.technology}</span>
                                    </div>
                                </div>

                                {selectedDevice.cellular.signal && (
                                    <div className="detail-grid signal-metrics">
                                        <div className="detail-item">
                                            <span className="detail-label">RSRP</span>
                                            <span className="detail-value" style={{ color: signalQuality(selectedDevice.cellular.signal.rsrp).color }}>
                                                {selectedDevice.cellular.signal.rsrp} dBm
                                            </span>
                                        </div>
                                        <div className="detail-item">
                                            <span className="detail-label">RSRQ</span>
                                            <span className="detail-value">{selectedDevice.cellular.signal.rsrq} dB</span>
                                        </div>
                                        <div className="detail-item">
                                            <span className="detail-label">RSSI</span>
                                            <span className="detail-value">{selectedDevice.cellular.signal.rssi} dBm</span>
                                        </div>
                                        <div className="detail-item">
                                            <span className="detail-label">SINR</span>
                                            <span className="detail-value">{selectedDevice.cellular.signal.sinr} dB</span>
                                        </div>
                                    </div>
                                )}

                                <div className="detail-grid">
                                    <div className="detail-item">
                                        <span className="detail-label">Band</span>
                                        <span className="detail-value">{selectedDevice.cellular.band || '—'}</span>
                                    </div>
                                    <div className="detail-item">
                                        <span className="detail-label">APN</span>
                                        <span className="detail-value">{selectedDevice.cellular.apn || '—'}</span>
                                    </div>
                                    <div className="detail-item">
                                        <span className="detail-label">IMEI</span>
                                        <span className="detail-value">{selectedDevice.cellular.imei || '—'}</span>
                                    </div>
                                </div>

                                {selectedDevice.cellular.sims?.length > 0 && (
                                    <>
                                        <h4 className="subsection-title">SIM Cards</h4>
                                        {selectedDevice.cellular.sims.map(sim => (
                                            <div key={sim.id} className={`sim-card ${sim.active ? 'sim-active' : 'sim-inactive'}`}>
                                                <div className="sim-header">
                                                    <span className="sim-label">SIM {sim.id}</span>
                                                    <span className={`sim-status ${sim.active ? 'sim-status-active' : ''}`}>
                                                        {sim.active ? '● Active' : '○ Standby'}
                                                    </span>
                                                </div>
                                                <div className="sim-details">
                                                    {sim.carrier && <span>{sim.carrier}</span>}
                                                    {sim.iccid && <span className="sim-iccid">ICCID: {sim.iccid}</span>}
                                                </div>
                                            </div>
                                        ))}
                                    </>
                                )}
                            </div>
                        )}

                        <div className="detail-section">
                            <h4>Data Usage</h4>
                            <div className="detail-grid">
                                <div className="detail-item">
                                    <span className="detail-label">Total</span>
                                    <span className="detail-value">{formatMB(selectedDevice.usage_mb)}</span>
                                </div>
                                <div className="detail-item">
                                    <span className="detail-label">Upload</span>
                                    <span className="detail-value">{formatMB(selectedDevice.tx_mb)}</span>
                                </div>
                                <div className="detail-item">
                                    <span className="detail-label">Download</span>
                                    <span className="detail-value">{formatMB(selectedDevice.rx_mb)}</span>
                                </div>
                            </div>
                        </div>

                        <div className="detail-section">
                            <h4>WAN Interfaces</h4>
                            {selectedDevice.wan_interfaces?.map(iface => (
                                <div key={iface.id} className={`wan-iface wan-iface-${iface.status_led || 'gray'}`}>
                                    <span className="wan-name">{iface.name}</span>
                                    <span className="wan-type">{iface.type}</span>
                                    <span className="wan-status">{iface.message || iface.status}</span>
                                    {iface.ip && <span className="wan-ip">{iface.ip}</span>}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

export default NetworkPage
