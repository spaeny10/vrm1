import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { MapContainer, TileLayer, CircleMarker, Circle, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchBoardSites, fetchBoardTrailers, fetchMapSites } from '../api/vrm'
import { Page, Chips, Dot, Badge, Loading, Empty, Icon } from '../ui'
import { HEALTH, plural } from '../ui/format'
import { cssVar } from '../ui/chart'

// Where every job site is, and which ones need attention.
// Health/customer come from the board API; geofence + weather from /map/sites.

const WORST = {
    attention: { tone: 'crit', label: 'Needs attention' },
    offline: { tone: 'off', label: 'Trailer offline' },
    watch: { tone: 'warn', label: 'Watch' },
    good: { tone: 'ok', label: 'Healthy' },
    empty: { tone: 'off', label: 'No trailers' },
}
const WORST_ORDER = ['attention', 'offline', 'watch', 'good', 'empty']
// Fallback when only /map/sites is available
const LEGACY_WORST = { critical: 'attention', warning: 'watch', healthy: 'good', unknown: 'empty' }
const ISSUE_HEALTH = ['attention', 'offline', 'watch']

const WMO = [
    [0, 'Clear'], [1, 'Mostly clear'], [2, 'Partly cloudy'], [3, 'Overcast'], [48, 'Fog'], [55, 'Drizzle'],
    [57, 'Freezing drizzle'], [65, 'Rain'], [67, 'Freezing rain'], [77, 'Snow'], [82, 'Showers'], [86, 'Snow showers'], [99, 'Thunderstorms'],
]
function weatherWord(code) {
    if (code == null) return null
    const hit = WMO.find(([max]) => code <= max)
    return hit ? hit[1] : null
}
function weatherShort(w) {
    if (!w || w.temperature == null) return null
    return [`${Math.round(w.temperature)}°C`, weatherWord(w.weather_code)].filter(Boolean).join(' · ')
}
function weatherLong(w) {
    if (!w) return null
    return [
        weatherShort(w),
        w.wind_speed_kmh != null ? `wind ${Math.round(w.wind_speed_kmh)} km/h` : null,
        w.cloud_cover_pct != null ? `${Math.round(w.cloud_cover_pct)}% cloud` : null,
    ].filter(Boolean).join(' · ')
}

function useTheme() {
    const read = () => (document.documentElement.dataset.theme !== 'light' ? 'dark' : 'light')
    const [theme, setTheme] = useState(read)
    useEffect(() => {
        const obs = new MutationObserver(() => setTheme(read()))
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        return () => obs.disconnect()
    }, [])
    return theme
}

// Basemap follows the theme. CARTO's basemaps (dark_all/light_all) now return
// "API KEY REQUIRED" tiles without a key, so use Esri's keyless Canvas basemaps.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas'
const TILES = {
    dark: { base: `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, labels: `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}` },
    light: { base: `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, labels: `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}` },
}
const TILE_ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors'

const markerRadius =(n) => 7 + Math.min(8, Math.sqrt(n || 0) * 2.5)

export default function MapView() {
    const theme = useTheme()
    const [filter, setFilter] = useState('all')
    const [showGeo, setShowGeo] = useState(false)
    const [showWx, setShowWx] = useState(false)
    const [selectedId, setSelectedId] = useState(null)
    const [map, setMap] = useState(null)
    const markerRefs = useRef({})
    const fitKey = useRef(null)

    const boardFn = useCallback(() => fetchBoardSites(), [])
    const trailersFn = useCallback(() => fetchBoardTrailers(), [])
    const mapFn = useCallback(() => fetchMapSites(), [])
    const boardQ = useApiPolling(boardFn, 60000)
    const trailersQ = useApiPolling(trailersFn, 60000)
    const mapQ = useApiPolling(mapFn, 60000)

    const sites = useMemo(() => {
        const extra = new Map((mapQ.data?.markers || []).map(m => [m.id, m]))
        const bySite = new Map()
        for (const t of trailersQ.data?.trailers || []) {
            if (t.site?.id == null) continue
            if (!bySite.has(t.site.id)) bySite.set(t.site.id, [])
            bySite.get(t.site.id).push(t)
        }
        const base = boardQ.data?.sites
            ? boardQ.data.sites.map(s => ({ ...s, worst: s.worst, issues: (s.health?.attention || 0) + (s.health?.offline || 0) + (s.health?.watch || 0) }))
            : (mapQ.data?.markers || []).map(m => ({
                id: m.id, name: m.name, address: m.address, latitude: m.latitude, longitude: m.longitude, is_hq: m.is_headquarters,
                customer: null, trailers: m.trailer_count, worst: LEGACY_WORST[m.worst_status] || 'empty',
                issues: m.worst_status === 'critical' || m.worst_status === 'warning' ? Math.max(1, m.trailer_count - m.trailers_online) : 0,
            }))
        return base.map(s => {
            const m = extra.get(s.id)
            const issueTrailers = (bySite.get(s.id) || [])
                .filter(t => ISSUE_HEALTH.includes(t.health))
                .sort((a, b) => ISSUE_HEALTH.indexOf(a.health) - ISSUE_HEALTH.indexOf(b.health))
            const lat = s.latitude != null ? Number(s.latitude) : null
            const lng = s.longitude != null ? Number(s.longitude) : null
            return {
                ...s, lat, lng,
                hasLoc: lat != null && lng != null && !isNaN(lat) && !isNaN(lng),
                geofence_radius_m: m?.geofence_radius_m || null,
                geofence_breached: !!m?.geofence_breached,
                weather: m?.weather || null,
                issueTrailers,
                hasIssues: s.issues > 0 || !!m?.geofence_breached,
            }
        }).sort((a, b) => (b.geofence_breached - a.geofence_breached)
            || (WORST_ORDER.indexOf(a.worst) - WORST_ORDER.indexOf(b.worst))
            || a.name.localeCompare(b.name, undefined, { numeric: true }))
    }, [boardQ.data, trailersQ.data, mapQ.data])

    const counts = {
        all: sites.length,
        issues: sites.filter(s => s.hasIssues).length,
        customer: sites.filter(s => !s.is_hq).length,
        hq: sites.filter(s => s.is_hq).length,
    }
    const visible = sites.filter(s => filter === 'issues' ? s.hasIssues : filter === 'customer' ? !s.is_hq : filter === 'hq' ? s.is_hq : true)
    const onMap = visible.filter(s => s.hasLoc)
    const offMap = visible.filter(s => !s.hasLoc)

    const colors = useMemo(() => ({
        crit: cssVar('--crit'), warn: cssVar('--warn'), ok: cssVar('--ok'), off: cssVar('--off'),
        ring: cssVar('--surface'), accent: cssVar('--accent'),
    }), [theme])

    const fitAll = useCallback((list) => {
        if (!map || !list.length) return
        if (list.length === 1) map.setView([list[0].lat, list[0].lng], 11)
        else map.fitBounds(L.latLngBounds(list.map(s => [s.lat, s.lng])), { padding: [48, 48], maxZoom: 11 })
    }, [map])

    // Fit once when data first arrives, and again whenever the filter changes
    useEffect(() => {
        if (!map || !onMap.length || fitKey.current === filter) return
        fitKey.current = filter
        fitAll(onMap)
    }, [map, onMap, filter, fitAll])

    const focus = (s) => {
        setSelectedId(s.id)
        if (!map || !s.hasLoc) return
        const open = () => markerRefs.current[s.id]?.openPopup()
        map.once('moveend', open)
        map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 10), { duration: 0.6 })
    }

    const loading = boardQ.loading && mapQ.loading && !boardQ.data && !mapQ.data
    const failed = !boardQ.data && !mapQ.data && (boardQ.error || mapQ.error)
    const tileStyle = theme === 'light' ? 'light' : 'dark'
    const frameHeight = 'calc(100vh - 230px)'

    return (
        <Page title="Map"
            sub={loading ? 'Loading…' : `${plural(sites.filter(s => s.hasLoc).length, 'site')} on the map · ${counts.issues ? `${counts.issues} with issues` : 'no issues'}`}>
            <div>
                <div className="toolbar">
                    <Chips value={filter} onChange={setFilter} options={[
                        { key: 'all', label: 'All', count: counts.all },
                        { key: 'issues', label: 'Has issues', dot: 'crit', count: counts.issues },
                        { key: 'customer', label: 'Customer sites', count: counts.customer },
                        { key: 'hq', label: 'HQ', count: counts.hq },
                    ]} />
                    <span className="spacer" />
                    <button className={`chip ${showGeo ? 'on' : ''}`} aria-pressed={showGeo} onClick={() => setShowGeo(v => !v)}>
                        {showGeo && <Icon name="check" size={13} />}Geofences
                    </button>
                    <button className={`chip ${showWx ? 'on' : ''}`} aria-pressed={showWx} onClick={() => setShowWx(v => !v)}>
                        {showWx && <Icon name="check" size={13} />}Weather
                    </button>
                    <button className="btn sm" onClick={() => fitAll(onMap)} disabled={!onMap.length}><Icon name="map" />Fit all</button>
                </div>

                {failed ? <div className="card"><Empty title="Couldn't load the map">{boardQ.error || mapQ.error}</Empty></div> : (
                    <div className="grid-main">
                        <div className="map-frame" style={{ height: frameHeight, position: 'relative', zIndex: 0 }}>
                            <MapContainer ref={setMap} center={[37.5, -98.5]} zoom={4} maxZoom={16} style={{ height: '100%', width: '100%' }} worldCopyJump>
                                <TileLayer key={`b${tileStyle}`} url={TILES[tileStyle].base} maxZoom={16} attribution={TILE_ATTRIBUTION} />
                                <TileLayer key={`r${tileStyle}`} url={TILES[tileStyle].labels} maxZoom={16} />

                                {showGeo && onMap.filter(s => s.geofence_radius_m).map(s => (
                                    <Circle key={`g${s.id}`} center={[s.lat, s.lng]} radius={s.geofence_radius_m} interactive={false}
                                        pathOptions={s.geofence_breached
                                            ? { color: colors.crit, weight: 2, fillColor: colors.crit, fillOpacity: 0.12 }
                                            : { color: colors.accent, weight: 1.5, dashArray: '5 5', fillColor: colors.accent, fillOpacity: 0.06 }} />
                                ))}

                                {onMap.map(s => {
                                    const tone = WORST[s.worst]?.tone || 'off'
                                    return (
                                        <CircleMarker key={`m${s.id}`} center={[s.lat, s.lng]} radius={markerRadius(s.trailers)}
                                            ref={el => { if (el) markerRefs.current[s.id] = el; else delete markerRefs.current[s.id] }}
                                            eventHandlers={{ click: () => setSelectedId(s.id) }}
                                            pathOptions={{
                                                color: s.geofence_breached ? colors.crit : s.is_hq ? colors.accent : colors.ring,
                                                weight: s.is_hq || s.geofence_breached ? 3 : 2,
                                                fillColor: colors[tone] || colors.off, fillOpacity: s.worst === 'empty' ? 0.45 : 0.9,
                                                dashArray: s.worst === 'offline' ? '3 3' : null,
                                            }}>
                                            <Popup><SitePopup s={s} showWeather={showWx} /></Popup>
                                        </CircleMarker>
                                    )
                                })}

                                {showWx && onMap.filter(s => weatherShort(s.weather)).map(s => (
                                    <Marker key={`w${s.id}-${theme}`} position={[s.lat, s.lng]} interactive={false} keyboard={false}
                                        icon={L.divIcon({
                                            className: '',
                                            iconSize: [0, 0],
                                            iconAnchor: [-(markerRadius(s.trailers) + 6), 11],
                                            html: `<div style="display:inline-block;white-space:nowrap;padding:2px 7px;border-radius:6px;background:var(--surface);color:var(--text);border:1px solid var(--border-strong);font:600 11.5px var(--font);box-shadow:var(--shadow)">${weatherShort(s.weather)}</div>`,
                                        })} />
                                ))}
                            </MapContainer>
                        </div>

                        <section className="card" style={{ height: frameHeight, minHeight: 480, display: 'flex', flexDirection: 'column' }}>
                            <header className="card-head">
                                <h3>Sites<span className="meta">{visible.length}</span></h3>
                                <span className="faint" style={{ fontSize: 12.5 }}>issues first</span>
                            </header>
                            <div style={{ overflowY: 'auto', flex: 1 }}>
                                {loading ? <Loading /> : visible.length === 0 ? (
                                    <Empty compact title={filter === 'issues' ? 'No sites have issues' : 'No sites here'}>
                                        {filter === 'issues' ? 'Every site is healthy right now.' : 'Try a different filter.'}
                                    </Empty>
                                ) : (
                                    <div className="list">
                                        {onMap.map(s => (
                                            <SiteRow key={s.id} s={s} showWx={showWx} selected={selectedId === s.id} onClick={() => focus(s)} />
                                        ))}
                                        {offMap.length > 0 && (
                                            <>
                                                <div className="faint" style={{ padding: '14px 18px 6px', fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                                                    Not on map (no location yet)
                                                </div>
                                                {offMap.map(s => <SiteRow key={s.id} s={s} to={`/site/${s.id}`} />)}
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                            <div className="card-foot" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                                {['attention', 'offline', 'watch', 'good'].map(k => (
                                    <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Dot tone={WORST[k].tone} />{WORST[k].label}</span>
                                ))}
                            </div>
                        </section>
                    </div>
                )}
            </div>
        </Page>
    )
}

function siteSummary(s) {
    if (!s.trailers) return 'No trailers'
    return s.issues ? `${plural(s.trailers, 'trailer')} · ${s.issues} with issues` : `${plural(s.trailers, 'trailer')} · all healthy`
}

function SiteRow({ s, showWx, selected, onClick, to }) {
    const w = WORST[s.worst] || WORST.empty
    const body = (
        <>
            <Dot tone={w.tone} pulse={s.worst === 'attention'} />
            <div className="main">
                <div className="title">
                    {s.name}
                    {s.is_hq && <Badge tone="info">HQ</Badge>}
                    {s.geofence_breached && <Badge tone="crit">Geofence breach</Badge>}
                </div>
                <div className="desc">{s.customer?.name || (s.is_hq ? 'Big View yard' : s.address || 'No customer')}</div>
                <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>{siteSummary(s)}</div>
            </div>
            {showWx && weatherShort(s.weather) && <div className="side">{`${Math.round(s.weather.temperature)}°C`}</div>}
        </>
    )
    if (to) return <Link to={to} className="list-row">{body}</Link>
    return (
        <div className="list-row clickable" role="button" tabIndex={0} onClick={onClick}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
            style={selected ? { background: 'var(--accent-soft)' } : undefined}>
            {body}
        </div>
    )
}

function SitePopup({ s, showWeather }) {
    const w = WORST[s.worst] || WORST.empty
    const shown = s.issueTrailers.slice(0, 4)
    return (
        <div style={{ minWidth: 230, maxWidth: 280, display: 'grid', gap: 9 }}>
            <div>
                <div style={{ fontWeight: 650, fontSize: 14, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {s.name}{s.is_hq && <Badge tone="info">HQ</Badge>}
                </div>
                <div className="faint">{s.customer?.name || (s.is_hq ? 'Big View yard' : 'No customer')}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Dot tone={w.tone} /><span>{siteSummary(s)}</span>
            </div>
            {shown.length > 0 && (
                <div style={{ display: 'grid', gap: 5 }}>
                    {shown.map(t => (
                        <div key={t.key} style={{ display: 'flex', gap: 7, alignItems: 'baseline' }}>
                            <Dot tone={HEALTH[t.health]?.tone} />
                            <b style={{ whiteSpace: 'nowrap' }}>{t.unit}</b>
                            <span className="muted">{t.diagnosis || HEALTH[t.health]?.label}</span>
                        </div>
                    ))}
                    {s.issueTrailers.length > shown.length && <span className="faint">+{s.issueTrailers.length - shown.length} more</span>}
                </div>
            )}
            {s.geofence_breached && <div style={{ color: 'var(--crit)', fontWeight: 600 }}>Geofence breach: a trailer has left the site boundary.</div>}
            {showWeather && s.weather && <div className="muted">{weatherLong(s.weather)}</div>}
            <Link to={`/site/${s.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>Open site →</Link>
        </div>
    )
}
