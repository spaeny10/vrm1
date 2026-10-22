import { useState } from 'react'
import { Modal, Field } from '../ui'
import { useToast } from './ToastProvider'
import { epochToISODate, isoDateToEpoch } from './trailer/telemetry'

export const COMPONENT_TYPES = [
    { value: 'battery', label: 'Battery' },
    { value: 'solar_panel', label: 'Solar panel' },
    { value: 'inverter', label: 'Inverter' },
    { value: 'charge_controller', label: 'Charge controller' },
    { value: 'router', label: 'Router' },
    { value: 'camera', label: 'Camera' },
    { value: 'other', label: 'Other' },
]
export const COMPONENT_TYPE_LABELS = Object.fromEntries(COMPONENT_TYPES.map(t => [t.value, t.label]))

// Add or edit a hardware component on a trailer.
// onSave(payload) may be async; errors are shown as a toast and the form stays open.
export default function ComponentForm({ component, siteId, onSave, onClose }) {
    const toast = useToast()
    const [saving, setSaving] = useState(false)
    const [form, setForm] = useState(() => ({
        component_type: component?.component_type || '',
        make: component?.make || '',
        model: component?.model || '',
        serial_number: component?.serial_number || '',
        installed_date: epochToISODate(component?.installed_date),
        warranty_expiry: epochToISODate(component?.warranty_expiry),
        status: component?.status || 'active',
        notes: component?.notes || '',
    }))
    const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

    const submit = async (e) => {
        e?.preventDefault()
        if (!form.component_type) return
        setSaving(true)
        try {
            await onSave({
                site_id: component?.site_id ?? siteId,
                component_type: form.component_type,
                make: form.make.trim() || null,
                model: form.model.trim() || null,
                serial_number: form.serial_number.trim() || null,
                installed_date: isoDateToEpoch(form.installed_date),
                warranty_expiry: isoDateToEpoch(form.warranty_expiry),
                status: form.status,
                notes: form.notes.trim() || null,
            })
        } catch (err) {
            toast.error(err.message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <Modal title={component ? 'Edit component' : 'Add component'} onClose={onClose}
            footer={<>
                <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
                <button className="btn primary" onClick={submit} disabled={saving || !form.component_type}>
                    {saving ? 'Saving…' : component ? 'Save' : 'Add component'}
                </button>
            </>}>
            <form className="form" onSubmit={submit}>
                <div className="form-row">
                    <Field label="Type">
                        <select className="select" value={form.component_type} onChange={set('component_type')} autoFocus>
                            <option value="">Choose a type…</option>
                            {COMPONENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                    </Field>
                    <Field label="Status">
                        <select className="select" value={form.status} onChange={set('status')}>
                            <option value="active">Active</option>
                            <option value="replaced">Replaced</option>
                            <option value="failed">Failed</option>
                        </select>
                    </Field>
                </div>
                <div className="form-row">
                    <Field label="Make"><input className="input" value={form.make} onChange={set('make')} placeholder="e.g. Victron, Peplink" /></Field>
                    <Field label="Model"><input className="input" value={form.model} onChange={set('model')} /></Field>
                </div>
                <Field label="Serial number"><input className="input mono" value={form.serial_number} onChange={set('serial_number')} /></Field>
                <div className="form-row">
                    <Field label="Installed"><input className="input" type="date" value={form.installed_date} onChange={set('installed_date')} /></Field>
                    <Field label="Warranty expires"><input className="input" type="date" value={form.warranty_expiry} onChange={set('warranty_expiry')} /></Field>
                </div>
                <Field label="Notes"><textarea className="textarea" rows={2} value={form.notes} onChange={set('notes')} placeholder="Optional details" /></Field>
                <button type="submit" hidden />
            </form>
        </Modal>
    )
}
