import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapContainer, TileLayer, CircleMarker, Popup, useMap, Circle } from 'react-leaflet'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchMapSites } from '../api/vrm'
import 'leaflet/dist/leaflet.css'

const STATUS_COLORS = {
    healthy: '#2ecc71',
    warning: '#f1c40f',
    critical: '#e74c3c',
    unknown: '#7f8c8d',
}

// Auto-fit map bounds to markers
function FitBounds({ markers }) {
    const map = useMap()
    const fitted = useRef(false)

    useEffect(() => {
        if (markers.length > 0 && !fitted.current) {
            const bounds = markers.map(m => [m.latitude, m.longitude])
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 12 })
            fitted.current = true
        }
    }, [markers, map])

    return null
}

// Extract state from site name or address (e.g., "Aurora, Colorado" → "Colorado")
function extractState(site) {
    // Try address first — look for state abbreviation or name before zip
    if (site.address) {
        const parts = site.address.split(',').map(s => s.trim())
        // Typical format: "123 Main St, City, State ZIP" or "City, State"
        for (let i = parts.length - 1; i >= 0; i--) {
            const cleaned = parts[i].replace(/\d{5}(-\d{4})?/, '').trim()
            if (cleaned && cleaned.length >= 2 && !/^\d+/.test(cleaned)) {
                // Map common 2-letter state abbreviations
                const abbr = cleaned.toUpperCase()
                if (US_STATE_ABBRS[abbr]) return US_STATE_ABBRS[abbr]
                // If it's a full state name, use it
                if (cleaned.length > 2) return cleaned
            }
        }
    }
    // Fallback: parse from site name (e.g., "Aurora, Colorado")
    const parts = site.name.split(',')
    if (parts.length >= 2) {
        const candidate = parts[parts.length - 1].trim().replace(/#\d+$/, '').trim()
        if (candidate) return candidate
    }
    return 'Other'
}

const US_STATE_ABBRS = {
    AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
    CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
    HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
    KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
    MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
    MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
    NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
    OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
    SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
    VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
    DC:'District of Columbia',
}

const DEPLOYMENT_COLORS = {
    active: '#2ecc71',
    standby: '#f1c40f',
    completed: '#7f8c8d',
}

const HQ_COLOR = '#9b59b6'

const WMO_ICONS = {
    0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
    45: '🌫️', 48: '🌫️',
    51: '🌦️', 53: '🌧️', 55: '🌧️',
    61: '🌧️', 63: '🌧️', 65: '🌧️',
    71: '🌨️', 73: '🌨️', 75: '🌨️',
    80: '🌦️', 81: '🌧️', 82: '🌧️',
    95: '⛈️', 96: '⛈️', 99: '⛈️',
};
function weatherIcon(code) { return WMO_ICONS[code] || '🌡️'; }

function MapView() {
    const navigate = useNavigate()
    const [statusFilter, setStatusFilter] = useState('all')
    const [deploymentFilter, setDeploymentFilter] = useState('all')
    const [searchTerm, setSearchTerm] = useState('')
    const [expandedStates, setExpandedStates] = useState({})
    const [showWeather, setShowWeather] = useState(false)
    const [showGeofences, setShowGeofences] = useState(true)

    const fetchFn = useCallback(() => fetchMapSites(), [])
    const { data, loading } = useApiPolling(fetchFn, 30000)

    const markers = data?.markers || []

    const filtered = useMemo(() => {
        let result = markers
        if (statusFilter !== 'all') {
            result = result.filter(m => m.worst_status === statusFilter)
        }
        if (deploymentFilter !== 'all') {
            if (deploymentFilter === 'hq') {
                result = result.filter(m => m.is_headquarters)
            } else {
                result = result.filter(m => m.status === deploymentFilter && !m.is_headquarters)
            }
        }
        if (searchTerm) {
            const term = searchTerm.toLowerCase()
            result = result.filter(m => m.name.toLowerCase().includes(term))
        }
        return result
    }, [markers, statusFilter, deploymentFilter, searchTerm])

    // Group sites by state (exclude HQ from totals)
    const stateGroups = useMemo(() => {
        const groups = {}
        for (const site of filtered) {
            if (site.is_headquarters) continue
            const state = extractState(site)
            if (!groups[state]) groups[state] = []
            groups[state].push(site)
        }
        // Sort states alphabetically, compute totals
        const stateList = Object.keys(groups).sort().map(state => {
            const sites = groups[state]
            const totalTrailers = sites.reduce((s, m) => s + m.trailer_count, 0)
            const totalOnline = sites.reduce((s, m) => s + m.trailers_online, 0)
            const socValues = sites.filter(m => m.avg_soc != null).map(m => m.avg_soc)
            const avgSoc = socValues.length > 0
                ? +(socValues.reduce((s, v) => s + v, 0) / socValues.length).toFixed(1)
                : null
            const worstStatus = sites.some(s => s.worst_status === 'critical') ? 'critical'
                : sites.some(s => s.worst_status === 'warning') ? 'warning'
                : sites.some(s => s.worst_status === 'healthy') ? 'healthy' : 'unknown'
            return { state, sites, totalTrailers, totalOnline, avgSoc, worstStatus }
        })
        // Add HQ as a separate group at the end if any HQ sites are in filtered
        const hqSites = filtered.filter(s => s.is_headquarters)
        if (hqSites.length > 0) {
            const totalTrailers = hqSites.reduce((s, m) => s + m.trailer_count, 0)
            const totalOnline = hqSites.reduce((s, m) => s + m.trailers_online, 0)
            const socValues = hqSites.filter(m => m.avg_soc != null).map(m => m.avg_soc)
            const avgSoc = socValues.length > 0
                ? +(socValues.reduce((s, v) => s + v, 0) / socValues.length).toFixed(1)
                : null
            stateList.push({ state: 'Headquarters', sites: hqSites, totalTrailers, totalOnline, avgSoc, worstStatus: 'healthy', isHq: true })
        }
        return stateList
    }, [filtered])

    const toggleState = (state) => {
        setExpandedStates(prev => ({ ...prev, [state]: !prev[state] }))
    }

    // Default center (US) — will be overridden by FitBounds
    const defaultCenter = [33.45, -112.07]
    const defaultZoom = 5

    if (loading && !data) {
        return (
            <div className="page-loading">
                <div className="spinner"></div>
                <p>Loading map data...</p>
            </div>
        )
    }

    return (
        <div className="map-page">
            <div className="page-header">
                <h1>Fleet Map</h1>
                <p className="page-subtitle">
                    {markers.length} job site{markers.length !== 1 ? 's' : ''} with GPS coordinates
                </p>
            </div>

            {/* Filter Controls */}
            <div className="map-controls">
                <div className="search-box">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                        type="text"
                        placeholder="Search sites..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                    />
                </div>
                <div className="map-status-filters">
                    {['all', 'healthy', 'warning', 'critical'].map(s => (
                        <button
                            key={s}
                            className={`map-filter-btn ${statusFilter === s ? 'map-filter-active' : ''}`}
                            onClick={() => setStatusFilter(s)}
                            style={s !== 'all' ? { '--filter-color': STATUS_COLORS[s] } : {}}
                        >
                            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
                            {s !== 'all' && (
                                <span className="map-filter-count">
                                    {markers.filter(m => m.worst_status === s).length}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
                <div className="map-status-filters">
                    {['all', 'active', 'standby', 'completed', 'hq'].map(s => (
                        <button
                            key={s}
                            className={`map-filter-btn ${deploymentFilter === s ? 'map-filter-active' : ''}`}
                            onClick={() => setDeploymentFilter(s)}
                            style={s !== 'all' ? { '--filter-color': s === 'hq' ? HQ_COLOR : DEPLOYMENT_COLORS[s] } : {}}
                        >
                            {s === 'all' ? 'All Sites' : s === 'hq' ? 'HQ' : s.charAt(0).toUpperCase() + s.slice(1)}
                            <span className="map-filter-count">
                                {s === 'all' ? markers.length
                                    : s === 'hq' ? markers.filter(m => m.is_headquarters).length
                                    : markers.filter(m => m.status === s && !m.is_headquarters).length}
                            </span>
                        </button>
                    ))}
                </div>
                <div className="map-toggles" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button
                        className={`filter-btn${showWeather ? ' active' : ''}`}
                        onClick={() => setShowWeather(w => !w)}
                    >Weather</button>
                    <button
                        className={`filter-btn${showGeofences ? ' active' : ''}`}
                        onClick={() => setShowGeofences(g => !g)}
                    >Geofences</button>
                </div>
            </div>

            {/* Map */}
            <div className="map-container">
                <MapContainer
                    center={defaultCenter}
                    zoom={defaultZoom}
                    style={{ height: '100%', width: '100%', borderRadius: '12px' }}
                    zoomControl={true}
                >
                    <TileLayer
                        attribution='&copy; <a href="https://carto.com/">CARTO</a>'
                        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    />
                    <FitBounds markers={filtered} />

                    {filtered.map(site => (
                        <React.Fragment key={site.id}>
                        <CircleMarker
                            center={[site.latitude, site.longitude]}
                            radius={Math.max(12, 8 + site.trailer_count * 3)}
                            fillColor={site.is_headquarters ? HQ_COLOR : STATUS_COLORS[site.worst_status] || STATUS_COLORS.unknown}
                            color={site.is_headquarters ? 'rgba(155,89,182,0.5)' : 'rgba(255,255,255,0.3)'}
                            weight={site.is_headquarters ? 3 : 2}
                            fillOpacity={0.85}
                        >
                            <Popup className="map-popup">
                                <div className="map-popup-content">
                                    <h3>{site.name}{site.is_headquarters && <span className="hq-badge">HQ</span>}</h3>
                                    <div className="map-popup-stats">
                                        <div className="map-popup-stat">
                                            <span className="map-popup-label">Trailers</span>
                                            <span className="map-popup-value">
                                                {site.trailers_online}/{site.trailer_count} online
                                            </span>
                                        </div>
                                        <div className="map-popup-stat">
                                            <span className="map-popup-label">Avg SOC</span>
                                            <span className="map-popup-value">
                                                {site.avg_soc != null ? `${site.avg_soc}%` : '--'}
                                            </span>
                                        </div>
                                        <div className="map-popup-stat">
                                            <span className="map-popup-label">Status</span>
                                            <span className={`map-popup-status map-popup-status-${site.worst_status}`}>
                                                {site.worst_status}
                                            </span>
                                        </div>
                                    </div>
                                    <button
                                        className="map-popup-link"
                                        onClick={() => navigate(`/site/${site.id}`)}
                                    >
                                        View Site Details
                                    </button>
                                    {showWeather && site.weather && (
                                        <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                                            <span style={{ fontSize: 18 }}>{weatherIcon(site.weather.weather_code)}</span>
                                            {' '}{site.weather.temperature != null ? `${Math.round(site.weather.temperature)}°C` : ''}
                                            {site.weather.cloud_cover_pct != null && <span style={{ color: '#95a5a6', marginLeft: 8 }}>☁ {site.weather.cloud_cover_pct}%</span>}
                                            {site.weather.wind_speed_kmh != null && <span style={{ color: '#95a5a6', marginLeft: 8 }}>💨 {Math.round(site.weather.wind_speed_kmh)} km/h</span>}
                                        </div>
                                    )}
                                    {site.geofence_breached && (
                                        <div style={{ marginTop: 4, color: '#e74c3c', fontWeight: 600, fontSize: 12 }}>
                                            ⚠ GEOFENCE BREACH
                                        </div>
                                    )}
                                </div>
                            </Popup>
                        </CircleMarker>
                        {showGeofences && site.geofence_radius_m && (
                            <Circle
                                center={[site.latitude, site.longitude]}
                                radius={site.geofence_radius_m}
                                pathOptions={{
                                    color: site.geofence_breached ? '#e74c3c' : 'rgba(255,255,255,0.2)',
                                    fillColor: site.geofence_breached ? 'rgba(231,76,60,0.1)' : 'rgba(255,255,255,0.03)',
                                    weight: site.geofence_breached ? 2 : 1,
                                    dashArray: site.geofence_breached ? null : '5,5',
                                }}
                            />
                        )}
                        </React.Fragment>
                    ))}
                </MapContainer>
            </div>

            {/* Site List Below Map — Grouped by State */}
            <div className="map-site-list">
                <h2>All Sites</h2>
                <div className="map-site-table">
                    <table>
                        <thead>
                            <tr>
                                <th>Site</th>
                                <th>Trailers</th>
                                <th>Avg SOC</th>
                                <th>Deployment</th>
                                <th>Health</th>
                            </tr>
                        </thead>
                        <tbody>
                            {stateGroups.map(group => {
                                const isExpanded = !!expandedStates[group.state]
                                return (
                                    <React.Fragment key={group.state}>
                                        <tr
                                            className={`map-state-row ${group.isHq ? 'map-state-hq' : ''}`}
                                            onClick={() => toggleState(group.state)}
                                        >
                                            <td className="map-state-name">
                                                <svg
                                                    className={`map-state-chevron ${isExpanded ? 'expanded' : ''}`}
                                                    width="14" height="14" viewBox="0 0 24 24"
                                                    fill="none" stroke="currentColor" strokeWidth="2"
                                                >
                                                    <polyline points="9 18 15 12 9 6" />
                                                </svg>
                                                {group.state}
                                                {group.isHq && <span className="hq-badge">HQ</span>}
                                                <span className="map-state-site-count">{group.sites.length} site{group.sites.length !== 1 ? 's' : ''}</span>
                                            </td>
                                            <td className="map-state-total">{group.totalOnline}/{group.totalTrailers}</td>
                                            <td className="map-state-total">{group.avgSoc != null ? `${group.avgSoc}%` : '--'}</td>
                                            <td></td>
                                            <td>
                                                <span className={`jobsite-status-badge jobsite-status-${group.worstStatus}`}>
                                                    {group.worstStatus}
                                                </span>
                                            </td>
                                        </tr>
                                        {isExpanded && group.sites.map(site => (
                                            <tr
                                                key={site.id}
                                                className={`map-site-row ${site.is_headquarters ? 'map-site-hq' : ''}`}
                                                onClick={() => navigate(`/site/${site.id}`)}
                                            >
                                                <td className="map-site-name map-site-indent">
                                                    {site.name}
                                                    {site.is_headquarters && <span className="hq-badge">HQ</span>}
                                                </td>
                                                <td>{site.trailers_online}/{site.trailer_count}</td>
                                                <td>{site.avg_soc != null ? `${site.avg_soc}%` : '--'}</td>
                                                <td>
                                                    <span className={`deployment-status-badge deployment-${site.status}`}>
                                                        {site.status}
                                                    </span>
                                                </td>
                                                <td>
                                                    <span className={`jobsite-status-badge jobsite-status-${site.worst_status}`}>
                                                        {site.worst_status}
                                                    </span>
                                                </td>
                                            </tr>
                                        ))}
                                    </React.Fragment>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}

export default MapView
