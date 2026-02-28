import { Fragment, useState, useCallback, useMemo } from 'react'
import { DndContext, PointerSensor, useSensors, useSensor, useDraggable, useDroppable, DragOverlay } from '@dnd-kit/core'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchSettings, updateSettings, purgeData, fetchJobSites, updateJobSite, reclusterJobSites, assignTrailer } from '../api/vrm'
import { useToast } from '../components/ToastProvider'

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

function Settings() {
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
            <div className="page-loading">
                <div className="spinner"></div>
                <p>Loading settings...</p>
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
                {/* Job Sites Management */}
                <div className="settings-card settings-card-wide">
                    <div className="settings-card-header">
                        <h2>Job Sites</h2>
                        <button
                            className="btn btn-secondary"
                            onClick={handleRecluster}
                            disabled={reclustering}
                        >
                            {reclustering ? 'Clustering...' : 'Re-cluster GPS'}
                        </button>
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
                                                                    className="clickable-name"
                                                                    onClick={() => { setEditingSiteId(js.id); setEditName(js.name) }}
                                                                    title="Click to rename"
                                                                >
                                                                    {js.name}
                                                                </span>
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
                                                            >
                                                                <option value="active">Active</option>
                                                                <option value="standby">Standby</option>
                                                                <option value="completed">Completed</option>
                                                            </select>
                                                        </td>
                                                        <td className="jobsite-mgmt-address">
                                                            {js.address || '—'}
                                                        </td>
                                                    </DroppableJobSiteRow>
                                                    {isExpanded && trailers.map(t => (
                                                        <DraggableTrailerRow key={t.site_id} trailer={t} jobSite={js}>
                                                            <td className="trailer-assign-name">⠿ {t.site_name}</td>
                                                            <td colSpan={3}>
                                                                <select
                                                                    className="reassign-select"
                                                                    value={js.id}
                                                                    onChange={e => handleReassignTrailer(t.site_id, parseInt(e.target.value))}
                                                                    onClick={e => e.stopPropagation()}
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

                {/* Retention Settings */}
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

                {/* Danger Zone */}
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
            </div>

        </div>
    )
}

export default Settings
