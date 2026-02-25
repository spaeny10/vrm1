import { useState, useCallback, useMemo } from 'react'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchSettings, updateSettings, purgeData, fetchJobSites, updateJobSite, reclusterJobSites } from '../api/vrm'

function Settings() {
    const fetchSettingsFn = useCallback(() => fetchSettings(), [])
    const fetchJobSitesFn = useCallback(() => fetchJobSites(), [])
    const { data, loading, refetch } = useApiPolling(fetchSettingsFn, 60000)
    const { data: jobSitesData, refetch: refetchJobSites } = useApiPolling(fetchJobSitesFn, 60000)

    const [retentionDays, setRetentionDays] = useState(null)
    const [saving, setSaving] = useState(false)
    const [purging, setPurging] = useState(false)
    const [message, setMessage] = useState('')
    const [editingSiteId, setEditingSiteId] = useState(null)
    const [editName, setEditName] = useState('')
    const [reclustering, setReclustering] = useState(false)

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
        setMessage('')
        try {
            await updateSettings({ retention_days: displayRetention })
            setMessage('Settings saved successfully!')
            refetch()
        } catch (err) {
            setMessage('Error saving settings: ' + err.message)
        }
        setSaving(false)
    }

    const handlePurge = async () => {
        if (!confirm('Are you sure you want to purge old data? This cannot be undone.')) return
        setPurging(true)
        setMessage('')
        try {
            const result = await purgeData()
            setMessage(`Purge complete. ${result.snapshot_count} snapshots remain.`)
            refetch()
        } catch (err) {
            setMessage('Error purging data: ' + err.message)
        }
        setPurging(false)
    }

    const handleRecluster = async () => {
        if (!confirm('Re-run GPS clustering? This will reassign trailers that are not manually overridden.')) return
        setReclustering(true)
        setMessage('')
        try {
            const result = await reclusterJobSites()
            setMessage(`Clustering complete. ${result.job_site_count} job sites, ${result.assignments} trailer assignments.`)
            refetchJobSites()
        } catch (err) {
            setMessage('Error reclustering: ' + err.message)
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
            setMessage('Error renaming site: ' + err.message)
        }
    }

    const handleStatusChange = async (siteId, newStatus) => {
        try {
            await updateJobSite(siteId, { status: newStatus })
            refetchJobSites()
        } catch (err) {
            setMessage('Error updating status: ' + err.message)
        }
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
                        Manage construction sites. Trailers are automatically grouped by GPS proximity (200m threshold).
                        Click a name to rename it.
                    </p>
                    {sortedJobSites.length > 0 ? (
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
                                    {sortedJobSites.map(js => (
                                        <tr key={js.id} className={`jobsite-mgmt-row jobsite-mgmt-${js.status}`}>
                                            <td className="jobsite-mgmt-name">
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
                                                <span className="trailer-count-badge">{js.trailer_count}</span>
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
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
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

            {message && (
                <div className={`settings-message ${message.includes('Error') ? 'error' : 'success'}`}>
                    {message}
                </div>
            )}
        </div>
    )
}

export default Settings
