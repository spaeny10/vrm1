import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet'
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

function MapView() {
    const navigate = useNavigate()
    const [statusFilter, setStatusFilter] = useState('all')
    const [searchTerm, setSearchTerm] = useState('')

    const fetchFn = useCallback(() => fetchMapSites(), [])
    const { data, loading } = useApiPolling(fetchFn, 30000)

    const markers = data?.markers || []

    const filtered = useMemo(() => {
        let result = markers
        if (statusFilter !== 'all') {
            result = result.filter(m => m.worst_status === statusFilter)
        }
        if (searchTerm) {
            const term = searchTerm.toLowerCase()
            result = result.filter(m => m.name.toLowerCase().includes(term))
        }
        return result
    }, [markers, statusFilter, searchTerm])

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
                        <CircleMarker
                            key={site.id}
                            center={[site.latitude, site.longitude]}
                            radius={Math.max(12, 8 + site.trailer_count * 3)}
                            fillColor={STATUS_COLORS[site.worst_status] || STATUS_COLORS.unknown}
                            color="rgba(255,255,255,0.3)"
                            weight={2}
                            fillOpacity={0.85}
                        >
                            <Popup className="map-popup">
                                <div className="map-popup-content">
                                    <h3>{site.name}</h3>
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
                                </div>
                            </Popup>
                        </CircleMarker>
                    ))}
                </MapContainer>
            </div>

            {/* Site List Below Map */}
            <div className="map-site-list">
                <h2>All Sites</h2>
                <div className="map-site-table">
                    <table>
                        <thead>
                            <tr>
                                <th>Site</th>
                                <th>Trailers</th>
                                <th>Avg SOC</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map(site => (
                                <tr
                                    key={site.id}
                                    className="map-site-row"
                                    onClick={() => navigate(`/site/${site.id}`)}
                                >
                                    <td className="map-site-name">{site.name}</td>
                                    <td>{site.trailers_online}/{site.trailer_count}</td>
                                    <td>{site.avg_soc != null ? `${site.avg_soc}%` : '--'}</td>
                                    <td>
                                        <span className={`jobsite-status-badge jobsite-status-${site.worst_status}`}>
                                            {site.worst_status}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}

export default MapView
