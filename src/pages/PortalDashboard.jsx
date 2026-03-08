import { useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchPortalSites } from '../api/vrm'

export default function PortalDashboard() {
    const navigate = useNavigate()
    const fetchFn = useCallback(() => fetchPortalSites(), [])
    const { data, loading } = useApiPolling(fetchFn, 30000)
    const sites = data?.sites || []

    const kpis = useMemo(() => {
        let totalTrailers = 0, totalOnline = 0, totalSoc = 0, socCount = 0
        for (const s of sites) {
            totalTrailers += s.trailer_count || 0
            totalOnline += s.trailers_online || 0
            for (const t of (s.trailers || [])) {
                if (t.battery_soc != null) { totalSoc += t.battery_soc; socCount++ }
            }
        }
        return {
            sites: sites.length,
            trailers: totalTrailers,
            online: totalOnline,
            avgSoc: socCount > 0 ? Math.round(totalSoc / socCount) : null,
        }
    }, [sites])

    if (loading && sites.length === 0) {
        return <div className="page-loading"><div className="spinner" /></div>
    }

    return (
        <div className="fleet-overview">
            <div className="page-header">
                <h1>My Sites</h1>
            </div>
            <div className="kpi-row">
                <div className="kpi-card kpi-blue"><div><div className="kpi-label">Sites</div><div className="kpi-value">{kpis.sites}</div></div></div>
                <div className="kpi-card kpi-green"><div><div className="kpi-label">Trailers Online</div><div className="kpi-value">{kpis.online}/{kpis.trailers}</div></div></div>
                <div className="kpi-card kpi-teal"><div><div className="kpi-label">Avg SOC</div><div className="kpi-value">{kpis.avgSoc != null ? `${kpis.avgSoc}%` : '—'}</div></div></div>
            </div>
            <div className="site-grid" style={{ marginTop: 24 }}>
                {sites.map(site => (
                    <div key={site.id} className={`site-card site-card-${site.worst_status || 'ok'}`}
                        onClick={() => navigate(`/site/${site.id}`)} style={{ cursor: 'pointer' }}>
                        <div className="site-card-header">
                            <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
                                {site.name}
                                {site.uid && <span style={{ fontSize: '13px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>({site.uid})</span>}
                            </h3>
                            <span className={`status-badge status-${site.status}`}>{site.status}</span>
                        </div>
                        <div className="site-card-stats">
                            <div><span className="stat-label">Trailers</span><span className="stat-value">{site.trailers_online}/{site.trailer_count}</span></div>
                            <div><span className="stat-label">Avg SOC</span><span className="stat-value">{site.avg_soc != null ? `${site.avg_soc}%` : '—'}</span></div>
                        </div>
                        {site.address && <div className="site-card-address">{site.address}</div>}
                    </div>
                ))}
            </div>
        </div>
    )
}
