import { useState, useCallback, useMemo } from 'react'
import { useApiPolling } from '../hooks/useApiPolling'
import {
    fetchMaintenanceLogs, fetchMaintenanceStats, fetchJobSites,
    createMaintenanceLog, updateMaintenanceLog, deleteMaintenanceLog
} from '../api/vrm'
import MaintenanceForm from '../components/MaintenanceForm'

const STATUS_TABS = [
    { key: 'all', label: 'All' },
    { key: 'scheduled', label: 'Scheduled' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'completed', label: 'Completed' },
]

const TYPE_LABELS = {
    inspection: 'Inspection',
    repair: 'Repair',
    scheduled: 'Scheduled',
    emergency: 'Emergency',
    installation: 'Installation',
    decommission: 'Decommission',
}

function formatDate(ts) {
    if (!ts) return '—'
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatCost(cents) {
    if (!cents) return '$0'
    return `$${(cents / 100).toFixed(2)}`
}

function MaintenancePage() {
    const [statusFilter, setStatusFilter] = useState('all')
    const [searchTerm, setSearchTerm] = useState('')
    const [showForm, setShowForm] = useState(false)
    const [editingLog, setEditingLog] = useState(null)

    const fetchLogsFn = useCallback(() => fetchMaintenanceLogs(), [])
    const fetchStatsFn = useCallback(() => fetchMaintenanceStats(), [])
    const fetchJobSitesFn = useCallback(() => fetchJobSites(), [])

    const { data: logsData, loading: logsLoading, refetch: refetchLogs } = useApiPolling(fetchLogsFn, 60000)
    const { data: statsData, refetch: refetchStats } = useApiPolling(fetchStatsFn, 60000)
    const { data: jobSitesData } = useApiPolling(fetchJobSitesFn, 60000)

    const logs = logsData?.logs || []
    const stats = statsData?.stats || {}
    const jobSites = jobSitesData?.job_sites || []

    // Filter logs
    const filteredLogs = useMemo(() => {
        let result = [...logs]
        if (statusFilter !== 'all') {
            result = result.filter(l => l.status === statusFilter)
        }
        if (searchTerm) {
            const term = searchTerm.toLowerCase()
            result = result.filter(l =>
                l.title.toLowerCase().includes(term) ||
                (l.job_site_name || '').toLowerCase().includes(term) ||
                (l.trailer_name || '').toLowerCase().includes(term) ||
                (l.technician || '').toLowerCase().includes(term)
            )
        }
        return result
    }, [logs, statusFilter, searchTerm])

    // Group by job site
    const groupedLogs = useMemo(() => {
        const groups = new Map()
        const ungrouped = []
        for (const log of filteredLogs) {
            if (log.job_site_id && log.job_site_name) {
                if (!groups.has(log.job_site_id)) {
                    groups.set(log.job_site_id, { name: log.job_site_name, logs: [] })
                }
                groups.get(log.job_site_id).logs.push(log)
            } else {
                ungrouped.push(log)
            }
        }
        const sorted = [...groups.entries()]
            .sort(([, a], [, b]) => a.name.localeCompare(b.name, undefined, { numeric: true }))
            .map(([id, g]) => ({ jobSiteId: id, ...g }))
        return { groups: sorted, ungrouped }
    }, [filteredLogs])

    const handleSave = async (formData) => {
        if (editingLog) {
            await updateMaintenanceLog(editingLog.id, formData)
        } else {
            await createMaintenanceLog(formData)
        }
        setShowForm(false)
        setEditingLog(null)
        refetchLogs()
        refetchStats()
    }

    const handleDelete = async (id) => {
        if (!confirm('Cancel this maintenance log?')) return
        await deleteMaintenanceLog(id)
        refetchLogs()
        refetchStats()
    }

    const handleEdit = (log) => {
        setEditingLog(log)
        setShowForm(true)
    }

    const statusBadge = (status) => {
        const colors = {
            scheduled: 'blue',
            in_progress: 'yellow',
            completed: 'green',
            cancelled: 'gray',
        }
        return (
            <span className={`maint-status-badge maint-status-${colors[status] || 'gray'}`}>
                {status === 'in_progress' ? 'In Progress' : status.charAt(0).toUpperCase() + status.slice(1)}
            </span>
        )
    }

    if (logsLoading && !logsData) {
        return (
            <div className="page-loading">
                <div className="spinner"></div>
                <p>Loading maintenance data...</p>
            </div>
        )
    }

    return (
        <div className="maintenance-page">
            <div className="page-header">
                <h1>Maintenance</h1>
                <p className="page-subtitle">Service logs, inspections, and repair tracking</p>
            </div>

            {/* KPI Row */}
            <div className="kpi-row">
                <div className="kpi-card kpi-blue">
                    <div className="kpi-label">Open Items</div>
                    <div className="kpi-value">{stats.open_count || 0}</div>
                </div>
                <div className="kpi-card kpi-yellow">
                    <div className="kpi-label">Scheduled This Week</div>
                    <div className="kpi-value">{stats.upcoming_week || 0}</div>
                </div>
                <div className="kpi-card kpi-red">
                    <div className="kpi-label">Overdue</div>
                    <div className="kpi-value">{stats.overdue_count || 0}</div>
                </div>
                <div className="kpi-card kpi-green">
                    <div className="kpi-label">Cost MTD</div>
                    <div className="kpi-value">{formatCost(stats.cost_mtd_cents)}</div>
                </div>
            </div>

            {/* Controls */}
            <div className="fleet-controls">
                <div className="search-box">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                        type="text"
                        placeholder="Search logs..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>

                <div className="maint-tabs">
                    {STATUS_TABS.map(tab => (
                        <button
                            key={tab.key}
                            className={`maint-tab ${statusFilter === tab.key ? 'active' : ''}`}
                            onClick={() => setStatusFilter(tab.key)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                <button className="btn btn-primary" onClick={() => { setEditingLog(null); setShowForm(true) }}>
                    + New Log
                </button>
            </div>

            {/* Maintenance Logs Table */}
            <div className="maint-table-section">
                {groupedLogs.groups.length === 0 && groupedLogs.ungrouped.length === 0 ? (
                    <div className="empty-section">
                        <p>{filteredLogs.length === 0 && logs.length > 0
                            ? 'No logs match your filters'
                            : 'No maintenance logs yet. Click "+ New Log" to create one.'}</p>
                    </div>
                ) : (
                    <div className="maint-groups">
                        {groupedLogs.groups.map(group => (
                            <div key={group.jobSiteId} className="maint-group">
                                <div className="maint-group-header">
                                    <h3>{group.name}</h3>
                                    <span className="maint-group-count">{group.logs.length} log{group.logs.length !== 1 ? 's' : ''}</span>
                                </div>
                                <table className="maint-table">
                                    <thead>
                                        <tr>
                                            <th>Date</th>
                                            <th>Title</th>
                                            <th>Type</th>
                                            <th>Trailer</th>
                                            <th>Technician</th>
                                            <th>Cost</th>
                                            <th>Status</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {group.logs.map(log => (
                                            <tr key={log.id} className="maint-row" onClick={() => handleEdit(log)}>
                                                <td className="maint-date">{formatDate(log.scheduled_date || log.created_at)}</td>
                                                <td className="maint-title">{log.title}</td>
                                                <td><span className="maint-type-badge">{TYPE_LABELS[log.visit_type] || log.visit_type}</span></td>
                                                <td className="maint-trailer">{log.trailer_name || '—'}</td>
                                                <td className="maint-tech">{log.technician || '—'}</td>
                                                <td className="maint-cost">{formatCost(log.labor_cost_cents + log.parts_cost_cents)}</td>
                                                <td>{statusBadge(log.status)}</td>
                                                <td className="maint-actions">
                                                    <button
                                                        className="maint-delete-btn"
                                                        onClick={(e) => { e.stopPropagation(); handleDelete(log.id) }}
                                                        title="Cancel log"
                                                    >
                                                        ✕
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ))}

                        {groupedLogs.ungrouped.length > 0 && (
                            <div className="maint-group">
                                <div className="maint-group-header">
                                    <h3>Unassigned</h3>
                                    <span className="maint-group-count">{groupedLogs.ungrouped.length}</span>
                                </div>
                                <table className="maint-table">
                                    <thead>
                                        <tr>
                                            <th>Date</th>
                                            <th>Title</th>
                                            <th>Type</th>
                                            <th>Technician</th>
                                            <th>Cost</th>
                                            <th>Status</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {groupedLogs.ungrouped.map(log => (
                                            <tr key={log.id} className="maint-row" onClick={() => handleEdit(log)}>
                                                <td className="maint-date">{formatDate(log.scheduled_date || log.created_at)}</td>
                                                <td className="maint-title">{log.title}</td>
                                                <td><span className="maint-type-badge">{TYPE_LABELS[log.visit_type] || log.visit_type}</span></td>
                                                <td className="maint-tech">{log.technician || '—'}</td>
                                                <td className="maint-cost">{formatCost(log.labor_cost_cents + log.parts_cost_cents)}</td>
                                                <td>{statusBadge(log.status)}</td>
                                                <td className="maint-actions">
                                                    <button
                                                        className="maint-delete-btn"
                                                        onClick={(e) => { e.stopPropagation(); handleDelete(log.id) }}
                                                        title="Cancel log"
                                                    >
                                                        ✕
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* New/Edit Form Modal */}
            {showForm && (
                <MaintenanceForm
                    log={editingLog}
                    jobSites={jobSites}
                    onSave={handleSave}
                    onClose={() => { setShowForm(false); setEditingLog(null) }}
                />
            )}
        </div>
    )
}

export default MaintenancePage
