import { useState, useCallback, useMemo, useEffect } from 'react'
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useToast } from '../components/ToastProvider'
import {
    fetchMaintenanceLogs, fetchMaintenanceStats, fetchJobSites,
    createMaintenanceLog, updateMaintenanceLog, deleteMaintenanceLog,
    fetchMaintenanceCostsBySite, fetchMaintenanceCalendar,
    fetchIssueTemplates, fetchUsers
} from '../api/vrm'
import MaintenanceForm from '../components/MaintenanceForm'
import { generateCSV, downloadCSV } from '../utils/csv'

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend)

const STATUS_TABS = [
    { key: 'my_tasks', label: 'My Tasks', techOnly: true },
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

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function formatDate(ts) {
    if (!ts) return '—'
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatCost(cents) {
    if (!cents) return '$0'
    return `$${(cents / 100).toFixed(2)}`
}

function getCalendarDays(year, month) {
    const firstDay = new Date(year, month, 1)
    const lastDay = new Date(year, month + 1, 0)
    const startDow = firstDay.getDay()
    const daysInMonth = lastDay.getDate()

    const days = []
    // Leading blanks
    for (let i = 0; i < startDow; i++) days.push(null)
    // Actual days
    for (let d = 1; d <= daysInMonth; d++) days.push(d)
    return days
}

function dateToDayKey(ts) {
    if (!ts) return null
    const d = new Date(ts)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function MaintenancePage() {
    const { user } = useAuth()
    const toast = useToast()
    const showMyTasks = user && user.role !== 'viewer'
    const [statusFilter, setStatusFilter] = useState(showMyTasks ? 'my_tasks' : 'all')
    const [searchTerm, setSearchTerm] = useState('')
    const [showForm, setShowForm] = useState(false)
    const [editingLog, setEditingLog] = useState(null)
    const [costDays, setCostDays] = useState(30)
    const [updatingId, setUpdatingId] = useState(null)

    // Calendar view state
    const [viewMode, setViewMode] = useState('list') // 'list' or 'calendar'
    const now = new Date()
    const [calYear, setCalYear] = useState(now.getFullYear())
    const [calMonth, setCalMonth] = useState(now.getMonth())
    const [calendarItems, setCalendarItems] = useState([])
    const [selectedDay, setSelectedDay] = useState(null)

    // Issue templates & users
    const [issueTemplates, setIssueTemplates] = useState([])
    const [techUsers, setTechUsers] = useState([])

    const fetchLogsFn = useCallback(() => fetchMaintenanceLogs(), [])
    const fetchStatsFn = useCallback(() => fetchMaintenanceStats(), [])
    const fetchJobSitesFn = useCallback(() => fetchJobSites(), [])
    const fetchCostsFn = useCallback(() => fetchMaintenanceCostsBySite(costDays), [costDays])

    const { data: logsData, loading: logsLoading, refetch: refetchLogs } = useApiPolling(fetchLogsFn, 60000)
    const { data: statsData, refetch: refetchStats } = useApiPolling(fetchStatsFn, 60000)
    const { data: jobSitesData } = useApiPolling(fetchJobSitesFn, 60000)
    const { data: costsData } = useApiPolling(fetchCostsFn, 120000)

    const logs = logsData?.logs || []
    const stats = statsData?.stats || {}
    const jobSites = jobSitesData?.job_sites || []
    const costsBySite = costsData?.costs || []

    // Load issue templates on mount
    useEffect(() => {
        fetchIssueTemplates()
            .then(data => setIssueTemplates(data.templates || []))
            .catch(() => {})
    }, [])

    // Load users on mount (for technician dropdown)
    useEffect(() => {
        fetchUsers()
            .then(data => setTechUsers(data.users || []))
            .catch(() => {})
    }, [])

    // Load calendar data when month changes or view switches to calendar
    useEffect(() => {
        if (viewMode !== 'calendar') return
        const start = new Date(calYear, calMonth, 1).toISOString().slice(0, 10)
        const end = new Date(calYear, calMonth + 1, 0).toISOString().slice(0, 10)
        fetchMaintenanceCalendar(start, end)
            .then(data => setCalendarItems(data.items || data.logs || []))
            .catch(() => setCalendarItems([]))
    }, [viewMode, calYear, calMonth])

    // My Tasks data
    const fetchMyWorkFn = useCallback(() => {
        if (!user?.id) return Promise.resolve({ logs: [] })
        const now = Date.now()
        return fetchMaintenanceCalendar(now - 30 * 86400000, now + 60 * 86400000, user.id)
    }, [user?.id])
    const { data: myWorkData, refetch: refetchMyWork } = useApiPolling(fetchMyWorkFn, 30000, [user?.id], 'my-work')
    const myWorkLogs = myWorkData?.logs || []

    const myTasksCategorized = useMemo(() => {
        const overdue = [], inProgress = [], dueToday = [], upcoming = [], recentCompleted = []
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999)
        const now = Date.now()
        for (const log of myWorkLogs) {
            if (log.status === 'completed') {
                if (log.completed_date && log.completed_date > now - 7 * 86400000) recentCompleted.push(log)
                continue
            }
            if (log.status === 'cancelled') continue
            if (log.status === 'in_progress') { inProgress.push(log); continue }
            if (log.scheduled_date) {
                if (log.scheduled_date < todayStart.getTime()) overdue.push(log)
                else if (log.scheduled_date <= todayEnd.getTime()) dueToday.push(log)
                else upcoming.push(log)
            } else { upcoming.push(log) }
        }
        upcoming.sort((a, b) => (a.scheduled_date || Infinity) - (b.scheduled_date || Infinity))
        return { overdue, inProgress, dueToday, upcoming, recentCompleted }
    }, [myWorkLogs])

    const handleMyTaskStatus = async (id, newStatus) => {
        setUpdatingId(id)
        try {
            const updates = { status: newStatus }
            if (newStatus === 'completed') updates.completed_date = Date.now()
            await updateMaintenanceLog(id, updates)
            toast.success(`Marked as ${newStatus.replace('_', ' ')}`)
            refetchMyWork()
            refetchLogs()
            refetchStats()
        } catch (err) {
            toast.error(err.message)
        } finally {
            setUpdatingId(null)
        }
    }

    const visitTypeLabel = (type) => {
        const labels = { inspection: 'Inspection', repair: 'Repair', scheduled: 'Scheduled', emergency: 'Emergency', installation: 'Install', decommission: 'Decom' }
        return labels[type] || type
    }

    const formatShortDate = (ms) => {
        if (!ms) return '—'
        return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }

    // Calendar helpers
    const calDays = useMemo(() => getCalendarDays(calYear, calMonth), [calYear, calMonth])
    const todayKey = dateToDayKey(Date.now())
    const monthLabel = new Date(calYear, calMonth).toLocaleDateString([], { month: 'long', year: 'numeric' })

    const calItemsByDay = useMemo(() => {
        const map = {}
        for (const item of calendarItems) {
            const key = dateToDayKey(item.scheduled_date || item.created_at)
            if (!key) continue
            if (!map[key]) map[key] = []
            map[key].push(item)
        }
        return map
    }, [calendarItems])

    const getDotColor = (item) => {
        if (item.status === 'completed') return 'teal'
        const sd = item.scheduled_date ? new Date(item.scheduled_date) : null
        if (!sd) return 'green'
        const diff = (sd - new Date()) / (1000 * 60 * 60 * 24)
        if (diff < 0) return 'red'
        if (diff <= 3) return 'yellow'
        return 'green'
    }

    const selectedDayKey = selectedDay
        ? `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(selectedDay).padStart(2, '0')}`
        : null
    const selectedDayItems = selectedDayKey ? (calItemsByDay[selectedDayKey] || []) : []

    const handlePrevMonth = () => {
        if (calMonth === 0) { setCalYear(y => y - 1); setCalMonth(11) }
        else setCalMonth(m => m - 1)
        setSelectedDay(null)
    }
    const handleNextMonth = () => {
        if (calMonth === 11) { setCalYear(y => y + 1); setCalMonth(0) }
        else setCalMonth(m => m + 1)
        setSelectedDay(null)
    }

    const costChartData = useMemo(() => {
        if (!costsBySite.length) return null
        return {
            labels: costsBySite.map(c => c.job_site_name),
            datasets: [
                {
                    label: 'Labor',
                    data: costsBySite.map(c => (c.labor_cost_cents / 100)),
                    backgroundColor: 'rgba(52, 152, 219, 0.7)',
                    borderColor: '#3498db',
                    borderWidth: 1,
                },
                {
                    label: 'Parts',
                    data: costsBySite.map(c => (c.parts_cost_cents / 100)),
                    backgroundColor: 'rgba(230, 126, 34, 0.7)',
                    borderColor: '#e67e22',
                    borderWidth: 1,
                },
            ],
        }
    }, [costsBySite])

    const costChartOptions = {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { labels: { color: '#bdc3c7', font: { family: 'Inter', size: 12 } } },
            tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: $${ctx.parsed.x.toFixed(2)}` } },
        },
        scales: {
            x: { stacked: true, ticks: { color: '#7f8c8d', callback: (v) => `$${v}` }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { stacked: true, ticks: { color: '#7f8c8d', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
        },
    }

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

    const handleExportCSV = () => {
        const headers = ['Date', 'Job Site', 'Trailer', 'Title', 'Type', 'Status', 'Technician', 'Labor Hours', 'Labor Cost', 'Parts Cost', 'Total Cost', 'Description']
        const rows = filteredLogs.map(log => [
            formatDate(log.scheduled_date || log.created_at),
            log.job_site_name || '',
            log.trailer_name || '',
            log.title,
            TYPE_LABELS[log.visit_type] || log.visit_type,
            log.status,
            log.technician || '',
            log.labor_hours || 0,
            formatCost(log.labor_cost_cents),
            formatCost(log.parts_cost_cents),
            formatCost((log.labor_cost_cents || 0) + (log.parts_cost_cents || 0)),
            log.description || '',
        ])
        const csv = generateCSV(headers, rows)
        downloadCSV(csv, `maintenance-logs-${new Date().toISOString().slice(0, 10)}.csv`)
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

            {/* KPI Row (not shown in My Tasks - it has its own) */}
            {statusFilter !== 'my_tasks' && <div className="kpi-row">
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
            </div>}

            {/* Cost Chart by Site */}
            {statusFilter !== 'my_tasks' && costChartData && (
                <div className="maint-cost-section">
                    <div className="maint-cost-header">
                        <h2>Cost by Site</h2>
                        <div className="maint-cost-range">
                            {[7, 30, 90].map(d => (
                                <button
                                    key={d}
                                    className={`retention-btn ${costDays === d ? 'active' : ''}`}
                                    onClick={() => setCostDays(d)}
                                >
                                    {d}d
                                </button>
                            ))}
                        </div>
                    </div>
                    <div style={{ height: Math.max(200, costsBySite.length * 40 + 60) }}>
                        <Bar data={costChartData} options={costChartOptions} />
                    </div>
                </div>
            )}

            {/* Controls */}
            <div className="fleet-controls">
                {statusFilter !== 'my_tasks' && (
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
                )}

                {statusFilter !== 'my_tasks' && (
                    <div className="view-toggle">
                        <button
                            className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
                            onClick={() => setViewMode('list')}
                        >
                            List
                        </button>
                        <button
                            className={`view-toggle-btn ${viewMode === 'calendar' ? 'active' : ''}`}
                            onClick={() => setViewMode('calendar')}
                        >
                            Calendar
                        </button>
                    </div>
                )}

                <div className="maint-tabs">
                    {STATUS_TABS.filter(tab => !tab.techOnly || showMyTasks).map(tab => (
                        <button
                            key={tab.key}
                            className={`maint-tab ${statusFilter === tab.key ? 'active' : ''}`}
                            onClick={() => setStatusFilter(tab.key)}
                        >
                            {tab.label}
                            {tab.key === 'my_tasks' && myTasksCategorized.overdue.length > 0 && (
                                <span className="maint-tab-badge">{myTasksCategorized.overdue.length}</span>
                            )}
                        </button>
                    ))}
                </div>

                <button className="btn btn-secondary" onClick={handleExportCSV} disabled={filteredLogs.length === 0}>
                    Export CSV
                </button>
                <button className="btn btn-primary" onClick={() => { setEditingLog(null); setShowForm(true) }}>
                    + New Log
                </button>
            </div>

            {/* My Tasks View */}
            {statusFilter === 'my_tasks' && (
                <div className="my-tasks-section">
                    <div className="kpi-row">
                        <div className="kpi-card kpi-red">
                            <div className="kpi-value">{myTasksCategorized.overdue.length}</div>
                            <div className="kpi-label">Overdue</div>
                        </div>
                        <div className="kpi-card kpi-yellow">
                            <div className="kpi-value">{myTasksCategorized.dueToday.length}</div>
                            <div className="kpi-label">Due Today</div>
                        </div>
                        <div className="kpi-card kpi-blue">
                            <div className="kpi-value">{myTasksCategorized.inProgress.length}</div>
                            <div className="kpi-label">In Progress</div>
                        </div>
                        <div className="kpi-card kpi-green">
                            <div className="kpi-value">{myTasksCategorized.recentCompleted.length}</div>
                            <div className="kpi-label">Completed (7d)</div>
                        </div>
                    </div>

                    {myTasksCategorized.overdue.length > 0 && (
                        <section className="work-section">
                            <h3 className="work-section-title work-section-red">Overdue</h3>
                            <div className="work-cards-grid">
                                {myTasksCategorized.overdue.map(log => (
                                    <div key={log.id} className="work-card">
                                        <div className="work-card-header">
                                            <span className={`maint-status-badge maint-status-${log.status === 'in_progress' ? 'yellow' : 'blue'}`}>{visitTypeLabel(log.visit_type)}</span>
                                            <span className="work-overdue-tag">OVERDUE</span>
                                        </div>
                                        <h4 className="work-card-title">{log.title}</h4>
                                        <div className="work-card-meta">
                                            {log.job_site_name && <span>{log.job_site_name}</span>}
                                            {log.scheduled_date && <span>{formatShortDate(log.scheduled_date)}</span>}
                                        </div>
                                        <div className="work-card-actions">
                                            <button className="btn btn-sm btn-primary" onClick={() => handleMyTaskStatus(log.id, 'in_progress')} disabled={updatingId === log.id}>Start Work</button>
                                            <button className="btn btn-sm btn-ghost" onClick={() => handleEdit(log)}>Details</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {myTasksCategorized.inProgress.length > 0 && (
                        <section className="work-section">
                            <h3 className="work-section-title work-section-yellow">In Progress</h3>
                            <div className="work-cards-grid">
                                {myTasksCategorized.inProgress.map(log => (
                                    <div key={log.id} className="work-card">
                                        <div className="work-card-header">
                                            <span className="maint-status-badge maint-status-yellow">{visitTypeLabel(log.visit_type)}</span>
                                        </div>
                                        <h4 className="work-card-title">{log.title}</h4>
                                        <div className="work-card-meta">
                                            {log.job_site_name && <span>{log.job_site_name}</span>}
                                            {log.scheduled_date && <span>{formatShortDate(log.scheduled_date)}</span>}
                                        </div>
                                        <div className="work-card-actions">
                                            <button className="btn btn-sm btn-success" onClick={() => handleMyTaskStatus(log.id, 'completed')} disabled={updatingId === log.id}>Mark Complete</button>
                                            <button className="btn btn-sm btn-ghost" onClick={() => handleEdit(log)}>Details</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {myTasksCategorized.dueToday.length > 0 && (
                        <section className="work-section">
                            <h3 className="work-section-title work-section-blue">Due Today</h3>
                            <div className="work-cards-grid">
                                {myTasksCategorized.dueToday.map(log => (
                                    <div key={log.id} className="work-card">
                                        <div className="work-card-header">
                                            <span className="maint-status-badge maint-status-blue">{visitTypeLabel(log.visit_type)}</span>
                                        </div>
                                        <h4 className="work-card-title">{log.title}</h4>
                                        <div className="work-card-meta">
                                            {log.job_site_name && <span>{log.job_site_name}</span>}
                                        </div>
                                        <div className="work-card-actions">
                                            <button className="btn btn-sm btn-primary" onClick={() => handleMyTaskStatus(log.id, 'in_progress')} disabled={updatingId === log.id}>Start Work</button>
                                            <button className="btn btn-sm btn-ghost" onClick={() => handleEdit(log)}>Details</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {myTasksCategorized.upcoming.length > 0 && (
                        <section className="work-section">
                            <h3 className="work-section-title">Upcoming</h3>
                            <div className="work-cards-grid">
                                {myTasksCategorized.upcoming.map(log => (
                                    <div key={log.id} className="work-card">
                                        <div className="work-card-header">
                                            <span className="maint-status-badge maint-status-blue">{visitTypeLabel(log.visit_type)}</span>
                                        </div>
                                        <h4 className="work-card-title">{log.title}</h4>
                                        <div className="work-card-meta">
                                            {log.job_site_name && <span>{log.job_site_name}</span>}
                                            {log.scheduled_date && <span>{formatShortDate(log.scheduled_date)}</span>}
                                        </div>
                                        <div className="work-card-actions">
                                            <button className="btn btn-sm btn-ghost" onClick={() => handleEdit(log)}>Details</button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {myWorkLogs.length === 0 && (
                        <div className="work-empty">
                            <p>No tasks assigned to you yet.</p>
                            <p className="text-muted">Tasks will appear here when maintenance is assigned to your account.</p>
                        </div>
                    )}
                </div>
            )}

            {/* Calendar View */}
            {statusFilter !== 'my_tasks' && viewMode === 'calendar' && (
                <div className="maint-calendar-section">
                    <div className="cal-nav">
                        <button className="btn btn-sm btn-secondary" onClick={handlePrevMonth}>&larr;</button>
                        <span className="cal-nav-label">{monthLabel}</span>
                        <button className="btn btn-sm btn-secondary" onClick={handleNextMonth}>&rarr;</button>
                    </div>
                    <div className="cal-grid">
                        {DAY_NAMES.map(d => (
                            <div key={d} className="cal-header">{d}</div>
                        ))}
                        {calDays.map((day, i) => {
                            if (day === null) return <div key={`blank-${i}`} className="cal-day cal-day-blank" />
                            const dayKey = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                            const items = calItemsByDay[dayKey] || []
                            const isToday = dayKey === todayKey
                            const isSelected = day === selectedDay
                            return (
                                <div
                                    key={day}
                                    className={`cal-day${isToday ? ' cal-day-today' : ''}${isSelected ? ' cal-day-selected' : ''}`}
                                    onClick={() => setSelectedDay(day === selectedDay ? null : day)}
                                >
                                    <span className="cal-day-num">{day}</span>
                                    {items.length > 0 && (
                                        <div className="cal-day-dots">
                                            {items.slice(0, 5).map((item, j) => (
                                                <span key={j} className={`cal-day-dot cal-dot-${getDotColor(item)}`} />
                                            ))}
                                            {items.length > 5 && <span className="cal-day-more">+{items.length - 5}</span>}
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>

                    {/* Selected day detail */}
                    {selectedDay && (
                        <div className="cal-day-detail">
                            <h3>
                                {new Date(calYear, calMonth, selectedDay).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
                                <span className="maint-group-count">{selectedDayItems.length} item{selectedDayItems.length !== 1 ? 's' : ''}</span>
                            </h3>
                            {selectedDayItems.length === 0 ? (
                                <p className="settings-desc">No maintenance items on this day.</p>
                            ) : (
                                <table className="maint-table">
                                    <thead>
                                        <tr>
                                            <th>Title</th>
                                            <th>Type</th>
                                            <th>Site</th>
                                            <th>Technician</th>
                                            <th>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {selectedDayItems.map(item => (
                                            <tr key={item.id} className="maint-row" onClick={() => handleEdit(item)}>
                                                <td className="maint-title">{item.title}</td>
                                                <td><span className="maint-type-badge">{TYPE_LABELS[item.visit_type] || item.visit_type}</span></td>
                                                <td>{item.job_site_name || '—'}</td>
                                                <td className="maint-tech">{item.technician || '—'}</td>
                                                <td>{statusBadge(item.status)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Maintenance Logs Table (list view) */}
            {statusFilter !== 'my_tasks' && viewMode === 'list' && (
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
            )}

            {/* New/Edit Form Modal */}
            {showForm && (
                <MaintenanceForm
                    log={editingLog}
                    jobSites={jobSites}
                    issueTemplates={issueTemplates}
                    techUsers={techUsers}
                    onSave={handleSave}
                    onClose={() => { setShowForm(false); setEditingLog(null) }}
                />
            )}
        </div>
    )
}

export default MaintenancePage
