import { useState, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchJobSite } from '../api/vrm'
import KpiCard from '../components/KpiCard'
import GaugeChart from '../components/GaugeChart'

ChartJS.register(
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
)

function JobSiteDetail() {
    const { id } = useParams()
    const navigate = useNavigate()
    const [editingName, setEditingName] = useState(false)
    const [nameInput, setNameInput] = useState('')

    const fetchFn = useCallback(() => fetchJobSite(id), [id])
    const { data, loading } = useApiPolling(fetchFn, 30000)

    const jobSite = data?.job_site
    const trailers = jobSite?.trailers || []

    // Compute aggregated KPIs
    const kpis = useMemo(() => {
        if (!trailers.length) return {}
        let totalSoc = 0, socCount = 0, minSoc = Infinity
        let totalSolar = 0, trailersOnline = 0
        let netOnline = 0, netTotal = 0

        for (const t of trailers) {
            const snap = t.snapshot
            if (snap) {
                trailersOnline++
                if (snap.battery_soc != null) {
                    totalSoc += snap.battery_soc
                    socCount++
                    if (snap.battery_soc < minSoc) minSoc = snap.battery_soc
                }
                totalSolar += snap.solar_watts || 0
            }
            if (t.pepwave) {
                netTotal++
                if (t.pepwave.online) netOnline++
            }
        }

        return {
            avgSoc: socCount > 0 ? (totalSoc / socCount).toFixed(1) : '--',
            minSoc: minSoc === Infinity ? '--' : minSoc.toFixed(1),
            totalSolar: totalSolar.toFixed(0),
            trailersOnline,
            trailerCount: trailers.length,
            netOnline,
            netTotal,
        }
    }, [trailers])

    const handleSaveName = async () => {
        if (!nameInput.trim()) return
        try {
            await fetch(`/api/job-sites/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: nameInput.trim() }),
            })
            setEditingName(false)
        } catch (err) {
            console.error('Failed to update name:', err)
        }
    }

    if (loading && !data) {
        return (
            <div className="page-loading">
                <div className="spinner"></div>
                <p>Loading site details...</p>
            </div>
        )
    }

    if (!jobSite) {
        return (
            <div className="page-loading">
                <p>Site not found</p>
                <button onClick={() => navigate('/')} className="btn btn-primary" style={{ marginTop: '1rem' }}>
                    Back to Fleet
                </button>
            </div>
        )
    }

    return (
        <div className="site-detail">
            <div className="detail-top-bar">
                <button className="back-button" onClick={() => navigate('/')}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M19 12H5M12 19l-7-7 7-7" />
                    </svg>
                    Fleet
                </button>
                <div className="detail-title-section">
                    {editingName ? (
                        <div className="inline-edit">
                            <input
                                type="text"
                                value={nameInput}
                                onChange={e => setNameInput(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleSaveName()}
                                autoFocus
                            />
                            <button onClick={handleSaveName} className="btn btn-sm">Save</button>
                            <button onClick={() => setEditingName(false)} className="btn btn-sm btn-ghost">Cancel</button>
                        </div>
                    ) : (
                        <h1
                            className="detail-site-name clickable"
                            onClick={() => { setNameInput(jobSite.name); setEditingName(true) }}
                            title="Click to rename"
                        >
                            {jobSite.name}
                        </h1>
                    )}
                    <div className="detail-meta">
                        {jobSite.address && <span className="detail-address">{jobSite.address}</span>}
                        <span className={`jobsite-status-badge jobsite-status-${jobSite.status}`}>
                            {jobSite.status}
                        </span>
                        <span className="detail-trailer-count">
                            {trailers.length} trailer{trailers.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                </div>
            </div>

            {/* KPI Row */}
            <div className="kpi-row">
                <KpiCard title="Avg SOC" value={kpis.avgSoc} unit="%" color="teal" />
                <KpiCard title="Min SOC" value={kpis.minSoc} unit="%" color={kpis.minSoc !== '--' && kpis.minSoc < 20 ? 'red' : 'blue'} />
                <KpiCard title="Total Solar" value={kpis.totalSolar} unit="W" color="yellow" />
                <KpiCard title="Trailers" value={`${kpis.trailersOnline}/${kpis.trailerCount}`} color="green" />
                {kpis.netTotal > 0 && (
                    <KpiCard title="Network" value={`${kpis.netOnline}/${kpis.netTotal}`} color="blue" />
                )}
            </div>

            {/* Trailer Grid */}
            <div className="jobsite-section">
                <h2>Trailers at this Site</h2>
                <div className="trailer-grid">
                    {trailers.map(t => {
                        const snap = t.snapshot
                        const soc = snap?.battery_soc
                        let status = 'ok'
                        if (!snap) status = 'offline'
                        else if (soc != null && soc < 20) status = 'alarm'
                        else if (soc != null && soc < 40) status = 'warning'

                        return (
                            <div
                                key={t.site_id}
                                className={`trailer-mini-card trailer-mini-${status}`}
                                onClick={() => navigate(`/trailer/${t.site_id}`)}
                            >
                                <div className="trailer-mini-header">
                                    <span className="trailer-mini-name">{t.site_name}</span>
                                    <span className={`trailer-mini-status trailer-mini-status-${status}`}>
                                        {status === 'offline' ? 'Offline' : status === 'alarm' ? 'Low' : status === 'warning' ? 'Warn' : 'OK'}
                                    </span>
                                </div>
                                <div className="trailer-mini-body">
                                    <GaugeChart
                                        value={soc ?? 0}
                                        max={100}
                                        label="SOC"
                                        size={60}
                                        thickness={6}
                                    />
                                    <div className="trailer-mini-stats">
                                        <span>{snap?.solar_watts != null ? `${Math.round(snap.solar_watts)}W` : '--'}</span>
                                        <span>{snap?.battery_voltage != null ? `${Number(snap.battery_voltage).toFixed(1)}V` : '--'}</span>
                                    </div>
                                </div>
                                {t.pepwave && (
                                    <div className="trailer-mini-net">
                                        <span className={`netrow-dot ${t.pepwave.online ? 'netrow-dot-on' : 'netrow-dot-off'}`}></span>
                                        <span>{t.pepwave.online ? 'Online' : 'Offline'}</span>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            </div>

            {/* Maintenance placeholder */}
            <div className="jobsite-section">
                <h2>Maintenance</h2>
                <div className="empty-section">
                    <p>Maintenance tracking coming soon</p>
                </div>
            </div>
        </div>
    )
}

export default JobSiteDetail
