import { Fragment, useState, useCallback, useMemo, useEffect } from 'react'
import { DndContext, PointerSensor, useSensors, useSensor, useDraggable, useDroppable, DragOverlay } from '@dnd-kit/core'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchSettings, updateSettings, purgeData, fetchJobSites, updateJobSite, reclusterJobSites, assignTrailer, fetchUsers, createUserAccount, updateUserAccount, deleteUserAccount, resetUserPassword, fetchGpsTrailers, refreshGps, fetchUnlinkedIc2Devices, linkIc2Device, fetchCustomerSiteAccess, updateCustomerSiteAccess, fetchDigestPreview, updateSolarScoreSettings } from '../api/vrm'
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

function CustomerAccountsSection({ jobSites, toast, loadUsers }) {
    const [customers, setCustomers] = useState([])
    const [loading, setLoading] = useState(true)
    const [showCreate, setShowCreate] = useState(false)
    const [newCustomer, setNewCustomer] = useState({ username: '', password: '', display_name: '', email: '' })
    const [creating, setCreating] = useState(false)
    const [editingSites, setEditingSites] = useState(null) // userId
    const [selectedSites, setSelectedSites] = useState([])

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

            {editingSites && (
                <div className="maint-form-overlay" onClick={() => setEditingSites(null)}>
                    <div className="maint-form-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
                        <div className="maint-form-header">
                            <h2>Assign Sites</h2>
                            <button className="detail-close" onClick={() => setEditingSites(null)}>✕</button>
                        </div>
                        <div style={{ padding: '16px 24px', maxHeight: 400, overflowY: 'auto' }}>
                            {jobSites.filter(js => js.status === 'active').map(js => (
                                <label key={js.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                                    <input type="checkbox" checked={selectedSites.includes(js.id)} onChange={() => toggleSite(js.id)} />
                                    <span>{js.name}</span>
                                    {js.address && <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>{js.address}</span>}
                                </label>
                            ))}
                        </div>
                        <div className="maint-form-actions">
                            <button className="btn btn-ghost" onClick={() => setEditingSites(null)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleSaveSites}>Save ({selectedSites.length} sites)</button>
                        </div>
                    </div>
                </div>
            )}

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
    const [preview, setPreview] = useState(null)
    const [loadingPreview, setLoadingPreview] = useState(false)

    const handlePreview = async () => {
        setLoadingPreview(true)
        try {
            const data = await fetchDigestPreview()
            setPreview(data.digest)
        } catch (err) {
            toast.error('Error loading preview: ' + err.message)
        }
        setLoadingPreview(false)
    }

    return (
        <div className="settings-card">
            <h2>Email Digest</h2>
            <p className="settings-desc">
                Automated daily fleet digests are configured via environment variables on the server.
                Set <code>DIGEST_ENABLED=true</code>, <code>DIGEST_TIME=06:00</code>, <code>DIGEST_RECIPIENTS=email@example.com</code>, and <code>DIGEST_TIMEZONE=America/Denver</code>.
            </p>
            <div className="settings-actions">
                <button className="btn btn-secondary" onClick={handlePreview} disabled={loadingPreview}>
                    {loadingPreview ? 'Loading...' : 'Preview Digest Data'}
                </button>
            </div>
            {preview && (
                <div style={{ marginTop: 16, padding: 16, background: 'var(--bg-primary)', borderRadius: 'var(--radius)', fontSize: '0.85rem' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
                        <div><span style={{ color: 'var(--text-muted)' }}>Fleet Size</span><br /><strong>{preview.fleet_size}</strong></div>
                        <div><span style={{ color: 'var(--text-muted)' }}>Avg SOC</span><br /><strong>{preview.avg_soc?.toFixed(1)}%</strong></div>
                        <div><span style={{ color: 'var(--text-muted)' }}>Total Yield</span><br /><strong>{preview.total_yield_kwh?.toFixed(1)} kWh</strong></div>
                    </div>
                    {preview.trailers_below_50_soc?.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                            <strong style={{ color: 'var(--warning)' }}>Low SOC Trailers ({preview.trailers_below_50_soc.length}):</strong>
                            <div style={{ marginTop: 4 }}>
                                {preview.trailers_below_50_soc.map((t, i) => (
                                    <span key={i} style={{ display: 'inline-block', padding: '2px 8px', margin: '2px 4px 2px 0', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', fontSize: '12px' }}>
                                        {t.site_name}: {t.battery_soc?.toFixed(1)}%
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    {preview.active_alerts?.length > 0 && (
                        <div style={{ marginBottom: 12 }}>
                            <strong style={{ color: 'var(--danger)' }}>Active Alerts ({preview.active_alerts.length}):</strong>
                            <div style={{ marginTop: 4 }}>
                                {preview.active_alerts.map((a, i) => (
                                    <span key={i} style={{ display: 'inline-block', padding: '2px 8px', margin: '2px 4px 2px 0', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', fontSize: '12px' }}>
                                        {a.site_name}: {a.severity} ({a.streak_days}d)
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    {preview.predictive_warnings?.length > 0 && (
                        <div>
                            <strong style={{ color: 'var(--warning)' }}>Predictive Warnings ({preview.predictive_warnings.length}):</strong>
                            <div style={{ marginTop: 4 }}>
                                {preview.predictive_warnings.map((p, i) => (
                                    <span key={i} style={{ display: 'inline-block', padding: '2px 8px', margin: '2px 4px 2px 0', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', fontSize: '12px' }}>
                                        {p.site_name}: {p.days_to_critical}d to critical
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
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

    const handleToggleActive = async (u) => {
        try {
            await updateUserAccount(u.id, { is_active: !u.is_active })
            toast.success(u.is_active ? 'User deactivated' : 'User activated')
            loadUsers()
        } catch (err) {
            toast.error('Error updating user: ' + err.message)
        }
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
                    {[1,2,3].map(i => (
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
                                            <th>Active</th>
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
                                                    <td>
                                                        <button
                                                            className={`btn btn-sm ${u.is_active ? 'btn-primary' : 'btn-ghost'}`}
                                                            onClick={() => handleToggleActive(u)}
                                                            disabled={u.id === user.id}
                                                            title={u.is_active ? 'Click to deactivate' : 'Click to activate'}
                                                        >
                                                            {u.is_active ? 'Active' : 'Inactive'}
                                                        </button>
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
