import { useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useToast } from '../components/ToastProvider'
import { fetchTrailers, createTrailer, updateTrailerAsset } from '../api/vrm'
import {
    TRAILER_STATUS_LABELS, TrailerStatusBadge, RentalStatusBadge, formatDate, todayStr,
} from '../components/RentalLifecycle'
import { generateCSV, downloadCSV } from '../utils/csv'

const STATUS_TABS = [
    { key: 'all', label: 'All' },
    { key: 'available', label: 'Available' },
    { key: 'on_rent', label: 'On Rent' },
    { key: 'reserved', label: 'Reserved' },
    { key: 'in_transit', label: 'In Transit' },
    { key: 'maintenance', label: 'Maintenance' },
    { key: 'retired', label: 'Retired' },
]

function TrailersPage() {
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const toast = useToast()

    const [statusFilter, setStatusFilter] = useState('all')
    const [search, setSearch] = useState('')
    const [editing, setEditing] = useState(null)   // trailer object or 'new'

    const fetchFn = useCallback(() => fetchTrailers(), [])
    const { data, loading, refetch } = useApiPolling(fetchFn, 60000)
    const trailers = data?.trailers || []

    const counts = useMemo(() => {
        const c = {}
        for (const t of trailers) c[t.status] = (c[t.status] || 0) + 1
        return c
    }, [trailers])

    const filtered = useMemo(() => {
        let list = trailers
        if (statusFilter !== 'all') list = list.filter(t => t.status === statusFilter)
        else list = list.filter(t => t.status !== 'retired')
        const term = search.trim().toLowerCase()
        if (term) {
            list = list.filter(t =>
                t.unit_number?.toLowerCase().includes(term)
                || t.vin?.toLowerCase().includes(term)
                || t.current_job_site_name?.toLowerCase().includes(term))
        }
        return list
    }, [trailers, statusFilter, search])

    const handleRetire = async (t) => {
        try {
            await updateTrailerAsset(t.id, { status: 'retired' })
            toast.success(`${t.unit_number} retired`)
            refetch()
        } catch (err) {
            toast.error(err.message)
        }
    }

    const handleExportCSV = () => {
        const headers = ['Unit', 'Product', 'VIN', 'Status', 'Location', 'Open Rental', 'Purchase Date', 'Notes']
        const rows = filtered.map(t => [
            t.unit_number, t.product_code || '', t.vin || '',
            TRAILER_STATUS_LABELS[t.status] || t.status,
            t.at_headquarters ? 'HQ' : (t.current_job_site_name || ''),
            t.open_rental_status || '',
            t.purchase_date ? String(t.purchase_date).slice(0, 10) : '',
            t.condition_notes || '',
        ])
        downloadCSV(generateCSV(headers, rows), `trailers-${todayStr()}.csv`)
    }

    return (
        <div className="page">
            <div className="page-header">
                <div className="page-header-row">
                    <h1>Trailers</h1>
                    <div className="page-header-actions">
                        <button className="btn btn-secondary" onClick={handleExportCSV} disabled={filtered.length === 0}>
                            Export CSV
                        </button>
                        {canEdit && (
                            <button className="btn btn-primary" onClick={() => setEditing('new')}>
                                + Add Trailer
                            </button>
                        )}
                    </div>
                </div>
                <p className="page-subtitle">Fleet asset registry — every unit, where it is, and whether it's earning</p>
            </div>

            <div className="kpi-row">
                <div className="kpi-card kpi-green">
                    <div className="kpi-value">{counts.available || 0}</div>
                    <div className="kpi-label">Available</div>
                </div>
                <div className="kpi-card kpi-yellow">
                    <div className="kpi-value">{counts.on_rent || 0}</div>
                    <div className="kpi-label">On Rent</div>
                </div>
                <div className="kpi-card kpi-blue">
                    <div className="kpi-value">{(counts.reserved || 0) + (counts.in_transit || 0)}</div>
                    <div className="kpi-label">Reserved / In Transit</div>
                </div>
                <div className="kpi-card">
                    <div className="kpi-value">{trailers.filter(t => t.status !== 'retired').length}</div>
                    <div className="kpi-label">Total Active Fleet</div>
                </div>
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
                <input
                    className="input"
                    style={{ maxWidth: 260 }}
                    placeholder="Search unit, VIN, or site..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
                <div className="maint-tabs">
                    {STATUS_TABS.map(tab => (
                        <button
                            key={tab.key}
                            className={`maint-tab ${statusFilter === tab.key ? 'active' : ''}`}
                            onClick={() => setStatusFilter(tab.key)}
                        >
                            {tab.label}{tab.key !== 'all' && counts[tab.key] ? ` (${counts[tab.key]})` : ''}
                        </button>
                    ))}
                </div>
            </div>

            <div className="maint-table-section">
                {loading && trailers.length === 0 ? (
                    <div className="page-loading"><div className="spinner" /><p>Loading trailers...</p></div>
                ) : filtered.length === 0 ? (
                    <div className="empty-section">
                        <p>{trailers.length === 0
                            ? 'No trailers registered yet. Click "+ Add Trailer" to add your first unit.'
                            : 'No trailers match this filter.'}</p>
                    </div>
                ) : (
                    <table className="maint-table">
                        <thead>
                            <tr>
                                <th>Unit</th>
                                <th>Product</th>
                                <th>VIN</th>
                                <th>Status</th>
                                <th>Location</th>
                                <th>Rental</th>
                                <th>Purchased</th>
                                {canEdit && <th>Actions</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map(t => (
                                <tr key={t.id}>
                                    <td className="maint-title">
                                        {t.vrm_site_id
                                            ? <Link to={`/trailer/${t.vrm_site_id}`} className="table-link">{t.unit_number}</Link>
                                            : t.unit_number}
                                    </td>
                                    <td>{t.product_code || '—'}</td>
                                    <td>{t.vin || '—'}</td>
                                    <td><TrailerStatusBadge status={t.status} /></td>
                                    <td>
                                        {t.at_headquarters
                                            ? 'HQ'
                                            : t.current_job_site_id
                                                ? <Link to={`/site/${t.current_job_site_id}`} className="table-link">{t.current_job_site_name}</Link>
                                                : (t.current_job_site_name || '—')}
                                    </td>
                                    <td>
                                        {t.open_rental_status
                                            ? <Link to="/rentals" className="table-link"><RentalStatusBadge status={t.open_rental_status} /></Link>
                                            : '—'}
                                    </td>
                                    <td className="maint-date">{formatDate(t.purchase_date)}</td>
                                    {canEdit && (
                                        <td className="maint-actions">
                                            <button className="btn btn-sm btn-ghost" style={{ marginRight: 6 }} onClick={() => setEditing(t)}>Edit</button>
                                            {t.status === 'available' && (
                                                <button className="btn btn-sm btn-ghost" onClick={() => handleRetire(t)}>Retire</button>
                                            )}
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {editing && (
                <TrailerModal
                    trailer={editing === 'new' ? null : editing}
                    onSaved={() => { setEditing(null); refetch(); toast.success(editing === 'new' ? 'Trailer added' : 'Trailer updated') }}
                    onError={(msg) => toast.error(msg)}
                    onClose={() => setEditing(null)}
                />
            )}
        </div>
    )
}

function TrailerModal({ trailer, onSaved, onError, onClose }) {
    const isNew = !trailer
    const [form, setForm] = useState({
        unit_number: trailer?.unit_number || '',
        product_code: trailer?.product_code || 'BV1305',
        vin: trailer?.vin || '',
        vrm_site_id: trailer?.vrm_site_id || '',
        status: trailer?.status || 'available',
        purchase_date: trailer?.purchase_date ? String(trailer.purchase_date).slice(0, 10) : '',
        condition_notes: trailer?.condition_notes || '',
    })
    const [saving, setSaving] = useState(false)

    const set = (key) => (e) => setForm(f => ({ ...f, [key]: e.target.value }))

    const handleSubmit = async () => {
        setSaving(true)
        try {
            const payload = {
                unit_number: form.unit_number.trim(),
                product_code: form.product_code.trim() || 'BV1305',
                vin: form.vin.trim() || null,
                vrm_site_id: form.vrm_site_id ? parseInt(form.vrm_site_id) : null,
                status: form.status,
                purchase_date: form.purchase_date || null,
                condition_notes: form.condition_notes || null,
            }
            if (isNew) await createTrailer(payload)
            else await updateTrailerAsset(trailer.id, payload)
            onSaved()
        } catch (err) {
            onError(err.message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
                <div className="modal-header">
                    <h2>{isNew ? 'Add Trailer' : `Edit ${trailer.unit_number}`}</h2>
                    <button className="modal-close" onClick={onClose}>&times;</button>
                </div>
                <div style={{ padding: 20 }}>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Unit Number *</label>
                            <input className="input" value={form.unit_number} onChange={set('unit_number')} placeholder="e.g. BV-042" />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Product</label>
                            <input className="input" value={form.product_code} onChange={set('product_code')} placeholder="BV1305" />
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">VIN / Serial</label>
                            <input className="input" value={form.vin} onChange={set('vin')} />
                        </div>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Purchase Date</label>
                            <input type="date" className="input" value={form.purchase_date} onChange={set('purchase_date')} />
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">VRM Site ID</label>
                            <input type="number" className="input" value={form.vrm_site_id} onChange={set('vrm_site_id')} placeholder="Victron installation id" />
                            <p className="settings-desc" style={{ marginTop: 4 }}>Links this unit to its telemetry. Auto-filled for trailers discovered from VRM.</p>
                        </div>
                        <div style={{ flex: 1 }}>
                            <label className="form-label">Status</label>
                            <select className="input" value={form.status} onChange={set('status')}>
                                {Object.entries(TRAILER_STATUS_LABELS).map(([k, v]) => (
                                    <option key={k} value={k}>{v}</option>
                                ))}
                            </select>
                            <p className="settings-desc" style={{ marginTop: 4 }}>Rental lifecycle events manage this automatically — override only for maintenance holds or corrections.</p>
                        </div>
                    </div>
                    <div style={{ marginBottom: 14 }}>
                        <label className="form-label">Condition Notes</label>
                        <textarea className="input" rows={2} value={form.condition_notes} onChange={set('condition_notes')} />
                    </div>
                    <div className="modal-footer">
                        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
                        <button className="btn btn-primary" onClick={handleSubmit} disabled={saving || !form.unit_number.trim()}>
                            {saving ? 'Saving...' : (isNew ? 'Add Trailer' : 'Save Changes')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

export default TrailersPage
