import { useNavigate } from 'react-router-dom'
import GaugeChart from './GaugeChart'
import AlarmBadge from './AlarmBadge'

function SignalBadge({ pepwave }) {
    if (!pepwave) return null

    const bars = pepwave.signal_bar ?? 0
    const online = pepwave.online
    const maxBars = 5
    const barWidth = 3
    const gap = 1
    const size = 16

    return (
        <div className={`signal-badge ${online ? 'signal-badge-online' : 'signal-badge-offline'}`}
            title={`${online ? 'Online' : 'Offline'} — ${pepwave.carrier || '—'} ${pepwave.technology || ''} ${pepwave.rsrp ? `(${pepwave.rsrp} dBm)` : ''}`}
        >
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                {Array.from({ length: maxBars }, (_, i) => {
                    const h = ((i + 1) / maxBars) * (size - 2) + 2
                    const x = i * (barWidth + gap)
                    const y = size - h
                    const active = i < bars
                    return (
                        <rect
                            key={i}
                            x={x}
                            y={y}
                            width={barWidth}
                            height={h}
                            rx={0.5}
                            fill={active
                                ? (online ? (bars >= 4 ? '#2ecc71' : bars >= 2 ? '#f1c40f' : '#e74c3c') : '#7f8c8d')
                                : 'rgba(255,255,255,0.08)'}
                        />
                    )
                })}
            </svg>
            <span className="signal-badge-carrier">{pepwave.carrier || '—'}</span>
        </div>
    )
}

function TrailerCard({ site, snapshot, pepwave, jobSiteName }) {
    const navigate = useNavigate()

    const soc = snapshot?.battery_soc ?? null
    const voltage = snapshot?.battery_voltage ?? null
    const solarW = snapshot?.solar_watts ?? null
    const yieldToday = snapshot?.solar_yield_today ?? null
    const lastUpdate = (() => {
        if (!snapshot?.timestamp) return '—'
        const ts = Number(snapshot.timestamp)
        if (isNaN(ts) || ts <= 0) return '—'
        const d = new Date(ts)
        if (isNaN(d.getTime())) return '—'
        const ago = Math.round((Date.now() - d.getTime()) / 60000)
        if (ago < 60) return `${ago}m ago`
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    })()

    // Determine status
    let status = 'ok'
    if (site.alarmMonitoring && soc !== null && soc < 20) status = 'alarm'
    else if (soc !== null && soc < 40) status = 'warning'
    if (!snapshot) status = 'offline'

    return (
        <div
            className={`site-card site-card-${status}`}
            onClick={() => navigate(`/trailer/${site.idSite}`)}
        >
            <div className="site-card-header">
                <div>
                    <h3 className="site-card-name">{site.name}</h3>
                    {jobSiteName && <span className="site-card-subtitle">{jobSiteName}</span>}
                </div>
                <div className="site-card-badges">
                    <SignalBadge pepwave={pepwave} />
                    <AlarmBadge level={status} />
                </div>
            </div>

            <div className="site-card-body">
                <div className="site-card-gauge">
                    <GaugeChart
                        value={soc ?? 0}
                        max={100}
                        label="SOC"
                        size={90}
                        thickness={8}
                    />
                </div>

                <div className="site-card-stats">
                    <div className="stat-row">
                        <span className="stat-label">Voltage</span>
                        <span className="stat-value">
                            {voltage !== null ? `${Number(voltage).toFixed(1)}V` : '—'}
                        </span>
                    </div>
                    <div className="stat-row">
                        <span className="stat-label">Solar</span>
                        <span className="stat-value">
                            {solarW !== null ? `${Math.round(solarW)}W` : '—'}
                        </span>
                    </div>
                    <div className="stat-row">
                        <span className="stat-label">Yield</span>
                        <span className="stat-value">
                            {yieldToday !== null ? `${Number(yieldToday).toFixed(2)} kWh` : '—'}
                        </span>
                    </div>
                </div>
            </div>

            {pepwave && (
                <div className="site-card-netrow">
                    <span className={`netrow-dot ${pepwave.online ? 'netrow-dot-on' : 'netrow-dot-off'}`}></span>
                    <span className="netrow-carrier">{pepwave.carrier || '—'}</span>
                    <span className="netrow-tech">{pepwave.technology || ''}</span>
                    {pepwave.rsrp && (
                        <span className={`netrow-rsrp ${pepwave.rsrp >= -90 ? 'netrow-good' : pepwave.rsrp >= -100 ? 'netrow-fair' : 'netrow-poor'}`}>
                            {pepwave.rsrp} dBm
                        </span>
                    )}
                    <span className="netrow-clients">{pepwave.client_count} 👤</span>
                </div>
            )}

            <div className="site-card-footer">
                <span className="last-update">Updated {lastUpdate}</span>
                <span className="site-card-icon">
                    {site.device_icon === 'solar' ? '☀️' : '🔋'}
                </span>
            </div>
        </div>
    )
}

export default TrailerCard
