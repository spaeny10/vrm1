import { useState, useEffect } from 'react'

const COMPONENT_TYPES = [
    { value: 'battery', label: 'Battery' },
    { value: 'solar_panel', label: 'Solar Panel' },
    { value: 'inverter', label: 'Inverter' },
    { value: 'charge_controller', label: 'Charge Controller' },
    { value: 'router', label: 'Router' },
    { value: 'camera', label: 'Camera' },
    { value: 'other', label: 'Other' },
]

function ComponentForm({ component, siteId, onSave, onClose }) {
    const [formData, setFormData] = useState({
        site_id: siteId,
        component_type: '',
        make: '',
        model: '',
        serial_number: '',
        installed_date: '',
        warranty_expiry: '',
        status: 'active',
        notes: '',
    })

    useEffect(() => {
        if (component) {
            setFormData({
                site_id: component.site_id || siteId,
                component_type: component.component_type || '',
                make: component.make || '',
                model: component.model || '',
                serial_number: component.serial_number || '',
                installed_date: component.installed_date
                    ? new Date(Number(component.installed_date)).toISOString().slice(0, 10)
                    : '',
                warranty_expiry: component.warranty_expiry
                    ? new Date(Number(component.warranty_expiry)).toISOString().slice(0, 10)
                    : '',
                status: component.status || 'active',
                notes: component.notes || '',
            })
        }
    }, [component, siteId])

    const set = (key, val) => setFormData(prev => ({ ...prev, [key]: val }))

    const handleSubmit = (e) => {
        e.preventDefault()
        const payload = {
            ...formData,
            installed_date: formData.installed_date ? new Date(formData.installed_date).getTime() : null,
            warranty_expiry: formData.warranty_expiry ? new Date(formData.warranty_expiry).getTime() : null,
        }
        onSave(payload)
    }

    return (
        <div className="maint-form-overlay" onClick={onClose}>
            <div className="maint-form-panel" onClick={e => e.stopPropagation()}>
                <div className="maint-form-header">
                    <h2>{component ? 'Edit Component' : 'Add Component'}</h2>
                    <button className="maint-form-close" onClick={onClose}>✕</button>
                </div>
                <form onSubmit={handleSubmit} className="maint-form-body">
                    <div className="maint-form-grid">
                        <div className="maint-form-group">
                            <label>Type *</label>
                            <select value={formData.component_type} onChange={e => set('component_type', e.target.value)} required>
                                <option value="">Select type...</option>
                                {COMPONENT_TYPES.map(t => (
                                    <option key={t.value} value={t.value}>{t.label}</option>
                                ))}
                            </select>
                        </div>
                        <div className="maint-form-group">
                            <label>Status</label>
                            <select value={formData.status} onChange={e => set('status', e.target.value)}>
                                <option value="active">Active</option>
                                <option value="replaced">Replaced</option>
                                <option value="failed">Failed</option>
                            </select>
                        </div>
                        <div className="maint-form-group">
                            <label>Make</label>
                            <input type="text" value={formData.make} onChange={e => set('make', e.target.value)} placeholder="e.g., Victron, LG, Peplink" />
                        </div>
                        <div className="maint-form-group">
                            <label>Model</label>
                            <input type="text" value={formData.model} onChange={e => set('model', e.target.value)} />
                        </div>
                        <div className="maint-form-group">
                            <label>Serial Number</label>
                            <input type="text" value={formData.serial_number} onChange={e => set('serial_number', e.target.value)} />
                        </div>
                        <div className="maint-form-group">
                            <label>Installed Date</label>
                            <input type="date" value={formData.installed_date} onChange={e => set('installed_date', e.target.value)} />
                        </div>
                        <div className="maint-form-group">
                            <label>Warranty Expiry</label>
                            <input type="date" value={formData.warranty_expiry} onChange={e => set('warranty_expiry', e.target.value)} />
                        </div>
                    </div>
                    <div className="maint-form-group">
                        <label>Notes</label>
                        <textarea value={formData.notes} onChange={e => set('notes', e.target.value)} rows={3} placeholder="Additional details..." />
                    </div>
                    <div className="maint-form-actions">
                        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
                        <button type="submit" className="btn btn-primary">{component ? 'Update' : 'Add Component'}</button>
                    </div>
                </form>
            </div>
        </div>
    )
}

export default ComponentForm
