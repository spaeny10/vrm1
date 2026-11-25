import { useEffect, useState } from 'react'
import { createTrailer, updateTrailerAsset, fetchTrailers, fetchBoardTrailers } from '../api/vrm'
import { useToast } from './ToastProvider'
import { Modal, Field } from '../ui'
import { TRAILER_STATUS_LABELS } from './RentalLifecycle'
import { isoDate } from '../ui/format'

// Add a trailer to the asset registry, or edit one (pass trailerId)
export default function TrailerFormModal({ trailerId, onSaved, onClose }) {
    const toast = useToast()
    const isNew = !trailerId
    const [form, setForm] = useState({
        unit_number: '', product_code: 'BV1305', vin: '', vrm_site_id: '', status: 'available', purchase_date: '', condition_notes: '',
    })
    const [loaded, setLoaded] = useState(isNew)
    const [saving, setSaving] = useState(false)
    const [telemetry, setTelemetry] = useState([])

    // Every Cerbo and router the app can see, so linking is a choice, not a number to look up
    useEffect(() => {
        fetchBoardTrailers().then(d => setTelemetry(
            (d.trailers || []).filter(r => r.site_id != null)
                .map(r => ({
                    id: r.site_id,
                    label: `${r.unit} · ${r.site_id > 0 ? (r.has_router ? 'Cerbo and router' : 'Cerbo') : 'router only'}`,
                }))
                .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
        )).catch(() => setTelemetry([]))
    }, [trailerId])

    useEffect(() => {
        if (isNew) return
        fetchTrailers().then(d => {
            const t = (d.trailers || []).find(x => x.id === trailerId)
            if (t) setForm({
                unit_number: t.unit_number || '', product_code: t.product_code || 'BV1305', vin: t.vin || '',
                vrm_site_id: t.vrm_site_id ?? '', status: t.status || 'available',
                purchase_date: isoDate(t.purchase_date), condition_notes: t.condition_notes || '',
            })
            setLoaded(true)
        }).catch(err => { toast.error(err.message); onClose() })
    }, [trailerId])

    const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

    const save = async () => {
        setSaving(true)
        try {
            const payload = {
                unit_number: form.unit_number.trim(),
                product_code: form.product_code.trim() || 'BV1305',
                vin: form.vin.trim() || null,
                vrm_site_id: form.vrm_site_id !== '' ? parseInt(form.vrm_site_id) : null,
                status: form.status,
                purchase_date: form.purchase_date || null,
                condition_notes: form.condition_notes || null,
            }
            if (isNew) await createTrailer(payload)
            else await updateTrailerAsset(trailerId, payload)
            toast.success(isNew ? `${payload.unit_number} added to the fleet` : `${payload.unit_number} updated`)
            onSaved?.()
            onClose()
        } catch (err) {
            toast.error(err.message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <Modal title={isNew ? 'Add trailer' : `Edit ${form.unit_number || 'trailer'}`} onClose={onClose}
            footer={<>
                <button className="btn ghost" onClick={onClose}>Cancel</button>
                <button className="btn primary" onClick={save} disabled={saving || !loaded || !form.unit_number.trim()}>{saving ? 'Saving…' : isNew ? 'Add trailer' : 'Save'}</button>
            </>}>
            <div className="form">
                <div className="form-row">
                    <Field label="Unit number"><input className="input" value={form.unit_number} onChange={set('unit_number')} placeholder="BV-142" autoFocus /></Field>
                    <Field label="Product"><input className="input" value={form.product_code} onChange={set('product_code')} /></Field>
                </div>
                <div className="form-row">
                    <Field label="VIN / serial"><input className="input" value={form.vin} onChange={set('vin')} /></Field>
                    <Field label="Purchase date"><input className="input" type="date" value={form.purchase_date} onChange={set('purchase_date')} /></Field>
                </div>
                <div className="form-row">
                    <Field label="Telemetry" hint="The Cerbo and router this trailer reports through">
                        <select className="select" value={form.vrm_site_id} onChange={set('vrm_site_id')}>
                            <option value="">Not linked</option>
                            {form.vrm_site_id !== '' && !telemetry.some(t => String(t.id) === String(form.vrm_site_id)) && (
                                <option value={form.vrm_site_id}>VRM {form.vrm_site_id} (no longer found)</option>
                            )}
                            {telemetry.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </select>
                    </Field>
                    <Field label="Status" hint="Rental events set this automatically">
                        <select className="select" value={form.status} onChange={set('status')}>
                            {Object.entries(TRAILER_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                    </Field>
                </div>
                <Field label="Condition notes"><textarea className="textarea" rows={2} value={form.condition_notes} onChange={set('condition_notes')} /></Field>
            </div>
        </Modal>
    )
}
