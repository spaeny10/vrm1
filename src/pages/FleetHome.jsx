import { useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useToast } from '../components/ToastProvider'
import { fetchDeploymentSummary, fetchBillingSummary, fetchActionQueue, approveGpsChange, rejectGpsChange } from '../api/vrm'
import DispatchBoard from '../components/DispatchBoard'

// Fleet workspace home: where is everything, what has to move today,
// and which relocations need a decision.
function FleetHome() {
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const toast = useToast()

    const fetchDeployFn = useCallback(() => fetchDeploymentSummary(), [])
    const fetchSummaryFn = useCallback(() => fetchBillingSummary(), [])
    const fetchQueueFn = useCallback(() => fetchActionQueue(), [])

    const { data: deployData } = useApiPolling(fetchDeployFn, 60000)
    const { data: summaryData } = useApiPolling(fetchSummaryFn, 60000)
    const { data: queueData, refetch: refetchQueue } = useApiPolling(fetchQueueFn, 30000)

    const deploy = deployData || {}
    const summary = summaryData?.summary || {}
    const relocations = (queueData?.actions || []).filter(a => a.category === 'location' && !a.acknowledged)

    const [resolving, setResolving] = useState(null)

    const handleSuggestion = async (suggestionId, approve) => {
        setResolving(suggestionId)
        try {
            if (approve) await approveGpsChange(suggestionId)
            else await rejectGpsChange(suggestionId)
            toast.success(approve ? 'Relocation approved — assignment updated' : 'Suggestion rejected')
            refetchQueue()
        } catch (err) {
            toast.error(err.message)
        } finally {
            setResolving(null)
        }
    }

    return (
        <div className="page">
            <div className="page-header">
                <div className="page-header-row">
                    <h1>Fleet Operations</h1>
                    <div className="page-header-actions">
                        <Link to="/rentals" className="btn btn-primary">Rentals & Billing</Link>
                        <Link to="/trailers" className="btn btn-secondary">Trailers</Link>
                    </div>
                </div>
                <p className="page-subtitle">Where the fleet is, what moves today, and what needs your decision</p>
            </div>

            {/* Deployment KPIs */}
            <div className="kpi-row">
                <div className="kpi-card kpi-green">
                    <div className="kpi-value">{deploy.active_billing?.trailers ?? '—'}</div>
                    <div className="kpi-label">On Rent & Billing</div>
                </div>
                <div className="kpi-card kpi-blue">
                    <div className="kpi-value">{deploy.standby?.trailers ?? '—'}</div>
                    <div className="kpi-label">On Site, Standby</div>
                </div>
                <div className="kpi-card kpi-teal">
                    <div className="kpi-value">{summary.trailers_available ?? '—'}</div>
                    <div className="kpi-label">Available at HQ</div>
                </div>
                <div className="kpi-card kpi-yellow">
                    <div className="kpi-value">{deploy.awaiting_pickup?.trailers ?? '—'}</div>
                    <div className="kpi-label">Awaiting Pickup</div>
                </div>
                <div className={`kpi-card ${relocations.length > 0 ? 'kpi-red' : ''}`}>
                    <div className="kpi-value">{relocations.length}</div>
                    <div className="kpi-label">Moves to Approve</div>
                </div>
            </div>

            {/* What has to physically move */}
            <DispatchBoard />

            {/* Relocation approvals */}
            <div className="maint-table-section" style={{ marginBottom: 20 }}>
                <div className="maint-group-header">
                    <h3>Trailer Relocations</h3>
                    <span className="maint-group-count">{relocations.length} pending</span>
                </div>
                {relocations.length === 0 ? (
                    <p className="settings-desc" style={{ padding: '8px 0' }}>
                        No pending relocation approvals. When a trailer's GPS moves more than 1 km, the suggested reassignment appears here.
                    </p>
                ) : (
                    <table className="maint-table">
                        <tbody>
                            {relocations.map(a => (
                                <tr key={a.key}>
                                    <td className="maint-title">{a.title}</td>
                                    <td style={{ color: 'var(--text-secondary)' }}>{a.subtitle}{a.details ? ` — ${a.details}` : ''}</td>
                                    {canEdit && (
                                        <td className="maint-actions" style={{ whiteSpace: 'nowrap' }}>
                                            <button
                                                className="btn btn-sm btn-primary"
                                                style={{ marginRight: 6 }}
                                                disabled={resolving === a.suggestion_id}
                                                onClick={() => handleSuggestion(a.suggestion_id, true)}
                                            >
                                                Approve
                                            </button>
                                            <button
                                                className="btn btn-sm btn-ghost"
                                                disabled={resolving === a.suggestion_id}
                                                onClick={() => handleSuggestion(a.suggestion_id, false)}
                                            >
                                                Reject
                                            </button>
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    )
}

export default FleetHome
