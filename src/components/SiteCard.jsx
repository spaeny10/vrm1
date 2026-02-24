import { useNavigate } from 'react-router-dom'
import GaugeChart from './GaugeChart'
import AlarmBadge from './AlarmBadge'

function SiteCard({ site, snapshot }) {
    const navigate = useNavigate()

    const soc = snapshot?.battery_soc ?? null
    const voltage = snapshot?.battery_voltage ?? null
    const solarW = snapshot?.solar_watts ?? null
    const yieldToday = snapshot?.solar_yield_today ?? null
    const lastUpdate = snapshot?.timestamp
        ? new Date(snapshot.timestamp).toLocaleTimeString()
        : '—'

    // Determine status
    let status = 'ok'
    if (site.alarmMonitoring && soc !== null && soc < 20) status = 'alarm'
    else if (soc !== null && soc < 40) status = 'warning'
    if (!snapshot) status = 'offline'

    return (
        <div
            className={`site-card site-card-${status}`}
            onClick={() => navigate(`/site/${site.idSite}`)}
        >
            <div className="site-card-header">
                <h3 className="site-card-name">{site.name}</h3>
                <AlarmBadge level={status} />
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

            <div className="site-card-footer">
                <span className="last-update">Updated {lastUpdate}</span>
                <span className="site-card-icon">
                    {site.device_icon === 'solar' ? '☀️' : '🔋'}
                </span>
            </div>
        </div>
    )
}

export default SiteCard
