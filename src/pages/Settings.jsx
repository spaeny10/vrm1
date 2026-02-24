import { useState, useCallback } from 'react'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchSettings, updateSettings, purgeData } from '../api/vrm'

function Settings() {
    const fetchSettingsFn = useCallback(() => fetchSettings(), [])
    const { data, loading, refetch } = useApiPolling(fetchSettingsFn, 60000)

    const [retentionDays, setRetentionDays] = useState(null)
    const [saving, setSaving] = useState(false)
    const [purging, setPurging] = useState(false)
    const [message, setMessage] = useState('')

    const settings = data || {}
    const displayRetention = retentionDays ?? settings.retention_days ?? 90

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
                <p className="page-subtitle">Data retention and storage management</p>
            </div>

            <div className="settings-grid">
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
