import { Fragment, useState, useCallback, useMemo, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { DndContext, PointerSensor, useSensors, useSensor, useDraggable, useDroppable, DragOverlay } from '@dnd-kit/core'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchSettings, updateSettings, purgeData, fetchJobSites, updateJobSite, reclusterJobSites, assignTrailer, fetchUsers, createUserAccount, updateUserAccount, deleteUserAccount, resetUserPassword, fetchGpsTrailers, refreshGps, fetchUnlinkedIc2Devices, linkIc2Device, fetchCustomerSiteAccess, updateCustomerSiteAccess, fetchDigestPreview, fetchEmailConfigStatus, sendTestEmail, updateSolarScoreSettings, fetchCommunications } from '../api/vrm'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../components/AuthProvider'

function DraggableTrailerRow({ trailer, jobSite, children }) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `trailer-${trailer.site_id}`,
        data: { trailerId: trailer.site_id, fromJobSiteId: jobSite.id, trailerName: trailer.site_name },
    })
    return (
        <tr
            ref={setNodeRef}
            className={`trailer-assign-row ${isDragging ? 'dragging' : ''}`}
            {...listeners}
            {...attributes}
            style={{ opacity: isDragging ? 0.4 : 1, cursor: 'grab' }}
        >
            {children}
        </tr>
    )
}

function DroppableJobSiteRow({ jobSiteId, isOver, children }) {
    const { setNodeRef } = useDroppable({ id: `jobsite-${jobSiteId}` })
    return (
        <tr
            ref={setNodeRef}
            className={`jobsite-mgmt-row ${isOver ? 'drop-target' : ''}`}
        >
            {children}
        </tr>
    )
}

function CommunicationLogSection({ jobSites, toast }) {
    const [notes, setNotes] = useState([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(false)
    const [filters, setFilters] = useState({ site_id: '', author: '', search: '', date_from: '', date_to: '' })
    const [page, setPage] = useState(0)
    const perPage = 25

    const loadNotes = useCallback(async (pg = 0) => {
        setLoading(true)
        try {
            const params = { limit: perPage, offset: pg * perPage }
            if (filters.site_id) params.site_id = filters.site_id
            if (filters.author) params.author = filters.author
            if (filters.search) params.search = filters.search
            if (filters.date_from) params.date_from = new Date(filters.date_from).getTime()
            if (filters.date_to) params.date_to = new Date(filters.date_to + 'T23:59:59').getTime()
            const data = await fetchCommunications(params)
            setNotes(data?.notes || [])
            setTotal(data?.total || 0)
            setPage(pg)
        } catch (err) {
            toast.error('Error loading communications: ' + err.message)
        }
        setLoading(false)
    }, [filters, toast])

    useEffect(() => { loadNotes(0) }, [loadNotes])

    const totalPages = Math.ceil(total / perPage)

    const formatTime = (ts) => {
        if (!ts) return '—'
        return new Date(Number(ts)).toLocaleString()
    }

    const updateFilter = (key, value) => {
        setFilters(f => ({ ...f, [key]: value }))
    }

    return (
        <div className="settings-card settings-card-wide">
            <div className="settings-card-header">
                <h2>📋 Communication Log</h2>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{total} total entries</span>
            </div>
            <p className="settings-desc">
                All site notes and communications across every job site. Use filters to narrow results.
            </p>

            {/* Filters */}
            <div className="comm-log-filters">
                <div className="comm-filter-group">
                    <label>Site</label>
                    <select value={filters.site_id} onChange={e => updateFilter('site_id', e.target.value)}>
                        <option value="">All Sites</option>
                        {jobSites.filter(js => js.status === 'active').map(js => (
                            <option key={js.id} value={js.id}>{js.name}</option>
                        ))}
                    </select>
                </div>
                <div className="comm-filter-group">
                    <label>Author</label>
                    <input type="text" placeholder="Filter by author..." value={filters.author} onChange={e => updateFilter('author', e.target.value)} />
                </div>
                <div className="comm-filter-group">
                    <label>Search</label>
                    <input type="text" placeholder="Search note text..." value={filters.search} onChange={e => updateFilter('search', e.target.value)} />
                </div>
                <div className="comm-filter-group">
                    <label>From</label>
                    <input type="date" className="date-input" value={filters.date_from} onChange={e => updateFilter('date_from', e.target.value)} />
                </div>
                <div className="comm-filter-group">
                    <label>To</label>
                    <input type="date" className="date-input" value={filters.date_to} onChange={e => updateFilter('date_to', e.target.value)} />
                </div>
                <div className="comm-filter-group" style={{ alignSelf: 'flex-end' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => setFilters({ site_id: '', author: '', search: '', date_from: '', date_to: '' })}>Clear</button>
                </div>
            </div>

            {/* Results */}
            {loading ? (
                <div className="empty-section"><p>Loading...</p></div>
            ) : notes.length === 0 ? (
                <div className="empty-section"><p>No communication entries found.</p></div>
            ) : (
                <div className="jobsite-mgmt-table-wrapper">
                    <table className="maint-table">
                        <thead>
                            <tr>
                                <th>Site</th>
                                <th>Author</th>
                                <th style={{ width: '45%' }}>Note</th>
                                <th>Mentions</th>
                                <th>Date</th>
                            </tr>
                        </thead>
                        <tbody>
                            {notes.map(n => (
                                <tr key={n.id} className="maint-row">
                                    <td>
                                        <span className="comm-log-site-name">{n.site_name || `Site #${n.job_site_id}`}</span>
                                        <span className="comm-log-site-uid">UID {n.job_site_id}</span>
                                    </td>
                                    <td className="maint-title">{n.author}</td>
                                    <td>
                                        <span className="comm-log-note">{n.note}</span>
                                    </td>
                                    <td>
                                        {n.mentions && n.mentions.length > 0 ? (
                                            <div className="comm-log-mentions">
                                                {(typeof n.mentions === 'string' ? JSON.parse(n.mentions) : n.mentions).map((m, i) => (
                                                    <span key={i} className="mention-tag-sm">@{m}</span>
                                                ))}
                                            </div>
                                        ) : '—'}
                                    </td>
                                    <td className="comm-log-date">{formatTime(n.created_at)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="comm-log-pagination">
                    <button className="btn btn-sm btn-ghost" disabled={page === 0} onClick={() => loadNotes(page - 1)}>← Prev</button>
                    <span className="comm-log-page-info">Page {page + 1} of {totalPages}</span>
                    <button className="btn btn-sm btn-ghost" disabled={page >= totalPages - 1} onClick={() => loadNotes(page + 1)}>Next →</button>
                </div>
            )}
        </div>
    )
}

function CustomerAccountsSection({ jobSites, toast, loadUsers }) {
    const [customers, setCustomers] = useState([])
    const [loading, setLoading] = useState(true)
    const [showCreate, setShowCreate] = useState(false)
    const [newCustomer, setNewCustomer] = useState({ username: '', password: '', display_name: '', email: '' })
    const [creating, setCreating] = useState(false)
    const [editingSites, setEditingSites] = useState(null) // userId
    const [selectedSites, setSelectedSites] = useState([])
    const [siteSearch, setSiteSearch] = useState('')

    const loadCustomers = useCallback(async () => {
        setLoading(true)
        try {
            const data = await fetchUsers()
            setCustomers((data.users || []).filter(u => u.role === 'customer'))
        } catch (err) {
            toast.error('Error loading customers: ' + err.message)
        }
        setLoading(false)
    }, [toast])

    useEffect(() => { loadCustomers() }, [loadCustomers])

    const handleCreate = async (e) => {
        e.preventDefault()
        if (!newCustomer.username.trim() || !newCustomer.password.trim()) return
        setCreating(true)
        try {
            await createUserAccount({
                username: newCustomer.username.trim(),
                password: newCustomer.password,
                display_name: newCustomer.display_name.trim() || null,
                role: 'customer',
            })
            toast.success(`Customer "${newCustomer.username}" created`)
            setNewCustomer({ username: '', password: '', display_name: '', email: '' })
            setShowCreate(false)
            loadCustomers()
            loadUsers()
        } catch (err) {
            toast.error('Error creating customer: ' + err.message)
        }
        setCreating(false)
    }

    const handleEditSites = async (userId) => {
        try {
            const data = await fetchCustomerSiteAccess(userId)
            setSelectedSites(data.sites || [])
            setEditingSites(userId)
        } catch (err) {
            toast.error('Error loading site access: ' + err.message)
        }
    }

    const handleSaveSites = async () => {
        try {
            await updateCustomerSiteAccess(editingSites, selectedSites)
            toast.success('Site access updated')
            setEditingSites(null)
        } catch (err) {
            toast.error('Error updating site access: ' + err.message)
        }
    }

    const toggleSite = (siteId) => {
        setSelectedSites(prev =>
            prev.includes(siteId) ? prev.filter(id => id !== siteId) : [...prev, siteId]
        )
    }

    return (
        <div className="settings-card settings-card-wide">
            <div className="settings-card-header">
                <h2>Customer Portal</h2>
                <button className="btn btn-primary" onClick={() => setShowCreate(true)}>+ Add Customer</button>
            </div>
            <p className="settings-desc">
                Customer accounts have read-only access to their assigned job sites. Create customer users and assign which sites they can see.
            </p>

            {showCreate && (
                <div className="maint-form-overlay" onClick={() => setShowCreate(false)}>
                    <div className="maint-form-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
                        <div className="maint-form-header">
                            <h2>Create Customer</h2>
                            <button className="detail-close" onClick={() => setShowCreate(false)}>✕</button>
                        </div>
                        <form onSubmit={handleCreate} className="maint-form">
                            <div className="maint-form-grid">
                                <div className="form-group">
                                    <label>Username *</label>
                                    <input type="text" value={newCustomer.username} onChange={e => setNewCustomer(p => ({ ...p, username: e.target.value }))} placeholder="customer-username" required autoFocus />
                                </div>
                                <div className="form-group">
                                    <label>Password *</label>
                                    <input type="password" value={newCustomer.password} onChange={e => setNewCustomer(p => ({ ...p, password: e.target.value }))} placeholder="password" required />
                                </div>
                                <div className="form-group">
                                    <label>Display Name</label>
                                    <input type="text" value={newCustomer.display_name} onChange={e => setNewCustomer(p => ({ ...p, display_name: e.target.value }))} placeholder="Company Name" />
                                </div>
                            </div>
                            <div className="maint-form-actions">
                                <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary" disabled={creating}>{creating ? 'Creating...' : 'Create Customer'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {editingSites && (() => {
                const activeSites = jobSites
                    .filter(js => js.status === 'active')
                    .filter(js => {
                        if (!siteSearch.trim()) return true
                        const q = siteSearch.toLowerCase()
                        return js.name.toLowerCase().includes(q) ||
                            (js.address || '').toLowerCase().includes(q) ||
                            String(js.id).includes(q)
                    })
                return (
                    <div className="modal-overlay" onClick={() => { setEditingSites(null); setSiteSearch('') }}>
                        <div className="modal-content assign-sites-modal" onClick={e => e.stopPropagation()}>
                            <div className="modal-header">
                                <div>
                                    <h2>Assign Sites</h2>
                                    <span className="assign-sites-count">
                                        {selectedSites.length} of {jobSites.filter(js => js.status === 'active').length} selected
                                    </span>
                                </div>
                                <button className="modal-close" onClick={() => { setEditingSites(null); setSiteSearch('') }}>&times;</button>
                            </div>

                            <div className="assign-sites-search">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}>
                                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                                <input
                                    type="text"
                                    className="input"
                                    placeholder="Search by name, address, or UID..."
                                    value={siteSearch}
                                    onChange={e => setSiteSearch(e.target.value)}
                                    autoFocus
                                    style={{ paddingLeft: 36, width: '100%' }}
                                />
                            </div>

                            <div className="assign-sites-list">
                                {activeSites.length === 0 ? (
                                    <div className="empty-section" style={{ padding: 20 }}>
                                        <p>No sites match "{siteSearch}"</p>
                                    </div>
                                ) : activeSites.map(js => {
                                    const isChecked = selectedSites.includes(js.id)
                                    return (
                                        <div
                                            key={js.id}
                                            className={`assign-site-card ${isChecked ? 'assign-site-card-selected' : ''}`}
                                            onClick={() => toggleSite(js.id)}
                                        >
                                            <div className={`assign-site-check ${isChecked ? 'assign-site-check-on' : ''}`}>
                                                {isChecked && (
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
                                                        <polyline points="20 6 9 17 4 12" />
                                                    </svg>
                                                )}
                                            </div>
                                            <div className="assign-site-info">
                                                <div className="assign-site-name-row">
                                                    <span className="assign-site-name">{js.name}</span>
                                                    <span className="assign-site-uid">UID {js.id}</span>
                                                </div>
                                                {js.address && (
                                                    <span className="assign-site-address">{js.address}</span>
                                                )}
                                            </div>
                                            <span className="assign-site-trailer-count">
                                                {js.trailer_count || 0} trailer{(js.trailer_count || 0) !== 1 ? 's' : ''}
                                            </span>
                                        </div>
                                    )
                                })}
                            </div>

                            <div className="modal-footer">
                                <button className="btn btn-secondary" onClick={() => { setEditingSites(null); setSiteSearch('') }}>Cancel</button>
                                <button className="btn btn-primary" onClick={handleSaveSites}>
                                    Save Access ({selectedSites.length} site{selectedSites.length !== 1 ? 's' : ''})
                                </button>
                            </div>
                        </div>
                    </div>
                )
            })()}

            {loading ? (
                <div className="empty-section"><p>Loading customers...</p></div>
            ) : customers.length === 0 ? (
                <div className="empty-section"><p>No customer accounts yet. Click "Add Customer" to create one.</p></div>
            ) : (
                <div className="jobsite-mgmt-table-wrapper">
                    <table className="maint-table">
                        <thead><tr><th>Username</th><th>Display Name</th><th>Sites</th><th>Actions</th></tr></thead>
                        <tbody>
                            {customers.map(c => (
                                <tr key={c.id} className="maint-row">
                                    <td className="maint-title">{c.username}</td>
                                    <td>{c.display_name || '—'}</td>
                                    <td>
                                        <button className="btn btn-sm btn-secondary" onClick={() => handleEditSites(c.id)}>
                                            Manage Sites
                                        </button>
                                    </td>
                                    <td>
                                        <button className="btn btn-sm btn-ghost" onClick={() => { deleteUserAccount(c.id).then(() => { loadCustomers(); loadUsers() }).catch(err => toast.error(err.message)) }}>
                                            Remove
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

function DigestSettingsSection({ toast }) {
    const [showPreview, setShowPreview] = useState(false)
    const [preview, setPreview] = useState(null)
    const [loadingPreview, setLoadingPreview] = useState(false)
    const [sendingEmail, setSendingEmail] = useState(false)
    const [emailStatus, setEmailStatus] = useState(null)

    useEffect(() => {
        // Load email config status on mount
        fetchEmailConfigStatus()
            .then(data => setEmailStatus(data))
            .catch(err => console.error('Failed to load email status:', err))
    }, [])

    const handlePreview = async () => {
        setLoadingPreview(true)
        try {
            const data = await fetchDigestPreview()
            setPreview(data.digest)
            setShowPreview(true)
        } catch (err) {
            toast.error('Error loading preview: ' + err.message)
        }
        setLoadingPreview(false)
    }

    const handleTestEmail = async (type) => {
        setSendingEmail(true)
        try {
            const result = await sendTestEmail(type)
            if (result.success) {
                toast.success(`Test ${type} email sent to: ${result.recipients.join(', ')}`)
            } else {
                toast.error(result.error || 'Failed to send test email')
            }
        } catch (err) {
            toast.error('Error sending test email: ' + err.message)
        }
        setSendingEmail(false)
    }

    return (
        <div className="settings-card">
            <h2>Email Notifications</h2>

            {emailStatus && (
                <div style={{ marginBottom: 12, padding: 10, background: emailStatus.configured ? 'rgba(46, 204, 113, 0.08)' : 'rgba(231, 76, 60, 0.08)', border: `1px solid ${emailStatus.configured ? '#2ecc71' : '#e74c3c'}`, borderRadius: 'var(--radius)', fontSize: '12px' }}>
                    <div style={{ fontWeight: 600, color: emailStatus.configured ? '#2ecc71' : '#e74c3c' }}>
                        {emailStatus.configured ? '✓ SendGrid Configured' : '✗ SendGrid Not Configured'}
                    </div>
                    {emailStatus.configured && (
                        <div style={{ color: 'var(--text-muted)', marginTop: 4, fontSize: '11px' }}>
                            From: {emailStatus.config.fromEmail} · {emailStatus.config.recipientCount} recipient(s)
                        </div>
                    )}
                </div>
            )}

            <p className="settings-desc">
                Alert emails are sent for energy deficits, geofence breaches, and low SOC warnings.
                Daily digests can be enabled with <code>DIGEST_ENABLED=true</code>. Users can subscribe to digests in the User Management section.
            </p>
            <div className="settings-actions">
                <button className="btn btn-secondary" onClick={handlePreview} disabled={loadingPreview}>
                    {loadingPreview ? 'Loading...' : 'Preview Digest'}
                </button>
                <button className="btn btn-secondary" onClick={() => handleTestEmail('alert')} disabled={sendingEmail}>
                    {sendingEmail ? 'Sending...' : 'Test Alert'}
                </button>
                <button className="btn btn-secondary" onClick={() => handleTestEmail('digest')} disabled={sendingEmail}>
                    {sendingEmail ? 'Sending...' : 'Test Digest'}
                </button>
                <button className="btn btn-secondary" onClick={() => handleTestEmail('geofence')} disabled={sendingEmail}>
                    {sendingEmail ? 'Sending...' : 'Test Geofence'}
                </button>
            </div>

            {/* Digest Preview Modal */}
            {showPreview && preview && (
                <div className="maint-form-overlay" onClick={() => setShowPreview(false)}>
                    <div className="maint-form-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
                        <div className="maint-form-header">
                            <h2>Daily Digest Preview</h2>
                            <button className="detail-close" onClick={() => setShowPreview(false)}>✕</button>
                        </div>
                        <div style={{ padding: '16px 24px', maxHeight: 500, overflowY: 'auto' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16, padding: 12, background: 'var(--bg-primary)', borderRadius: 'var(--radius)' }}>
                                <div><span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Fleet Size</span><br /><strong>{preview.fleet_size}</strong></div>
                                <div><span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Avg SOC</span><br /><strong>{preview.avg_soc?.toFixed(1)}%</strong></div>
                                <div><span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>Total Yield</span><br /><strong>{preview.total_yield_kwh?.toFixed(1)} kWh</strong></div>
                            </div>
                            {preview.trailers_below_50_soc?.length > 0 && (
                                <div style={{ marginBottom: 16 }}>
                                    <strong style={{ color: 'var(--warning)', fontSize: '13px' }}>⚠ Low SOC Trailers ({preview.trailers_below_50_soc.length})</strong>
                                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                        {preview.trailers_below_50_soc.map((t, i) => (
                                            <span key={i} style={{ display: 'inline-block', padding: '4px 10px', background: 'var(--bg-card)', borderRadius: 'var(--radius)', fontSize: '12px', border: '1px solid var(--border)' }}>
                                                {t.site_name}: <strong>{t.battery_soc?.toFixed(0)}%</strong>
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {preview.active_alerts?.length > 0 && (
                                <div style={{ marginBottom: 16 }}>
                                    <strong style={{ color: 'var(--danger)', fontSize: '13px' }}>🚨 Active Alerts ({preview.active_alerts.length})</strong>
                                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                        {preview.active_alerts.map((a, i) => (
                                            <span key={i} style={{ display: 'inline-block', padding: '4px 10px', background: 'var(--bg-card)', borderRadius: 'var(--radius)', fontSize: '12px', border: '1px solid var(--border)' }}>
                                                {a.site_name}: <strong>{a.severity}</strong> ({a.streak_days}d)
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {preview.predictive_warnings?.length > 0 && (
                                <div>
                                    <strong style={{ color: 'var(--warning)', fontSize: '13px' }}>📊 Predictive Warnings ({preview.predictive_warnings.length})</strong>
                                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                        {preview.predictive_warnings.map((p, i) => (
                                            <span key={i} style={{ display: 'inline-block', padding: '4px 10px', background: 'var(--bg-card)', borderRadius: 'var(--radius)', fontSize: '12px', border: '1px solid var(--border)' }}>
                                                {p.site_name}: <strong>{p.days_to_critical}d</strong> to critical
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

function SolarScoreTuningSection({ settings, toast, refetchSettings }) {
    const defaults = {
        throttle_soc_threshold: 95,
        throttle_floor_soc: 98,
        throttle_floor_score: 90,
        throttle_panel_min_pct: 10,
        score_excellent: 90,
        score_good: 70,
        score_fair: 50,
    }
    const initial = settings?.solar_score_config || defaults
    const [config, setConfig] = useState(initial)
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (settings?.solar_score_config) setConfig(settings.solar_score_config)
    }, [settings])

    const handleChange = (key, val) => {
        setConfig(c => ({ ...c, [key]: parseFloat(val) || 0 }))
    }

    const handleSave = async () => {
        setSaving(true)
        try {
            await updateSolarScoreSettings(config)
            toast.success('Solar score settings saved')
            if (refetchSettings) refetchSettings()
        } catch (err) {
            toast.error('Error saving: ' + err.message)
        }
        setSaving(false)
    }

    const hasChanges = JSON.stringify(config) !== JSON.stringify(initial)

    const fields = [
        { key: 'throttle_soc_threshold', label: 'Throttle Detection SOC', desc: 'SOC % above which idle/float throttling is detected', unit: '%' },
        { key: 'throttle_floor_soc', label: 'Score Floor SOC', desc: 'SOC % above which minimum score floor applies', unit: '%' },
        { key: 'throttle_floor_score', label: 'Floor Score', desc: 'Minimum score when battery is full + throttled', unit: '%' },
        { key: 'throttle_panel_min_pct', label: 'Panel Health Min', desc: 'Panel output % to confirm system is healthy while throttled', unit: '%' },
        { key: 'score_excellent', label: 'Excellent Threshold', desc: 'Score >= this = "Excellent"', unit: '%' },
        { key: 'score_good', label: 'Good Threshold', desc: 'Score >= this = "Good"', unit: '%' },
        { key: 'score_fair', label: 'Fair Threshold', desc: 'Score >= this = "Fair" (below = "Poor")', unit: '%' },
    ]

    return (
        <div className="settings-card">
            <h2>Solar Score Tuning</h2>
            <p className="settings-desc">
                When batteries are full, the Victron MPPT throttles solar production (idle/float). These settings adjust how the solar score compensates for that throttling.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginTop: 16 }}>
                {fields.map(f => (
                    <div key={f.key} style={{ padding: 12, background: 'var(--bg-primary)', borderRadius: 'var(--radius)' }}>
                        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>{f.label}</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input
                                type="number"
                                min={0}
                                max={100}
                                step={1}
                                value={config[f.key] ?? ''}
                                onChange={e => handleChange(f.key, e.target.value)}
                                style={{ width: 70, padding: '4px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: '0.9rem' }}
                            />
                            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{f.unit}</span>
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 4 }}>{f.desc}</div>
                    </div>
                ))}
            </div>
            <div className="settings-actions" style={{ marginTop: 16 }}>
                <button className="btn btn-primary" onClick={handleSave} disabled={saving || !hasChanges}>
                    {saving ? 'Saving...' : 'Save Settings'}
                </button>
                {hasChanges && <span style={{ fontSize: '0.8rem', color: 'var(--warning)' }}>Unsaved changes</span>}
            </div>
        </div>
    )
}

function Settings() {
    const { user, updateDisplayName } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const isAdmin = user?.role === 'admin'
    const fetchSettingsFn = useCallback(() => fetchSettings(), [])
    const fetchJobSitesFn = useCallback(() => fetchJobSites(), [])
    const { data, loading, refetch } = useApiPolling(fetchSettingsFn, 60000)
    const { data: jobSitesData, refetch: refetchJobSites } = useApiPolling(fetchJobSitesFn, 60000)

    const toast = useToast()
    const [retentionDays, setRetentionDays] = useState(null)
    const [saving, setSaving] = useState(false)
    const [purging, setPurging] = useState(false)
    const [editingSiteId, setEditingSiteId] = useState(null)
    const [editName, setEditName] = useState('')
    const [reclustering, setReclustering] = useState(false)
    const [expandedSite, setExpandedSite] = useState(null)
    const [activeDrag, setActiveDrag] = useState(null)
    const [overJobSiteId, setOverJobSiteId] = useState(null)

    // GPS Verification state
    const [gpsTrailers, setGpsTrailers] = useState(null)
    const [gpsLoading, setGpsLoading] = useState(false)
    const [gpsRefreshing, setGpsRefreshing] = useState(false)
    const [unlinkedDevices, setUnlinkedDevices] = useState([])
    const [linkingTrailerId, setLinkingTrailerId] = useState(null)

    const loadGpsData = async () => {
        setGpsLoading(true)
        try {
            const [gpsData, devData] = await Promise.all([
                fetchGpsTrailers(),
                fetchUnlinkedIc2Devices(),
            ])
            setGpsTrailers(gpsData.trailers || [])
            setUnlinkedDevices(devData.devices || [])
        } catch (err) {
            toast.error('Error loading GPS data: ' + err.message)
        }
        setGpsLoading(false)
    }

    const handleGpsRefresh = async () => {
        setGpsRefreshing(true)
        try {
            const result = await refreshGps()
            toast.success(`GPS refreshed: ${result.updated} devices updated from IC2`)
            await loadGpsData()
            refetchJobSites()
        } catch (err) {
            toast.error('GPS refresh failed: ' + err.message)
        }
        setGpsRefreshing(false)
    }

    const handleLinkDevice = async (siteId, ic2DeviceId) => {
        try {
            await linkIc2Device(siteId, ic2DeviceId)
            toast.success('IC2 device linked successfully')
            setLinkingTrailerId(null)
            await loadGpsData()
        } catch (err) {
            toast.error('Error linking device: ' + err.message)
        }
    }

    // My Profile state
    const [editingProfile, setEditingProfile] = useState(false)
    const [profileName, setProfileName] = useState(user?.display_name || '')
    const [savingProfile, setSavingProfile] = useState(false)

    const handleSaveProfile = async () => {
        if (!profileName.trim()) return
        setSavingProfile(true)
        try {
            await updateDisplayName(profileName.trim())
            toast.success('Display name updated')
            setEditingProfile(false)
        } catch (err) {
            toast.error('Error updating profile: ' + err.message)
        }
        setSavingProfile(false)
    }

    // User Management state (admin only)
    const [users, setUsers] = useState([])
    const [usersLoading, setUsersLoading] = useState(false)
    const [showCreateUser, setShowCreateUser] = useState(false)
    const [newUser, setNewUser] = useState({ username: '', password: '', display_name: '', role: 'viewer' })
    const [creatingUser, setCreatingUser] = useState(false)
    const [resetPwUserId, setResetPwUserId] = useState(null)
    const [resetPwValue, setResetPwValue] = useState('')

    const loadUsers = useCallback(async () => {
        setUsersLoading(true)
        try {
            const data = await fetchUsers()
            setUsers(data.users || [])
        } catch (err) {
            toast.error('Error loading users: ' + err.message)
        }
        setUsersLoading(false)
    }, [toast])

    useEffect(() => {
        if (user?.role === 'admin') loadUsers()
    }, [user, loadUsers])

    const handleCreateUser = async (e) => {
        e.preventDefault()
        if (!newUser.username.trim() || !newUser.password.trim()) return
        setCreatingUser(true)
        try {
            await createUserAccount({
                username: newUser.username.trim(),
                password: newUser.password,
                display_name: newUser.display_name.trim() || null,
                role: newUser.role,
            })
            toast.success(`User "${newUser.username}" created successfully`)
            setNewUser({ username: '', password: '', display_name: '', role: 'viewer' })
            setShowCreateUser(false)
            loadUsers()
        } catch (err) {
            toast.error('Error creating user: ' + err.message)
        }
        setCreatingUser(false)
    }

    const handleRoleChange = async (userId, newRole) => {
        try {
            await updateUserAccount(userId, { role: newRole })
            toast.success('Role updated')
            loadUsers()
        } catch (err) {
            toast.error('Error updating role: ' + err.message)
        }
    }

    const formatLastLogin = (ts) => {
        if (!ts) return 'Never'
        const d = new Date(Number(ts))
        if (isNaN(d.getTime())) return 'Never'
        const now = Date.now()
        const diff = now - d.getTime()
        if (diff < 60000) return 'Just now'
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
        if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}d ago`
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    }

    const handleResetPassword = async (userId) => {
        if (!resetPwValue.trim()) return
        try {
            await resetUserPassword(userId, resetPwValue)
            toast.success('Password reset successfully')
            setResetPwUserId(null)
            setResetPwValue('')
        } catch (err) {
            toast.error('Error resetting password: ' + err.message)
        }
    }

    const handleDeleteUser = async (u) => {
        if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return
        try {
            await deleteUserAccount(u.id)
            toast.success(`User "${u.username}" deleted`)
            loadUsers()
        } catch (err) {
            toast.error('Error deleting user: ' + err.message)
        }
    }

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
    )

    const settings = data || {}
    const jobSites = jobSitesData?.job_sites || []
    const displayRetention = retentionDays ?? settings.retention_days ?? 90

    // Sort job sites: active first, then by name
    const sortedJobSites = useMemo(() => {
        return [...jobSites].sort((a, b) => {
            if (a.status === 'active' && b.status !== 'active') return -1
            if (a.status !== 'active' && b.status === 'active') return 1
            return a.name.localeCompare(b.name, undefined, { numeric: true })
        })
    }, [jobSites])

    const handleSave = async () => {
        setSaving(true)
        try {
            await updateSettings({ retention_days: displayRetention })
            toast.success('Settings saved successfully!')
            refetch()
        } catch (err) {
            toast.error('Error saving settings: ' + err.message)
        }
        setSaving(false)
    }

    const handlePurge = async () => {
        if (!confirm('Are you sure you want to purge old data? This cannot be undone.')) return
        setPurging(true)
        try {
            const result = await purgeData()
            toast.success(`Purge complete. ${result.snapshot_count} snapshots remain.`)
            refetch()
        } catch (err) {
            toast.error('Error purging data: ' + err.message)
        }
        setPurging(false)
    }

    const handleRecluster = async () => {
        if (!confirm('Re-run GPS clustering? This will reassign trailers that are not manually overridden.')) return
        setReclustering(true)
        try {
            const result = await reclusterJobSites()
            toast.success(`Clustering complete. ${result.job_site_count} job sites, ${result.assignments} trailer assignments.`)
            refetchJobSites()
        } catch (err) {
            toast.error('Error reclustering: ' + err.message)
        }
        setReclustering(false)
    }

    const handleSaveSiteName = async (siteId) => {
        if (!editName.trim()) return
        try {
            await updateJobSite(siteId, { name: editName.trim() })
            setEditingSiteId(null)
            setEditName('')
            refetchJobSites()
        } catch (err) {
            toast.error('Error renaming site: ' + err.message)
        }
    }

    const handleStatusChange = async (siteId, newStatus) => {
        try {
            await updateJobSite(siteId, { status: newStatus })
            refetchJobSites()
        } catch (err) {
            toast.error('Error updating status: ' + err.message)
        }
    }

    const handleDateChange = async (siteId, field, value) => {
        try {
            await updateJobSite(siteId, { [field]: value || null })
            refetchJobSites()
        } catch (err) {
            toast.error('Error updating date: ' + err.message)
        }
    }

    const handleToggleHq = async (siteId, currentValue) => {
        try {
            await updateJobSite(siteId, { is_headquarters: !currentValue })
            refetchJobSites()
        } catch (err) {
            toast.error('Error updating HQ status: ' + err.message)
        }
    }

    const handleReassignTrailer = async (trailerId, newJobSiteId) => {
        try {
            await assignTrailer(newJobSiteId, trailerId)
            toast.success('Trailer reassigned successfully')
            refetchJobSites()
        } catch (err) {
            toast.error('Error reassigning trailer: ' + err.message)
        }
    }

    const handleDragStart = (event) => {
        setActiveDrag(event.active.data.current)
    }

    const handleDragOver = (event) => {
        const overId = event.over?.id
        if (overId && String(overId).startsWith('jobsite-')) {
            setOverJobSiteId(parseInt(String(overId).replace('jobsite-', '')))
        } else {
            setOverJobSiteId(null)
        }
    }

    const handleDragEnd = (event) => {
        const { active, over } = event
        setActiveDrag(null)
        setOverJobSiteId(null)
        if (!over) return
        const overId = String(over.id)
        if (!overId.startsWith('jobsite-')) return
        const newJobSiteId = parseInt(overId.replace('jobsite-', ''))
        const trailerId = active.data.current.trailerId
        const fromJobSiteId = active.data.current.fromJobSiteId
        if (newJobSiteId === fromJobSiteId) return
        handleReassignTrailer(trailerId, newJobSiteId)
    }

    const formatBytes = (bytes) => {
        if (!bytes) return '0 B'
        const sizes = ['B', 'KB', 'MB', 'GB']
        const i = Math.floor(Math.log(bytes) / Math.log(1024))
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`
    }

    if (loading && !data) {
        return (
            <div className="settings-page">
                <div className="page-header">
                    <div className="skeleton skeleton-text" style={{ width: 160, height: 28 }}></div>
                    <div className="skeleton skeleton-text" style={{ width: 320, height: 16, marginTop: 8 }}></div>
                </div>
                <div className="settings-grid">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="settings-card skeleton-card">
                            <div className="skeleton skeleton-text" style={{ width: '50%', height: 18 }}></div>
                            <div className="skeleton skeleton-text" style={{ width: '80%', height: 14, marginTop: 12 }}></div>
                            <div className="skeleton skeleton-text" style={{ width: '100%', height: 40, marginTop: 16 }}></div>
                        </div>
                    ))}
                </div>
            </div>
        )
    }

    return (
        <div className="settings-page">
            <div className="page-header">
                <h1>Settings</h1>
                <p className="page-subtitle">Job site management, data retention, and storage</p>
            </div>

            <div className="settings-grid">
                {/* My Profile */}
                <div className="settings-card">
                    <h2>My Profile</h2>
                    <p className="settings-desc">Update your display name. Role and account type are managed by admins.</p>
                    <div className="profile-section">
                        <div className="profile-field">
                            <label>Username</label>
                            <span>{user?.username}</span>
                        </div>
                        <div className="profile-field">
                            <label>Role</label>
                            <span className={`role-badge role-badge-${user?.role}`}>{user?.role}</span>
                        </div>
                        <div className="profile-field">
                            <label>Display Name</label>
                            {editingProfile ? (
                                <div className="inline-edit-compact">
                                    <input
                                        type="text"
                                        value={profileName}
                                        onChange={e => setProfileName(e.target.value)}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') handleSaveProfile()
                                            if (e.key === 'Escape') setEditingProfile(false)
                                        }}
                                        autoFocus
                                    />
                                    <button className="btn btn-sm btn-primary" onClick={handleSaveProfile} disabled={savingProfile}>
                                        {savingProfile ? 'Saving...' : 'Save'}
                                    </button>
                                    <button className="btn btn-sm btn-ghost" onClick={() => setEditingProfile(false)}>Cancel</button>
                                </div>
                            ) : (
                                <span
                                    className="clickable-name"
                                    onClick={() => { setProfileName(user?.display_name || ''); setEditingProfile(true) }}
                                >
                                    {user?.display_name || '—'}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                {/* User Management (admin only) */}
                {user?.role === 'admin' && (
                    <div className="settings-card settings-card-wide">
                        <div className="settings-card-header">
                            <h2>User Management</h2>
                            <button
                                className="btn btn-primary"
                                onClick={() => setShowCreateUser(true)}
                            >
                                + Create User
                            </button>
                        </div>
                        <p className="settings-desc">
                            Manage user accounts, roles, and access. Roles: Admin (full access), Technician (maintenance + fleet), Viewer (read-only).
                            Users with emails can subscribe to daily digest emails.
                        </p>

                        {/* Create User Modal */}
                        {showCreateUser && (
                            <div className="maint-form-overlay" onClick={() => setShowCreateUser(false)}>
                                <div className="maint-form-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
                                    <div className="maint-form-header">
                                        <h2>Create User</h2>
                                        <button className="detail-close" onClick={() => setShowCreateUser(false)}>✕</button>
                                    </div>
                                    <form onSubmit={handleCreateUser} className="maint-form">
                                        <div className="maint-form-grid">
                                            <div className="form-group">
                                                <label>Username *</label>
                                                <input
                                                    type="text"
                                                    value={newUser.username}
                                                    onChange={e => setNewUser(p => ({ ...p, username: e.target.value }))}
                                                    placeholder="username"
                                                    required
                                                    autoFocus
                                                />
                                            </div>
                                            <div className="form-group">
                                                <label>Password *</label>
                                                <input
                                                    type="password"
                                                    value={newUser.password}
                                                    onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))}
                                                    placeholder="password"
                                                    required
                                                />
                                            </div>
                                            <div className="form-group">
                                                <label>Display Name</label>
                                                <input
                                                    type="text"
                                                    value={newUser.display_name}
                                                    onChange={e => setNewUser(p => ({ ...p, display_name: e.target.value }))}
                                                    placeholder="Full Name"
                                                />
                                            </div>
                                            <div className="form-group">
                                                <label>Role</label>
                                                <select
                                                    value={newUser.role}
                                                    onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}
                                                >
                                                    <option value="admin">Admin</option>
                                                    <option value="technician">Technician</option>
                                                    <option value="viewer">Viewer</option>
                                                    <option value="customer">Customer</option>
                                                </select>
                                            </div>
                                        </div>
                                        <div className="maint-form-actions">
                                            <button type="button" className="btn btn-ghost" onClick={() => setShowCreateUser(false)}>Cancel</button>
                                            <button type="submit" className="btn btn-primary" disabled={creatingUser}>
                                                {creatingUser ? 'Creating...' : 'Create User'}
                                            </button>
                                        </div>
                                    </form>
                                </div>
                            </div>
                        )}

                        {/* Users Table */}
                        {usersLoading && users.length === 0 ? (
                            <div className="empty-section"><p>Loading users...</p></div>
                        ) : users.length === 0 ? (
                            <div className="empty-section"><p>No users found.</p></div>
                        ) : (
                            <div className="jobsite-mgmt-table-wrapper">
                                <table className="maint-table">
                                    <thead>
                                        <tr>
                                            <th>Username</th>
                                            <th>Display Name</th>
                                            <th>Email</th>
                                            <th>Role</th>
                                            <th>Digest</th>
                                            <th>Last Login</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {users.map(u => (
                                            <Fragment key={u.id}>
                                                <tr className="maint-row">
                                                    <td className="maint-title">
                                                        {u.username}
                                                        {u.google_id && <span className="sso-badge" title="Google SSO account">G</span>}
                                                    </td>
                                                    <td>{u.display_name || '—'}</td>
                                                    <td style={{ color: 'var(--text-secondary)', fontSize: '0.85em' }}>{u.email || '—'}</td>
                                                    <td>
                                                        <select
                                                            className={`status-select status-select-${u.role === 'admin' ? 'active' : u.role === 'technician' ? 'standby' : 'completed'}`}
                                                            value={u.role}
                                                            onChange={e => handleRoleChange(u.id, e.target.value)}
                                                            disabled={u.id === user.id}
                                                        >
                                                            <option value="admin">Admin</option>
                                                            <option value="technician">Technician</option>
                                                            <option value="viewer">Viewer</option>
                                                            <option value="customer">Customer</option>
                                                        </select>
                                                    </td>
                                                    <td style={{ textAlign: 'center' }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={u.digest_enabled || false}
                                                            onChange={async (e) => {
                                                                try {
                                                                    await updateUserAccount(u.id, { digest_enabled: e.target.checked })
                                                                    toast.success(`Digest ${e.target.checked ? 'enabled' : 'disabled'} for ${u.username}`)
                                                                    loadUsers()
                                                                } catch (err) {
                                                                    toast.error('Error updating digest subscription: ' + err.message)
                                                                }
                                                            }}
                                                            disabled={!u.email}
                                                            title={u.email ? (u.digest_enabled ? 'Subscribed to daily digest' : 'Not subscribed to daily digest') : 'Email required for digest subscription'}
                                                            style={{ cursor: u.email ? 'pointer' : 'not-allowed' }}
                                                        />
                                                    </td>
                                                    <td style={{ fontSize: '0.85em', color: u.last_login ? 'var(--text-secondary)' : 'var(--text-muted)' }} title={u.last_login ? new Date(Number(u.last_login)).toLocaleString() : 'Never logged in'}>
                                                        {formatLastLogin(u.last_login)}
                                                    </td>
                                                    <td className="maint-actions" style={{ display: 'flex', gap: 6 }}>
                                                        {!u.google_id && (
                                                            <button
                                                                className="btn btn-sm btn-secondary"
                                                                onClick={() => { setResetPwUserId(resetPwUserId === u.id ? null : u.id); setResetPwValue('') }}
                                                            >
                                                                Reset PW
                                                            </button>
                                                        )}
                                                        <button
                                                            className="btn btn-sm btn-danger"
                                                            onClick={() => handleDeleteUser(u)}
                                                            disabled={u.id === user.id}
                                                            title="Delete user"
                                                        >
                                                            Delete
                                                        </button>
                                                    </td>
                                                </tr>
                                                {resetPwUserId === u.id && (
                                                    <tr className="maint-row">
                                                        <td colSpan={6}>
                                                            <div className="inline-edit-compact">
                                                                <input
                                                                    type="password"
                                                                    value={resetPwValue}
                                                                    onChange={e => setResetPwValue(e.target.value)}
                                                                    placeholder="New password"
                                                                    autoFocus
                                                                    onKeyDown={e => {
                                                                        if (e.key === 'Enter') handleResetPassword(u.id)
                                                                        if (e.key === 'Escape') { setResetPwUserId(null); setResetPwValue('') }
                                                                    }}
                                                                />
                                                                <button className="btn btn-sm btn-primary" onClick={() => handleResetPassword(u.id)}>Save</button>
                                                                <button className="btn btn-sm btn-ghost" onClick={() => { setResetPwUserId(null); setResetPwValue('') }}>Cancel</button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </Fragment>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                )}

                {/* Customer Accounts */}
                {isAdmin && (
                    <CustomerAccountsSection jobSites={jobSites} toast={toast} loadUsers={loadUsers} />
                )}

                {/* Communication Log */}
                {isAdmin && (
                    <CommunicationLogSection jobSites={jobSites} toast={toast} />
                )}

                {/* Email Digest Settings */}
                {isAdmin && (
                    <DigestSettingsSection toast={toast} />
                )}

                {/* Solar Score Tuning */}
                {isAdmin && (
                    <SolarScoreTuningSection settings={settings} toast={toast} refetchSettings={refetch} />
                )}

                {/* Job Sites Management */}
                <div className="settings-card settings-card-wide">
                    <div className="settings-card-header">
                        <h2>Job Sites</h2>
                        {isAdmin && (
                            <button
                                className="btn btn-secondary"
                                onClick={handleRecluster}
                                disabled={reclustering}
                            >
                                {reclustering ? 'Clustering...' : 'Re-cluster GPS'}
                            </button>
                        )}
                    </div>
                    <p className="settings-desc">
                        Manage construction sites. Trailers are automatically grouped by GPS proximity (300m threshold).
                        Click a name to rename. Expand a site to reassign trailers via dropdown or drag-and-drop.
                    </p>
                    {sortedJobSites.length > 0 ? (
                        <DndContext
                            sensors={sensors}
                            onDragStart={handleDragStart}
                            onDragOver={handleDragOver}
                            onDragEnd={handleDragEnd}
                        >
                            <div className="jobsite-mgmt-table-wrapper">
                                <table className="jobsite-mgmt-table">
                                    <thead>
                                        <tr>
                                            <th>Name</th>
                                            <th>Trailers</th>
                                            <th>Status</th>
                                            <th>Delivery</th>
                                            <th>Active</th>
                                            <th>Call-off</th>
                                            <th>Pickup</th>
                                            <th>Geofence</th>
                                            <th>Address</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {sortedJobSites.map(js => {
                                            const isExpanded = expandedSite === js.id
                                            const trailers = js.trailers || []
                                            const isDropTarget = overJobSiteId === js.id && activeDrag?.fromJobSiteId !== js.id
                                            return (
                                                <Fragment key={js.id}>
                                                    <DroppableJobSiteRow jobSiteId={js.id} isOver={isDropTarget}>
                                                        <td className={`jobsite-mgmt-name jobsite-mgmt-${js.status}`}>
                                                            {editingSiteId === js.id ? (
                                                                <div className="inline-edit-compact">
                                                                    <input
                                                                        type="text"
                                                                        value={editName}
                                                                        onChange={e => setEditName(e.target.value)}
                                                                        onKeyDown={e => {
                                                                            if (e.key === 'Enter') handleSaveSiteName(js.id)
                                                                            if (e.key === 'Escape') setEditingSiteId(null)
                                                                        }}
                                                                        autoFocus
                                                                    />
                                                                    <button onClick={() => handleSaveSiteName(js.id)} className="btn btn-sm">Save</button>
                                                                    <button onClick={() => setEditingSiteId(null)} className="btn btn-sm btn-ghost">Cancel</button>
                                                                </div>
                                                            ) : (
                                                                <span
                                                                    className={canEdit ? 'clickable-name' : ''}
                                                                    onClick={canEdit ? () => { setEditingSiteId(js.id); setEditName(js.name) } : undefined}
                                                                    title={canEdit ? 'Click to rename' : undefined}
                                                                >
                                                                    {js.name}
                                                                </span>
                                                            )}
                                                            {js.is_headquarters && <span className="hq-badge">HQ</span>}
                                                            {!js.is_headquarters && user?.role === 'admin' && (
                                                                <button
                                                                    className="btn-hq-toggle"
                                                                    onClick={() => handleToggleHq(js.id, js.is_headquarters)}
                                                                    title="Mark as headquarters"
                                                                >
                                                                    set HQ
                                                                </button>
                                                            )}
                                                            {js.is_headquarters && user?.role === 'admin' && (
                                                                <button
                                                                    className="btn-hq-toggle"
                                                                    onClick={() => handleToggleHq(js.id, js.is_headquarters)}
                                                                    title="Remove headquarters flag"
                                                                >
                                                                    unset
                                                                </button>
                                                            )}
                                                        </td>
                                                        <td className="jobsite-mgmt-trailers">
                                                            <span
                                                                className="trailer-count-badge clickable"
                                                                onClick={() => setExpandedSite(isExpanded ? null : js.id)}
                                                                title="Click to expand trailers"
                                                            >
                                                                {js.trailer_count} {isExpanded ? '▾' : '▸'}
                                                            </span>
                                                        </td>
                                                        <td>
                                                            <select
                                                                className={`status-select status-select-${js.status}`}
                                                                value={js.status}
                                                                onChange={e => handleStatusChange(js.id, e.target.value)}
                                                                disabled={!canEdit}
                                                            >
                                                                <option value="active">Active</option>
                                                                <option value="standby">Standby</option>
                                                                <option value="completed">Completed</option>
                                                            </select>
                                                        </td>
                                                        <td className="jobsite-mgmt-date">
                                                            <input
                                                                type="date"
                                                                className="date-input" disabled={!canEdit}
                                                                value={js.delivery_date ? js.delivery_date.split('T')[0] : ''}
                                                                onChange={e => handleDateChange(js.id, 'delivery_date', e.target.value)}
                                                            />
                                                        </td>
                                                        <td className="jobsite-mgmt-date">
                                                            <input
                                                                type="date"
                                                                className="date-input" disabled={!canEdit}
                                                                value={js.active_date ? js.active_date.split('T')[0] : ''}
                                                                onChange={e => handleDateChange(js.id, 'active_date', e.target.value)}
                                                            />
                                                        </td>
                                                        <td className="jobsite-mgmt-date">
                                                            <input
                                                                type="date"
                                                                className="date-input" disabled={!canEdit}
                                                                value={js.calloff_date ? js.calloff_date.split('T')[0] : ''}
                                                                onChange={e => handleDateChange(js.id, 'calloff_date', e.target.value)}
                                                            />
                                                        </td>
                                                        <td className="jobsite-mgmt-date">
                                                            <input
                                                                type="date"
                                                                className="date-input" disabled={!canEdit}
                                                                value={js.pickup_date ? js.pickup_date.split('T')[0] : ''}
                                                                onChange={e => handleDateChange(js.id, 'pickup_date', e.target.value)}
                                                            />
                                                        </td>
                                                        <td className="jobsite-mgmt-date">
                                                            <input
                                                                type="number"
                                                                className="date-input"
                                                                style={{ width: 80 }}
                                                                disabled={!canEdit}
                                                                min={100}
                                                                max={5000}
                                                                step={100}
                                                                value={js.geofence_radius_m || 500}
                                                                onChange={e => {
                                                                    const val = parseInt(e.target.value)
                                                                    if (!isNaN(val) && val >= 100) {
                                                                        updateJobSite(js.id, { geofence_radius_m: val })
                                                                            .then(() => refetchJobSites())
                                                                    }
                                                                }}
                                                            />
                                                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>m</span>
                                                        </td>
                                                        <td className="jobsite-mgmt-address">
                                                            {js.address || '—'}
                                                        </td>
                                                    </DroppableJobSiteRow>
                                                    {isExpanded && trailers.map(t => (
                                                        <DraggableTrailerRow key={t.site_id} trailer={t} jobSite={js}>
                                                            <td className="trailer-assign-name">⠿ {t.site_name}</td>
                                                            <td colSpan={8}>
                                                                <select
                                                                    className="reassign-select"
                                                                    value={js.id}
                                                                    onChange={e => handleReassignTrailer(t.site_id, parseInt(e.target.value))}
                                                                    onClick={e => e.stopPropagation()}
                                                                    disabled={!canEdit}
                                                                >
                                                                    {sortedJobSites.map(target => (
                                                                        <option key={target.id} value={target.id}>
                                                                            {target.name}
                                                                        </option>
                                                                    ))}
                                                                </select>
                                                            </td>
                                                        </DraggableTrailerRow>
                                                    ))}
                                                </Fragment>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                            <DragOverlay>
                                {activeDrag ? (
                                    <div className="drag-overlay-trailer">
                                        {activeDrag.trailerName}
                                    </div>
                                ) : null}
                            </DragOverlay>
                        </DndContext>
                    ) : (
                        <div className="empty-section">
                            <p>No job sites yet. Sites are created automatically after the first VRM poll with GPS data.</p>
                        </div>
                    )}
                </div>

                {/* GPS Verification */}
                <div className="settings-card settings-card-wide">
                    <div className="settings-card-header">
                        <h2>GPS Verification</h2>
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button className="btn btn-secondary" onClick={loadGpsData} disabled={gpsLoading}>
                                {gpsLoading ? 'Loading...' : 'Check GPS'}
                            </button>
                            {canEdit && (
                                <button className="btn btn-primary" onClick={handleGpsRefresh} disabled={gpsRefreshing}>
                                    {gpsRefreshing ? 'Refreshing...' : 'Refresh from IC2'}
                                </button>
                            )}
                        </div>
                    </div>
                    <p className="settings-desc">
                        GPS coordinates are sourced from IC2 Peplink routers. Click "Check GPS" to compare database vs live coordinates.
                        "Refresh from IC2" will re-fetch all GPS from Peplink devices and re-run clustering.
                    </p>
                    {gpsTrailers && (
                        <div className="jobsite-mgmt-table-wrapper">
                            <table className="maint-table">
                                <thead>
                                    <tr>
                                        <th>Trailer</th>
                                        <th>IC2 Device</th>
                                        <th>DB Latitude</th>
                                        <th>DB Longitude</th>
                                        <th>IC2 Latitude</th>
                                        <th>IC2 Longitude</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {gpsTrailers.map(t => {
                                        const hasDb = t.db_latitude != null && t.db_longitude != null
                                        const hasIc2 = t.ic2_latitude != null && t.ic2_longitude != null
                                        const mismatch = hasDb && hasIc2 && (
                                            Math.abs(t.db_latitude - t.ic2_latitude) > 0.001 ||
                                            Math.abs(t.db_longitude - t.ic2_longitude) > 0.001
                                        )
                                        const noGps = !hasDb && !hasIc2
                                        return (
                                            <tr key={t.site_id} style={mismatch ? { background: 'rgba(231, 76, 60, 0.1)' } : noGps ? { opacity: 0.5 } : {}}>
                                                <td>
                                                    <strong>{t.site_name}</strong>
                                                    {!t.ic2_online && <span style={{ color: 'var(--text-muted)', fontSize: '11px', marginLeft: '6px' }}>offline</span>}
                                                </td>
                                                <td>
                                                    {t.ic2_device_id ? (
                                                        <span style={{ fontFamily: 'monospace', fontSize: '12px' }}>{t.ic2_device_id}</span>
                                                    ) : linkingTrailerId === t.site_id ? (
                                                        <select
                                                            style={{ fontSize: '12px', maxWidth: '160px' }}
                                                            onChange={e => { if (e.target.value) handleLinkDevice(t.site_id, parseInt(e.target.value)) }}
                                                            autoFocus
                                                            onBlur={() => setLinkingTrailerId(null)}
                                                        >
                                                            <option value="">Select device...</option>
                                                            {unlinkedDevices.map(d => (
                                                                <option key={d.id} value={d.id}>{d.name} ({d.id})</option>
                                                            ))}
                                                        </select>
                                                    ) : (
                                                        canEdit ? <button className="btn btn-sm btn-ghost" onClick={() => setLinkingTrailerId(t.site_id)}>
                                                            Link
                                                        </button> : <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>—</span>
                                                    )}
                                                </td>
                                                <td>{hasDb ? t.db_latitude.toFixed(5) : '—'}</td>
                                                <td>{hasDb ? t.db_longitude.toFixed(5) : '—'}</td>
                                                <td style={mismatch ? { color: 'var(--warning)', fontWeight: 600 } : {}}>{hasIc2 ? t.ic2_latitude.toFixed(5) : '—'}</td>
                                                <td style={mismatch ? { color: 'var(--warning)', fontWeight: 600 } : {}}>{hasIc2 ? t.ic2_longitude.toFixed(5) : '—'}</td>
                                                <td>
                                                    {mismatch && <span className="health-grade grade-D">Mismatch</span>}
                                                    {!mismatch && hasDb && hasIc2 && <span className="health-grade grade-A">OK</span>}
                                                    {noGps && <span className="health-grade grade-F">No GPS</span>}
                                                    {!noGps && !hasIc2 && hasDb && <span className="health-grade grade-C">DB Only</span>}
                                                    {!noGps && hasIc2 && !hasDb && <span className="health-grade grade-C">IC2 Only</span>}
                                                    {t.gps_stale && hasDb && <span style={{ color: 'var(--text-muted)', fontSize: '11px', marginLeft: '6px' }}>stale</span>}
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                            <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '8px' }}>
                                {gpsTrailers.length} trailers — {gpsTrailers.filter(t => t.ic2_latitude != null).length} with IC2 GPS,{' '}
                                {gpsTrailers.filter(t => t.db_latitude != null && t.ic2_latitude != null && (Math.abs(t.db_latitude - t.ic2_latitude) > 0.001 || Math.abs(t.db_longitude - t.ic2_longitude) > 0.001)).length} mismatches
                            </p>
                        </div>
                    )}
                </div>

                {/* Database Info */}
                <div className="settings-card">
                    <h2>Database Status</h2>
                    <div className="settings-stats">
                        <div className="settings-stat">
                            <span className="stat-label">Database Size</span>
                            <span className="stat-value-large">{formatBytes(settings.db_size_bytes)}</span>
                        </div>
                        <div className="settings-stat">
                            <span className="stat-label">Total Snapshots</span>
                            <span className="stat-value-large">{(settings.snapshot_count || 0).toLocaleString()}</span>
                        </div>
                        <div className="settings-stat">
                            <span className="stat-label">Retention Period</span>
                            <span className="stat-value-large">{settings.retention_days} days</span>
                        </div>
                    </div>
                </div>

                {/* Retention Settings — admin only */}
                {isAdmin && (
                    <div className="settings-card">
                        <h2>Data Retention</h2>
                        <p className="settings-desc">
                            Set how long historical data is kept. Older records are automatically pruned.
                        </p>
                        <div className="retention-options">
                            {[7, 30, 90, 180, 365].map(days => (
                                <button
                                    key={days}
                                    className={`retention-btn ${displayRetention === days ? 'active' : ''}`}
                                    onClick={() => setRetentionDays(days)}
                                >
                                    {days} days
                                </button>
                            ))}
                        </div>
                        <div className="settings-actions">
                            <button
                                className="btn btn-primary"
                                onClick={handleSave}
                                disabled={saving}
                            >
                                {saving ? 'Saving...' : 'Save Settings'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Documentation */}
                <div className="settings-card">
                    <h2>📚 Documentation & Help</h2>
                    <p className="settings-desc">
                        Complete guide to the Intelligence Analysis & Alerting System, including energy deficit detection,
                        solar performance scoring, action queue, morning digest, and troubleshooting scenarios.
                    </p>
                    <div className="settings-actions">
                        <Link to="/help" className="btn btn-primary" style={{ textDecoration: 'none' }}>
                            📖 View Documentation
                        </Link>
                    </div>
                </div>

                {/* Danger Zone — admin only */}
                {isAdmin && (
                    <div className="settings-card settings-card-danger">
                        <h2>Storage Management</h2>
                        <p className="settings-desc">
                            Manually purge data older than the current retention period.
                        </p>
                        <div className="settings-actions">
                            <button
                                className="btn btn-danger"
                                onClick={handlePurge}
                                disabled={purging}
                            >
                                {purging ? 'Purging...' : 'Purge Old Data'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

        </div>
    )
}

export default Settings
