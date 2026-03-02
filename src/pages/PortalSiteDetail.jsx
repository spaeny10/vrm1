import { useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchPortalSiteDetail } from '../api/vrm'

export default function PortalSiteDetail() {
    const { id } = useParams()
    const navigate = useNavigate()
    const fetchFn = useCallback(() => fetchPortalSiteDetail(id), [id])
    const { data, loading } = useApiPolling(fetchFn, 30000)
    const site = data?.site

    if (loading && !site) {
        return <div className="page-loading"><div className="spinner" /></div>
    }
    if (!site) return <div className="page-empty">Site not found</div>

    return (
        <div className="fleet-overview">
            <div className="page-header">
                <button className="btn btn-secondary btn-sm" onClick={() => navigate('/')}>← Back</button>
                <h1>{site.name}</h1>
            </div>
            {site.address && <p style={{ color: 'var(--text-secondary)', margin: '-8px 0 16px' }}>{site.address}</p>}
            <div className="kpi-row">
                <div className="kpi-card kpi-green"><div><div className="kpi-label">Trailers Online</div><div className="kpi-value">{site.trailers_online}/{site.trailer_count}</div></div></div>
                <div className="kpi-card kpi-teal"><div><div className="kpi-label">Avg SOC</div><div className="kpi-value">{site.avg_soc != null ? `${site.avg_soc}%` : '—'}</div></div></div>
            </div>
            <h2 style={{ marginTop: 24 }}>Trailers</h2>
            <div className="maint-table-wrapper">
                <table className="maint-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>SOC</th>
                            <th>Solar (W)</th>
                            <th>Yield Today</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(site.trailers || []).map(t => (
                            <tr key={t.site_id}>
                                <td className="maint-title">{t.site_name}</td>
                                <td>{t.battery_soc != null ? `${t.battery_soc}%` : '—'}</td>
                                <td>{t.solar_watts != null ? Math.round(t.solar_watts) : '—'}</td>
                                <td>{t.solar_yield_today != null ? `${t.solar_yield_today.toFixed(2)} kWh` : '—'}</td>
                                <td>
                                    <span className={`alarm-badge alarm-${t.battery_soc == null ? 'offline' : t.battery_soc < 20 ? 'critical' : t.battery_soc < 50 ? 'warning' : 'ok'}`}>
                                        {t.battery_soc == null ? 'OFFLINE' : t.battery_soc < 20 ? 'CRITICAL' : t.battery_soc < 50 ? 'WARNING' : 'OK'}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}
