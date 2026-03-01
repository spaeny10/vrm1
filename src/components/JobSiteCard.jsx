import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import GaugeChart from './GaugeChart'

const GRADE_ORDER = ['F', 'D', 'C', 'B', 'A']

function getWorstGrade(trailers, healthGrades) {
    if (!healthGrades || !trailers || trailers.length === 0) return null
    let worst = null
    for (const t of trailers) {
        const hg = healthGrades[t.site_id]
        if (!hg) continue
        if (!worst || GRADE_ORDER.indexOf(hg.grade) < GRADE_ORDER.indexOf(worst.grade)) {
            worst = hg
        }
    }
    return worst
}

function HealthGradeBadge({ healthGrade }) {
    if (!healthGrade) return null
    const { grade, score, color } = healthGrade
    return (
        <span
            className="health-grade-badge"
            style={{ backgroundColor: color }}
            title={`Health: ${grade} (${score}/100)`}
        >
            {grade}
        </span>
    )
}

function JobSiteCard({ jobSite, healthGrades }) {
    const navigate = useNavigate()

    const {
        id, name, trailer_count, trailers_online,
        avg_soc, min_soc, total_solar_watts,
        worst_status, net_online, net_total,
    } = jobSite

    const worstGrade = useMemo(
        () => getWorstGrade(jobSite.trailers || [], healthGrades),
        [jobSite.trailers, healthGrades]
    )

    const statusClass = worst_status === 'critical' ? 'alarm'
        : worst_status === 'warning' ? 'warning'
        : worst_status === 'unknown' ? 'offline'
        : 'ok'

    return (
        <div
            className={`site-card site-card-${statusClass}`}
            onClick={() => navigate(`/site/${id}`)}
        >
            <div className="site-card-header">
                <div>
                    <h3 className="site-card-name">{name}</h3>
                    <span className="site-card-subtitle">
                        {trailer_count} trailer{trailer_count !== 1 ? 's' : ''}
                    </span>
                </div>
                <div className="site-card-badges">
                    <HealthGradeBadge healthGrade={worstGrade} />
                    <span className={`jobsite-status-badge jobsite-status-${worst_status}`}>
                        {worst_status}
                    </span>
                </div>
            </div>

            <div className="site-card-body">
                <div className="site-card-gauge">
                    <GaugeChart
                        value={avg_soc ?? 0}
                        max={100}
                        label="Avg SOC"
                        size={90}
                        thickness={8}
                    />
                </div>

                <div className="site-card-stats">
                    <div className="stat-row">
                        <span className="stat-label">Min SOC</span>
                        <span className="stat-value">
                            {min_soc != null ? `${min_soc}%` : '--'}
                        </span>
                    </div>
                    <div className="stat-row">
                        <span className="stat-label">Solar</span>
                        <span className="stat-value">
                            {total_solar_watts != null ? `${total_solar_watts}W` : '--'}
                        </span>
                    </div>
                    <div className="stat-row">
                        <span className="stat-label">Trailers</span>
                        <span className="stat-value">
                            {trailers_online}/{trailer_count} online
                        </span>
                    </div>
                </div>
            </div>

            {net_total > 0 && (
                <div className="site-card-netrow">
                    <span className={`netrow-dot ${net_online === net_total ? 'netrow-dot-on' : 'netrow-dot-off'}`}></span>
                    <span className="netrow-carrier">Network</span>
                    <span className="netrow-tech">{net_online}/{net_total} online</span>
                </div>
            )}

            <div className="site-card-footer">
                <span className="last-update">{jobSite.address || ''}</span>
                <span className="site-card-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                        <circle cx="12" cy="9" r="2.5"/>
                    </svg>
                </span>
            </div>
        </div>
    )
}

export default JobSiteCard
