import { useState, useCallback, useMemo, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchJobSite, fetchSiteMaintenance, fetchSiteContacts, assignContact, removeContact, fetchSiteNotes, addSiteNote, fetchCompanies, fetchContacts } from '../api/vrm'
import KpiCard from '../components/KpiCard'
import GaugeChart from '../components/GaugeChart'
import Breadcrumbs from '../components/Breadcrumbs'
import ReportPanel from '../components/ReportPanel'
import { useAuth } from '../components/AuthProvider'

ChartJS.register(
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
)

function JobSiteDetail() {
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const { id } = useParams()
    const navigate = useNavigate()
    const [editingName, setEditingName] = useState(false)
    const [nameInput, setNameInput] = useState('')
    const [showReport, setShowReport] = useState(false)

    // Contacts state
    const [siteContacts, setSiteContacts] = useState([])
    const [showAssignContact, setShowAssignContact] = useState(false)
    const [availableContacts, setAvailableContacts] = useState([])
    const [selectedContactId, setSelectedContactId] = useState('')
    const [contactRole, setContactRole] = useState('on-site')

    // Notes state
    const [notes, setNotes] = useState([])
    const [notesTotal, setNotesTotal] = useState(0)
    const [newNoteText, setNewNoteText] = useState('')
    const [addingNote, setAddingNote] = useState(false)

    const fetchFn = useCallback(() => fetchJobSite(id), [id])
    const fetchMaintenanceFn = useCallback(() => fetchSiteMaintenance(id), [id])
    const { data, loading, refetch } = useApiPolling(fetchFn, 30000)
    const { data: maintenanceData } = useApiPolling(fetchMaintenanceFn, 60000)

    const jobSite = data?.job_site
    const trailers = jobSite?.trailers || []
    const maintenanceLogs = maintenanceData?.logs || []

    // Load contacts and notes when site loads
    useEffect(() => {
        if (id) {
            loadContacts()
            loadNotes()
        }
    }, [id])

    const loadContacts = async () => {
        try {
            const data = await fetchSiteContacts(id)
            setSiteContacts(data?.contacts || [])
        } catch (err) { console.error(err) }
    }

    const loadNotes = async () => {
        try {
            const data = await fetchSiteNotes(id)
            setNotes(data?.notes || [])
            setNotesTotal(data?.total || 0)
        } catch (err) { console.error(err) }
    }

    const handleAssignContact = async () => {
        if (!selectedContactId) return
        try {
            await assignContact(id, parseInt(selectedContactId), contactRole)
            setShowAssignContact(false)
            setSelectedContactId('')
            setContactRole('on-site')
            loadContacts()
        } catch (err) { console.error(err) }
    }

    const handleRemoveContact = async (contactId) => {
        if (!confirm('Remove this contact from the site?')) return
        try {
            await removeContact(id, contactId)
            loadContacts()
        } catch (err) { console.error(err) }
    }

    const handleAddNote = async (e) => {
        e.preventDefault()
        if (!newNoteText.trim()) return
        setAddingNote(true)
        try {
            await addSiteNote(id, newNoteText)
            setNewNoteText('')
            loadNotes()
        } catch (err) { console.error(err) }
        finally { setAddingNote(false) }
    }

    // Load available contacts for assignment modal
    const loadAvailableContacts = async () => {
        try {
            // If site has a company, load its contacts
            if (jobSite?.company_id) {
                const data = await fetchContacts(jobSite.company_id)
                setAvailableContacts(data?.contacts || [])
            } else {
                setAvailableContacts([])
            }
        } catch (err) { setAvailableContacts([]) }
    }

    // Compute aggregated KPIs
    const kpis = useMemo(() => {
        if (!trailers.length) return {}
        let totalSoc = 0, socCount = 0, minSoc = Infinity
        let totalSolar = 0, trailersOnline = 0
        let netOnline = 0, netTotal = 0
        let totalDcLoad = 0, alarmCount = 0

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
                if (snap.dc_load_watts != null) totalDcLoad += snap.dc_load_watts
                if (snap.alarm_reason || snap.error_code) alarmCount++
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
            totalDcLoad: totalDcLoad.toFixed(0),
            alarmCount,
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

    const formatNoteDate = (ts) => {
        if (!ts) return ''
        const d = new Date(Number(ts))
        const now = new Date()
        const diffMs = now - d
        const diffMins = Math.floor(diffMs / 60000)
        if (diffMins < 1) return 'Just now'
        if (diffMins < 60) return `${diffMins}m ago`
        const diffHrs = Math.floor(diffMins / 60)
        if (diffHrs < 24) return `${diffHrs}h ago`
        const diffDays = Math.floor(diffHrs / 24)
        if (diffDays < 7) return `${diffDays}d ago`
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
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
                <Breadcrumbs items={[{ label: 'Fleet', to: '/' }, { label: jobSite.name }]} />
                <button className="btn btn-secondary btn-sm" onClick={() => setShowReport(true)}>Export Report</button>
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
                            className={`detail-site-name${canEdit ? ' clickable' : ''}`}
                            onClick={canEdit ? () => { setNameInput(jobSite.name); setEditingName(true) } : undefined}
                            title={canEdit ? 'Click to rename' : undefined}
                        >
                            {jobSite.name}
                        </h1>
                    )}
                    <div className="detail-meta">
                        {jobSite.address && <span className="detail-address">{jobSite.address}</span>}
                        <span className={`jobsite-status-badge jobsite-status-${jobSite.status}`}>
                            {jobSite.status}
                        </span>
                        <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', padding: '2px 6px', borderRadius: 3 }}>
                            UID {jobSite.id}
                        </span>
                        <span className="detail-trailer-count">
                            {trailers.length} trailer{trailers.length !== 1 ? 's' : ''}
                        </span>
                        {jobSite.company_name && (
                            <span className="detail-company-badge" onClick={() => navigate('/companies')} style={{ cursor: 'pointer' }}>
                                🏢 {jobSite.company_name}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* KPI Row */}
            <div className="kpi-row">
                <KpiCard title="Avg SOC" value={kpis.avgSoc} unit="%" color="teal" />
                <KpiCard title="Min SOC" value={kpis.minSoc} unit="%" color={kpis.minSoc !== '--' && kpis.minSoc < 20 ? 'red' : 'blue'} />
                <KpiCard title="Total Solar" value={kpis.totalSolar} unit="W" color="yellow" />
                <KpiCard title="Total Load" value={kpis.totalDcLoad} unit="W" color="red" />
                <KpiCard title="Trailers" value={`${kpis.trailersOnline}/${kpis.trailerCount}`} color="green" />
                {kpis.netTotal > 0 && (
                    <KpiCard title="Network" value={`${kpis.netOnline}/${kpis.netTotal}`} color="blue" />
                )}
            </div>

            {/* Assigned Contacts */}
            <div className="jobsite-section">
                <div className="section-header-row">
                    <h2>Contacts</h2>
                    {canEdit && (
                        <button className="btn btn-sm btn-primary" onClick={() => {
                            loadAvailableContacts()
                            setShowAssignContact(true)
                        }}>
                            + Assign Contact
                        </button>
                    )}
                </div>
                {siteContacts.length > 0 ? (
                    <div className="contacts-grid">
                        {siteContacts.map(c => (
                            <div key={c.id} className="contact-card">
                                <div className="contact-card-top">
                                    <div className="contact-avatar">{c.name.charAt(0).toUpperCase()}</div>
                                    <div className="contact-info">
                                        <span className="contact-name">{c.name}</span>
                                        {c.title && <span className="contact-title">{c.title}</span>}
                                    </div>
                                    {c.role && <span className="contact-role-badge">{c.role}</span>}
                                </div>
                                <div className="contact-details">
                                    {c.phone && (
                                        <span className="contact-detail">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                                            </svg>
                                            {c.phone}
                                        </span>
                                    )}
                                    {c.email && (
                                        <span className="contact-detail">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                                                <polyline points="22,6 12,13 2,6" />
                                            </svg>
                                            {c.email}
                                        </span>
                                    )}
                                    {c.company_name && (
                                        <span className="contact-detail">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" />
                                            </svg>
                                            {c.company_name}
                                        </span>
                                    )}
                                </div>
                                {canEdit && (
                                    <button className="contact-delete" onClick={() => handleRemoveContact(c.contact_id)} title="Remove from site">
                                        &times;
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="empty-section">
                        <p>No contacts assigned.{jobSite.company_id ? '' : ' Link this site to a company first to assign contacts.'}</p>
                    </div>
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
                                    <div className="trailer-mini-badges">
                                        {(snap?.alarm_reason || snap?.error_code) && (
                                            <span className="alarm-dot" title={snap.alarm_reason || snap.error_code}>!</span>
                                        )}
                                        <span className={`trailer-mini-status trailer-mini-status-${status}`}>
                                            {status === 'offline' ? 'Offline' : status === 'alarm' ? 'Low' : status === 'warning' ? 'Warn' : 'OK'}
                                        </span>
                                    </div>
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
                                        {snap?.dc_load_watts != null && (
                                            <span className="trailer-mini-load">{Math.round(snap.dc_load_watts)}W load</span>
                                        )}
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

            {/* Site Notes */}
            <div className="jobsite-section">
                <div className="section-header-row">
                    <h2>Site Notes</h2>
                    <span className="detail-trailer-count">{notesTotal} total</span>
                </div>

                {/* Add Note Form */}
                {canEdit && (
                    <form className="add-note-form" onSubmit={handleAddNote}>
                        <input
                            className="input"
                            value={newNoteText}
                            onChange={e => setNewNoteText(e.target.value)}
                            placeholder="Add a note..."
                            style={{ flex: 1 }}
                        />
                        <button className="btn btn-sm btn-primary" type="submit" disabled={!newNoteText.trim() || addingNote}>
                            {addingNote ? '...' : 'Add'}
                        </button>
                    </form>
                )}

                {notes.length > 0 ? (
                    <div className="notes-timeline">
                        {notes.map(n => (
                            <div key={n.id} className="note-item">
                                <div className="note-dot"></div>
                                <div className="note-content">
                                    <div className="note-header">
                                        <span className="note-author">{n.author || 'System'}</span>
                                        <span className="note-time">{formatNoteDate(n.created_at)}</span>
                                    </div>
                                    <p className="note-text">{n.note}</p>
                                    {n.mentions && n.mentions.length > 0 && (
                                        <div className="note-mentions">
                                            {(typeof n.mentions === 'string' ? JSON.parse(n.mentions) : n.mentions).map((m, i) => (
                                                <span key={i} className="mention-tag">@{m}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="empty-section">
                        <p>No notes yet</p>
                    </div>
                )}
            </div>

            {/* Maintenance */}
            <div className="jobsite-section">
                <div className="section-header-row">
                    <h2>Maintenance</h2>
                    <button className="btn btn-sm btn-primary" onClick={() => navigate('/maintenance')}>
                        View All
                    </button>
                </div>
                {maintenanceLogs.length > 0 ? (
                    <div className="site-maint-list">
                        {maintenanceLogs.map(log => {
                            const d = log.scheduled_date ? new Date(Number(log.scheduled_date)) : null
                            const isOverdue = log.status === 'scheduled' && d && d.getTime() < Date.now()
                            const typeLabels = { inspection: 'Inspection', repair: 'Repair', scheduled: 'Scheduled', emergency: 'Emergency', installation: 'Installation', decommission: 'Decommission' }
                            return (
                                <div key={log.id} className={`site-maint-item${isOverdue ? ' site-maint-overdue' : ''}${log.status === 'completed' ? ' site-maint-done' : ''}`} onClick={() => navigate('/maintenance')}>
                                    <div className="site-maint-date-col">
                                        {d ? (
                                            <>
                                                <span className="site-maint-day">{d.getDate()}</span>
                                                <span className="site-maint-month">{d.toLocaleDateString('en-US', { month: 'short' })}</span>
                                            </>
                                        ) : (
                                            <span className="site-maint-month">No date</span>
                                        )}
                                    </div>
                                    <div className="site-maint-body">
                                        <div className="site-maint-title-row">
                                            <span className="site-maint-title">{log.title}</span>
                                            {isOverdue && <span className="site-maint-overdue-tag">OVERDUE</span>}
                                        </div>
                                        <div className="site-maint-meta">
                                            <span className={`maintenance-status-badge status-${log.status}`}>{log.status}</span>
                                            {log.visit_type !== log.status && <span className="maintenance-type-badge">{typeLabels[log.visit_type] || log.visit_type}</span>}
                                            {(log.assigned_technician_name || log.technician) && (
                                                <span className="site-maint-tech">{log.assigned_technician_name || log.technician}</span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                ) : (
                    <div className="empty-section">
                        <p>No maintenance logs for this site</p>
                    </div>
                )}
            </div>

            {showReport && (
                <ReportPanel type="site" id={id} onClose={() => setShowReport(false)} />
            )}

            {/* Assign Contact Modal */}
            {showAssignContact && (
                <div className="modal-overlay" onClick={() => setShowAssignContact(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
                        <div className="modal-header">
                            <h2>Assign Contact to Site</h2>
                            <button className="modal-close" onClick={() => setShowAssignContact(false)}>&times;</button>
                        </div>
                        <div style={{ padding: 20 }}>
                            {!jobSite.company_id ? (
                                <div className="empty-section">
                                    <p>This site isn't linked to a company yet. Link it to a company first (via the Add Site modal or Settings), then you can assign contacts from that company.</p>
                                </div>
                            ) : availableContacts.length === 0 ? (
                                <div className="empty-section">
                                    <p>No contacts found for this company. Go to <strong>Companies</strong> and add contacts first.</p>
                                </div>
                            ) : (
                                <>
                                    <div style={{ marginBottom: 14 }}>
                                        <label className="form-label">Contact</label>
                                        <select className="input" value={selectedContactId} onChange={e => setSelectedContactId(e.target.value)}>
                                            <option value="">— Select a contact —</option>
                                            {availableContacts
                                                .filter(ac => !siteContacts.some(sc => sc.contact_id === ac.id))
                                                .map(c => (
                                                    <option key={c.id} value={c.id}>{c.name}{c.title ? ` — ${c.title}` : ''}</option>
                                                ))
                                            }
                                        </select>
                                    </div>
                                    <div style={{ marginBottom: 14 }}>
                                        <label className="form-label">Role at this site</label>
                                        <select className="input" value={contactRole} onChange={e => setContactRole(e.target.value)}>
                                            <option value="on-site">On-Site</option>
                                            <option value="billing">Billing</option>
                                            <option value="emergency">Emergency</option>
                                            <option value="project-manager">Project Manager</option>
                                        </select>
                                    </div>
                                    <div className="modal-footer">
                                        <button className="btn btn-secondary" onClick={() => setShowAssignContact(false)}>Cancel</button>
                                        <button className="btn btn-primary" onClick={handleAssignContact} disabled={!selectedContactId}>Assign</button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

export default JobSiteDetail
