import { useState, useMemo } from 'react'

const VISIT_TYPES = [
    { value: 'inspection', label: 'Inspection' },
    { value: 'repair', label: 'Repair' },
    { value: 'scheduled', label: 'Scheduled Maintenance' },
    { value: 'emergency', label: 'Emergency' },
    { value: 'installation', label: 'Installation' },
    { value: 'decommission', label: 'Decommission' },
]

const STATUSES = [
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
]

function MaintenanceForm({ log, jobSites, onSave, onClose }) {
    const isEdit = !!log

    const [formData, setFormData] = useState({
        job_site_id: log?.job_site_id || '',
        site_id: log?.site_id || '',
        visit_type: log?.visit_type || 'inspection',
        status: log?.status || 'scheduled',
        title: log?.title || '',
        description: log?.description || '',
        technician: log?.technician || '',
        scheduled_date: log?.scheduled_date ? new Date(log.scheduled_date).toISOString().slice(0, 10) : '',
        completed_date: log?.completed_date ? new Date(log.completed_date).toISOString().slice(0, 10) : '',
        labor_hours: log?.labor_hours || '',
        labor_cost_cents: log?.labor_cost_cents ? (log.labor_cost_cents / 100).toFixed(2) : '',
        parts_cost_cents: log?.parts_cost_cents ? (log.parts_cost_cents / 100).toFixed(2) : '',
        parts_used: log?.parts_used || [],
    })

    const [saving, setSaving] = useState(false)

    // Get trailers for selected job site
    const selectedSiteTrailers = useMemo(() => {
        if (!formData.job_site_id) return []
        const js = jobSites.find(s => s.id === parseInt(formData.job_site_id))
        return js?.trailers || []
    }, [formData.job_site_id, jobSites])

    const update = (field, value) => {
        setFormData(prev => ({ ...prev, [field]: value }))
    }

    const addPart = () => {
        setFormData(prev => ({
            ...prev,
            parts_used: [...prev.parts_used, { name: '', quantity: 1, cost_cents: 0 }]
        }))
    }

    const updatePart = (index, field, value) => {
        setFormData(prev => ({
            ...prev,
            parts_used: prev.parts_used.map((p, i) =>
                i === index ? { ...p, [field]: value } : p
            )
        }))
    }

    const removePart = (index) => {
        setFormData(prev => ({
            ...prev,
            parts_used: prev.parts_used.filter((_, i) => i !== index)
        }))
    }

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (!formData.title.trim() || !formData.visit_type) return

        setSaving(true)
        try {
            const payload = {
                job_site_id: formData.job_site_id ? parseInt(formData.job_site_id) : null,
                site_id: formData.site_id ? parseInt(formData.site_id) : null,
                visit_type: formData.visit_type,
                status: formData.status,
                title: formData.title.trim(),
                description: formData.description.trim() || null,
                technician: formData.technician.trim() || null,
                scheduled_date: formData.scheduled_date ? new Date(formData.scheduled_date + 'T12:00:00').getTime() : null,
                completed_date: formData.completed_date ? new Date(formData.completed_date + 'T12:00:00').getTime() : null,
                labor_hours: formData.labor_hours ? parseFloat(formData.labor_hours) : null,
                labor_cost_cents: formData.labor_cost_cents ? Math.round(parseFloat(formData.labor_cost_cents) * 100) : 0,
                parts_cost_cents: formData.parts_cost_cents ? Math.round(parseFloat(formData.parts_cost_cents) * 100) : 0,
                parts_used: formData.parts_used.length > 0 ? formData.parts_used : null,
            }
            await onSave(payload)
        } catch (err) {
            console.error('Failed to save:', err)
        }
        setSaving(false)
    }

    // Calculate total cost
    const totalCost = useMemo(() => {
        const labor = formData.labor_cost_cents ? parseFloat(formData.labor_cost_cents) : 0
        const parts = formData.parts_cost_cents ? parseFloat(formData.parts_cost_cents) : 0
        return (labor + parts).toFixed(2)
    }, [formData.labor_cost_cents, formData.parts_cost_cents])

    return (
        <div className="maint-form-overlay" onClick={onClose}>
            <div className="maint-form-panel" onClick={e => e.stopPropagation()}>
                <div className="maint-form-header">
                    <h2>{isEdit ? 'Edit Maintenance Log' : 'New Maintenance Log'}</h2>
                    <button className="detail-close" onClick={onClose}>✕</button>
                </div>

                <form onSubmit={handleSubmit} className="maint-form">
                    <div className="maint-form-grid">
                        {/* Job Site */}
                        <div className="form-group">
                            <label>Job Site</label>
                            <select
                                value={formData.job_site_id}
                                onChange={e => { update('job_site_id', e.target.value); update('site_id', '') }}
                            >
                                <option value="">— Select Site —</option>
                                {jobSites.map(js => (
                                    <option key={js.id} value={js.id}>{js.name}</option>
                                ))}
                            </select>
                        </div>

                        {/* Trailer (optional, filtered by job site) */}
                        <div className="form-group">
                            <label>Trailer (optional)</label>
                            <select
                                value={formData.site_id}
                                onChange={e => update('site_id', e.target.value)}
                                disabled={!formData.job_site_id}
                            >
                                <option value="">— Site-wide —</option>
                                {selectedSiteTrailers.map(t => (
                                    <option key={t.site_id} value={t.site_id}>{t.site_name}</option>
                                ))}
                            </select>
                        </div>

                        {/* Type */}
                        <div className="form-group">
                            <label>Type *</label>
                            <select value={formData.visit_type} onChange={e => update('visit_type', e.target.value)}>
                                {VISIT_TYPES.map(t => (
                                    <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                            </select>
                        </div>

                        {/* Status */}
                        <div className="form-group">
                            <label>Status</label>
                            <select value={formData.status} onChange={e => update('status', e.target.value)}>
                                {STATUSES.map(s => (
                                    <option key={s.value} value={s.value}>{s.label}</option>
                                ))}
                            </select>
                        </div>

                        {/* Title */}
                        <div className="form-group form-group-wide">
                            <label>Title *</label>
                            <input
                                type="text"
                                value={formData.title}
                                onChange={e => update('title', e.target.value)}
                                placeholder="Brief description of the work"
                                required
                            />
                        </div>

                        {/* Description */}
                        <div className="form-group form-group-wide">
                            <label>Description</label>
                            <textarea
                                value={formData.description}
                                onChange={e => update('description', e.target.value)}
                                placeholder="Detailed notes about the work performed..."
                                rows={3}
                            />
                        </div>

                        {/* Technician */}
                        <div className="form-group">
                            <label>Technician</label>
                            <input
                                type="text"
                                value={formData.technician}
                                onChange={e => update('technician', e.target.value)}
                                placeholder="Name"
                            />
                        </div>

                        {/* Scheduled Date */}
                        <div className="form-group">
                            <label>Scheduled Date</label>
                            <input
                                type="date"
                                value={formData.scheduled_date}
                                onChange={e => update('scheduled_date', e.target.value)}
                            />
                        </div>

                        {/* Completed Date */}
                        <div className="form-group">
                            <label>Completed Date</label>
                            <input
                                type="date"
                                value={formData.completed_date}
                                onChange={e => update('completed_date', e.target.value)}
                            />
                        </div>

                        {/* Labor Hours */}
                        <div className="form-group">
                            <label>Labor Hours</label>
                            <input
                                type="number"
                                step="0.5"
                                min="0"
                                value={formData.labor_hours}
                                onChange={e => update('labor_hours', e.target.value)}
                                placeholder="0"
                            />
                        </div>

                        {/* Labor Cost */}
                        <div className="form-group">
                            <label>Labor Cost ($)</label>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={formData.labor_cost_cents}
                                onChange={e => update('labor_cost_cents', e.target.value)}
                                placeholder="0.00"
                            />
                        </div>

                        {/* Parts Cost */}
                        <div className="form-group">
                            <label>Parts Cost ($)</label>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={formData.parts_cost_cents}
                                onChange={e => update('parts_cost_cents', e.target.value)}
                                placeholder="0.00"
                            />
                        </div>
                    </div>

                    {/* Parts Used */}
                    <div className="maint-parts-section">
                        <div className="maint-parts-header">
                            <h4>Parts Used</h4>
                            <button type="button" className="btn btn-sm" onClick={addPart}>+ Add Part</button>
                        </div>
                        {formData.parts_used.map((part, i) => (
                            <div key={i} className="maint-part-row">
                                <input
                                    type="text"
                                    placeholder="Part name"
                                    value={part.name}
                                    onChange={e => updatePart(i, 'name', e.target.value)}
                                />
                                <input
                                    type="number"
                                    min="1"
                                    placeholder="Qty"
                                    value={part.quantity}
                                    onChange={e => updatePart(i, 'quantity', parseInt(e.target.value) || 0)}
                                    className="part-qty"
                                />
                                <button type="button" className="maint-part-remove" onClick={() => removePart(i)}>✕</button>
                            </div>
                        ))}
                    </div>

                    {/* Total */}
                    <div className="maint-form-total">
                        <span>Total Cost:</span>
                        <strong>${totalCost}</strong>
                    </div>

                    {/* Actions */}
                    <div className="maint-form-actions">
                        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={saving}>
                            {saving ? 'Saving...' : isEdit ? 'Update Log' : 'Create Log'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    )
}

export default MaintenanceForm
