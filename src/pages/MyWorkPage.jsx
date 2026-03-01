import { useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../components/AuthProvider';
import { useApiPolling } from '../hooks/useApiPolling';
import { fetchMaintenanceCalendar, updateMaintenanceLog } from '../api/vrm';
import { useToast } from '../components/ToastProvider';

export default function MyWorkPage() {
    const { user } = useAuth();
    const toast = useToast();
    const [updatingId, setUpdatingId] = useState(null);

    const fetchMyWork = useCallback(() => {
        const now = Date.now();
        const start = now - 30 * 86400000;
        const end = now + 60 * 86400000;
        return fetchMaintenanceCalendar(start, end, user?.id);
    }, [user?.id]);

    const { data, refetch } = useApiPolling(fetchMyWork, 30000, [user?.id], 'my-work');

    const logs = data?.logs || [];
    const now = Date.now();

    const categorized = useMemo(() => {
        const overdue = [];
        const inProgress = [];
        const dueToday = [];
        const upcoming = [];
        const recentCompleted = [];

        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

        for (const log of logs) {
            if (log.status === 'completed') {
                if (log.completed_date && log.completed_date > now - 7 * 86400000) {
                    recentCompleted.push(log);
                }
                continue;
            }
            if (log.status === 'cancelled') continue;
            if (log.status === 'in_progress') {
                inProgress.push(log);
                continue;
            }
            if (log.scheduled_date) {
                if (log.scheduled_date < todayStart.getTime()) overdue.push(log);
                else if (log.scheduled_date <= todayEnd.getTime()) dueToday.push(log);
                else upcoming.push(log);
            } else {
                upcoming.push(log);
            }
        }

        upcoming.sort((a, b) => (a.scheduled_date || Infinity) - (b.scheduled_date || Infinity));
        return { overdue, inProgress, dueToday, upcoming, recentCompleted };
    }, [logs, now]);

    const handleStatusUpdate = async (id, newStatus) => {
        setUpdatingId(id);
        try {
            const updates = { status: newStatus };
            if (newStatus === 'completed') updates.completed_date = Date.now();
            await updateMaintenanceLog(id, updates);
            toast.success(`Marked as ${newStatus.replace('_', ' ')}`);
            refetch();
        } catch (err) {
            toast.error(err.message);
        } finally {
            setUpdatingId(null);
        }
    };

    const formatDate = (ms) => {
        if (!ms) return '—';
        return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };

    const visitTypeLabel = (type) => {
        const labels = { inspection: 'Inspection', repair: 'Repair', scheduled: 'Scheduled', emergency: 'Emergency', installation: 'Install', decommission: 'Decom' };
        return labels[type] || type;
    };

    const renderWorkCard = (log) => (
        <div key={log.id} className="work-card">
            <div className="work-card-header">
                <span className={`maint-status-badge maint-status-${log.status === 'in_progress' ? 'yellow' : log.status === 'scheduled' ? 'blue' : 'gray'}`}>
                    {visitTypeLabel(log.visit_type)}
                </span>
                {log.scheduled_date && log.scheduled_date < now && log.status !== 'completed' && (
                    <span className="work-overdue-tag">OVERDUE</span>
                )}
            </div>
            <h4 className="work-card-title">{log.title}</h4>
            <div className="work-card-meta">
                {log.job_site_name && <span>{log.job_site_name}</span>}
                {log.scheduled_date && <span>{formatDate(log.scheduled_date)}</span>}
            </div>
            {log.description && <p className="work-card-desc">{log.description.slice(0, 120)}{log.description.length > 120 ? '...' : ''}</p>}
            <div className="work-card-actions">
                {log.status === 'scheduled' && (
                    <button className="btn btn-sm btn-primary" onClick={() => handleStatusUpdate(log.id, 'in_progress')} disabled={updatingId === log.id}>
                        Start Work
                    </button>
                )}
                {log.status === 'in_progress' && (
                    <button className="btn btn-sm btn-success" onClick={() => handleStatusUpdate(log.id, 'completed')} disabled={updatingId === log.id}>
                        Mark Complete
                    </button>
                )}
                <Link to={`/maintenance`} className="btn btn-sm btn-ghost">Details</Link>
            </div>
        </div>
    );

    return (
        <div className="page-container">
            <div className="page-header">
                <h1>My Work</h1>
                <p className="page-subtitle">{user?.display_name} — assigned tasks and schedule</p>
            </div>

            <div className="kpi-row">
                <div className="kpi-card kpi-red">
                    <div className="kpi-value">{categorized.overdue.length}</div>
                    <div className="kpi-label">Overdue</div>
                </div>
                <div className="kpi-card kpi-yellow">
                    <div className="kpi-value">{categorized.dueToday.length}</div>
                    <div className="kpi-label">Due Today</div>
                </div>
                <div className="kpi-card kpi-blue">
                    <div className="kpi-value">{categorized.inProgress.length}</div>
                    <div className="kpi-label">In Progress</div>
                </div>
                <div className="kpi-card kpi-green">
                    <div className="kpi-value">{categorized.recentCompleted.length}</div>
                    <div className="kpi-label">Completed (7d)</div>
                </div>
            </div>

            {categorized.overdue.length > 0 && (
                <section className="work-section">
                    <h3 className="work-section-title work-section-red">Overdue</h3>
                    <div className="work-cards-grid">
                        {categorized.overdue.map(renderWorkCard)}
                    </div>
                </section>
            )}

            {categorized.inProgress.length > 0 && (
                <section className="work-section">
                    <h3 className="work-section-title work-section-yellow">In Progress</h3>
                    <div className="work-cards-grid">
                        {categorized.inProgress.map(renderWorkCard)}
                    </div>
                </section>
            )}

            {categorized.dueToday.length > 0 && (
                <section className="work-section">
                    <h3 className="work-section-title work-section-blue">Due Today</h3>
                    <div className="work-cards-grid">
                        {categorized.dueToday.map(renderWorkCard)}
                    </div>
                </section>
            )}

            {categorized.upcoming.length > 0 && (
                <section className="work-section">
                    <h3 className="work-section-title">Upcoming</h3>
                    <div className="work-cards-grid">
                        {categorized.upcoming.map(renderWorkCard)}
                    </div>
                </section>
            )}

            {logs.length === 0 && (
                <div className="work-empty">
                    <p>No tasks assigned to you yet.</p>
                    <p className="text-muted">Tasks will appear here when maintenance is assigned to your account.</p>
                </div>
            )}
        </div>
    );
}
