import { useEffect, useMemo, useState } from 'react'
import { Modal, Field, Icon, Badge } from '../ui'
import { isoDate, fmtDate, fmtMoney } from '../ui/format'
import {
    fetchJobSites, fetchBoardTrailers, fetchCompletedChecklists,
    createMaintenanceLog, updateMaintenanceLog,
} from '../api/vrm'
import { useToast } from './ToastProvider'

export const VISIT_TYPES = [
    { value: 'inspection', label: 'Inspection' },
    { value: 'repair', label: 'Repair' },
    { value: 'scheduled', label: 'Scheduled maintenance' },
    { value: 'emergency', label: 'Emergency' },
    { value: 'installation', label: 'Installation' },
    { value: 'decommission', label: 'Decommission' },
]
export const VISIT_LABEL = Object.fromEntries(VISIT_TYPES.map(v => [v.value, v.label]))

export const STATUSES = [
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'in_progress', label: 'In progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
]
export const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.value, s.label]))

// Mirrors VALID_RECURRENCE / getNextDate in server/routes/maintenance.js
const RECURRENCE = [
    { value: '', label: 'Does not repeat' },
    { value: 'weekly', label: 'Every week' },
    { value: 'biweekly', label: 'Every 2 weeks' },
    { value: 'monthly', label: 'Every month' },
    { value: 'quarterly', label: 'Every 3 months' },
    { value: 'yearly', label: 'Every year' },
]
const RECURRENCE_LABEL = Object.fromEntries(RECURRENCE.map(r => [r.value, r.label]))

const hhmm = (ms) => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const dollars = (cents) => (cents ? (Number(cents) / 100).toFixed(2) : '')
const toCents = (v) => {
    const n = parseFloat(v)
    return isNaN(n) || n < 0 ? 0 : Math.round(n * 100)
}
// Completion timestamps: "now" when the date is today, otherwise local noon
export function completedMs(dateStr) {
    if (!dateStr) return null
    if (dateStr === isoDate(Date.now())) return Date.now()
    return new Date(`${dateStr}T12:00:00`).getTime()
}

// Schedule a new field service visit, or edit an existing one.
// props: log (edit) | prefill {site_id, job_site_id, date} (new), users, issueTemplates,
//        onSaved(log), onClose(), onCancelJob(log)
export default function MaintenanceForm({ log, prefill, users = [], issueTemplates = [], showMoney = true, onSaved, onClose, onCancelJob }) {
    const toast = useToast()
    const isEdit = !!log

    const [jobSites, setJobSites] = useState([])
    const [trailers, setTrailers] = useState([])
    const [pastChecklists, setPastChecklists] = useState([])

    const [f, setF] = useState(() => ({
        job_site_id: log?.job_site_id ?? prefill?.job_site_id ?? '',
        site_id: log?.site_id ?? prefill?.site_id ?? '',
        visit_type: log?.visit_type || 'inspection',
        status: log?.status || 'scheduled',
        title: log?.title || '',
        description: log?.description || '',
        assigned_technician_id: log?.assigned_technician_id ?? '',
        technician: log?.technician || '',
        date: log?.scheduled_date ? isoDate(log.scheduled_date) : (prefill?.date || ''),
        time: log?.scheduled_date ? hhmm(log.scheduled_date) : '09:00',
        completed_date: log?.completed_date ? isoDate(log.completed_date) : '',
        labor_hours: log?.labor_hours ?? '',
        labor_cost: dollars(log?.labor_cost_cents),
        parts_cost: dollars(log?.parts_cost_cents),
        parts_used: Array.isArray(log?.parts_used) ? log.parts_used.map(p => ({ name: p.name || '', quantity: p.quantity || 1, cost_cents: p.cost_cents || 0 })) : [],
        recurrence_rule: '',
        recurrence_end_date: '',
    }))
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState(null)
    const set = (k, v) => setF(p => ({ ...p, [k]: v }))

    // Reference data for the selects
    useEffect(() => {
        let alive = true
        fetchJobSites().then(d => { if (alive) setJobSites(d.job_sites || []) }).catch(err => toast.error(`Couldn't load job sites: ${err.message}`))
        fetchBoardTrailers().then(d => { if (alive) setTrailers(d.trailers || []) }).catch(err => toast.error(`Couldn't load trailers: ${err.message}`))
        if (log?.id && log.status === 'completed') {
            fetchCompletedChecklists(log.id).then(d => { if (alive) setPastChecklists(d.checklists || []) }).catch(() => {})
        }
        return () => { alive = false }
    }, [log?.id, log?.status, toast])

    // Deep link may give a trailer without its site: derive the site from the board
    useEffect(() => {
        if (f.job_site_id || !f.site_id || !trailers.length) return
        const t = trailers.find(t => String(t.site_id) === String(f.site_id))
        if (t?.site?.id) set('job_site_id', t.site.id)
    }, [trailers, f.job_site_id, f.site_id])

    const siteTrailers = useMemo(() => {
        if (!f.job_site_id) return []
        const list = trailers
            .filter(t => t.site_id != null && String(t.site?.id) === String(f.job_site_id))
            .map(t => ({ value: t.site_id, label: t.unit }))
        // Keep the current trailer selectable even if it has since moved
        if (f.site_id && !list.some(t => String(t.value) === String(f.site_id))) {
            const t = trailers.find(t => String(t.site_id) === String(f.site_id))
            list.push({ value: f.site_id, label: `${t?.unit || log?.trailer_name || `Trailer ${f.site_id}`}${t ? ' (now elsewhere)' : ''}` })
        }
        return list.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    }, [trailers, f.job_site_id, f.site_id, log?.trailer_name])

    const sortedSites = useMemo(() => [...jobSites].sort((a, b) => a.name.localeCompare(b.name)), [jobSites])
    const staff = useMemo(() => users.filter(u => u.role !== 'customer'), [users])

    const changeSite = (id) => setF(p => {
        const keep = trailers.find(t => String(t.site_id) === String(p.site_id))
        return { ...p, job_site_id: id, site_id: keep && String(keep.site?.id) === String(id) ? p.site_id : '' }
    })

    const changeStatus = (status) => setF(p => ({
        ...p, status,
        completed_date: status === 'completed' ? (p.completed_date || isoDate(Date.now())) : '',
    }))

    const changeAssignee = (id) => {
        const u = staff.find(u => String(u.id) === String(id))
        setF(p => ({ ...p, assigned_technician_id: id, technician: u ? u.display_name : '' }))
    }

    const applyTemplate = (id) => {
        const tpl = issueTemplates.find(t => String(t.id) === String(id))
        if (!tpl) return
        setF(p => ({
            ...p,
            visit_type: tpl.visit_type || p.visit_type,
            title: tpl.title || p.title,
            description: tpl.description || p.description,
            labor_hours: tpl.estimated_hours ?? p.labor_hours,
            parts_used: tpl.expected_parts?.length
                ? tpl.expected_parts.map(x => ({ name: x.name || String(x), quantity: x.quantity || 1, cost_cents: x.cost_cents || 0 }))
                : p.parts_used,
        }))
    }

    // Parts
    const setPart = (i, k, v) => setF(p => ({ ...p, parts_used: p.parts_used.map((x, j) => j === i ? { ...x, [k]: v } : x) }))
    const addPart = () => setF(p => ({ ...p, parts_used: [...p.parts_used, { name: '', quantity: 1, cost_cents: 0 }] }))
    const removePart = (i) => setF(p => ({ ...p, parts_used: p.parts_used.filter((_, j) => j !== i) }))
    const itemsTotal = f.parts_used.reduce((s, x) => s + (Number(x.cost_cents) || 0) * (Number(x.quantity) || 1), 0)
    // When parts carry per-item costs the total comes from them; otherwise the
    // manual parts cost (prefilled from the saved log) is kept as-is.
    const partsCents = itemsTotal > 0 ? itemsTotal : toCents(f.parts_cost)
    const totalCents = toCents(f.labor_cost) + partsCents

    const submit = async (e) => {
        e.preventDefault()
        setError(null)
        if (!f.title.trim()) return setError('Give the job a title.')
        if (f.recurrence_rule && !f.date) return setError('A repeating job needs a scheduled date.')
        const parts = f.parts_used.filter(p => p.name.trim()).map(p => ({ name: p.name.trim(), quantity: Number(p.quantity) || 1, cost_cents: Number(p.cost_cents) || 0 }))
        const payload = {
            job_site_id: f.job_site_id ? Number(f.job_site_id) : null,
            site_id: f.site_id !== '' && f.site_id != null ? Number(f.site_id) : null,
            visit_type: f.visit_type,
            status: f.status,
            title: f.title.trim(),
            description: f.description.trim() || null,
            assigned_technician_id: f.assigned_technician_id ? Number(f.assigned_technician_id) : null,
            technician: f.technician?.trim() || null,
            scheduled_date: f.date ? new Date(`${f.date}T${f.time || '09:00'}`).getTime() : null,
            completed_date: f.status === 'completed' ? (log?.completed_date && isoDate(log.completed_date) === f.completed_date ? log.completed_date : completedMs(f.completed_date || isoDate(Date.now()))) : null,
            labor_hours: f.labor_hours === '' ? null : Number(f.labor_hours),
            labor_cost_cents: toCents(f.labor_cost),
            parts_cost_cents: partsCents,
            parts_used: parts.length ? parts : null,
        }
        if (!isEdit && f.recurrence_rule) {
            payload.recurrence_rule = f.recurrence_rule
            payload.recurrence_end_date = f.recurrence_end_date ? new Date(`${f.recurrence_end_date}T23:59:59`).getTime() : null
        }
        setSaving(true)
        try {
            const res = isEdit ? await updateMaintenanceLog(log.id, payload) : await createMaintenanceLog(payload)
            toast.success(isEdit ? 'Job updated' : f.recurrence_rule ? `Scheduled, repeating ${RECURRENCE_LABEL[f.recurrence_rule].toLowerCase()}` : 'Service scheduled')
            onSaved?.(res.log)
        } catch (err) {
            setError(err.message)
        } finally {
            setSaving(false)
        }
    }

    const series = log && (log.recurrence_rule || log.parent_log_id)
    // Costs only matter once work has started (or were already recorded)
    const showCosts = showMoney && (f.status === 'in_progress' || f.status === 'completed' || !!log?.labor_cost_cents || !!log?.parts_cost_cents)

    return (
        <Modal wide title={isEdit ? 'Edit field service job' : 'Schedule service'} onClose={onClose}
            footer={<>
                {isEdit && onCancelJob && log.status !== 'cancelled' && log.status !== 'completed' && (
                    <button type="button" className="btn danger" onClick={() => onCancelJob(log)} style={{ marginRight: 'auto' }}>Cancel job</button>
                )}
                <button type="button" className="btn ghost" onClick={onClose}>Close</button>
                <button type="submit" form="maint-form" className="btn primary" disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Schedule'}</button>
            </>}>
            <form id="maint-form" className="form" onSubmit={submit}>
                {issueTemplates.length > 0 && (
                    <Field label={isEdit ? 'Apply a template' : 'Start from a template'} hint="Fills in type, title, description, hours and parts.">
                        <select className="select" value="" onChange={e => applyTemplate(e.target.value)}>
                            <option value="">Choose a common job…</option>
                            {issueTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                    </Field>
                )}

                <div className="form-row">
                    <Field label="Job site">
                        <select className="select" value={f.job_site_id} onChange={e => changeSite(e.target.value)}>
                            <option value="">Choose a site…</option>
                            {sortedSites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </Field>
                    <Field label="Trailer">
                        <select className="select" value={f.site_id ?? ''} onChange={e => set('site_id', e.target.value)} disabled={!f.job_site_id}>
                            <option value="">{f.job_site_id ? 'Whole site (no specific trailer)' : 'Choose a site first'}</option>
                            {siteTrailers.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                    </Field>
                </div>

                <div className="form-row">
                    <Field label="Visit type">
                        <select className="select" value={f.visit_type} onChange={e => set('visit_type', e.target.value)}>
                            {VISIT_TYPES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                        </select>
                    </Field>
                    <Field label="Status">
                        <select className="select" value={f.status} onChange={e => changeStatus(e.target.value)}>
                            {STATUSES.filter(s => isEdit || s.value !== 'cancelled').map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                    </Field>
                </div>

                <Field label="Title">
                    <input className="input" value={f.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Clean solar panels" required />
                </Field>
                <Field label="Description">
                    <textarea className="textarea" rows={3} value={f.description} onChange={e => set('description', e.target.value)} placeholder="What needs doing on site" />
                </Field>

                <div className="form-row">
                    <div className="form-row">
                        <Field label="Scheduled date">
                            <input className="input" type="date" value={f.date} onChange={e => set('date', e.target.value)} />
                        </Field>
                        <Field label="Time">
                            <input className="input" type="time" value={f.time} onChange={e => set('time', e.target.value)} disabled={!f.date} />
                        </Field>
                    </div>
                    <Field label="Assigned to" hint={!f.assigned_technician_id && f.technician ? `Currently: ${f.technician}` : null}>
                        <select className="select" value={f.assigned_technician_id ?? ''} onChange={e => changeAssignee(e.target.value)}>
                            <option value="">Unassigned</option>
                            {staff.map(u => <option key={u.id} value={u.id}>{u.display_name}{u.role === 'admin' ? ' (admin)' : ''}</option>)}
                        </select>
                    </Field>
                </div>

                {f.status === 'completed' && (
                    <div className="form-row">
                        <Field label="Completed on">
                            <input className="input" type="date" value={f.completed_date} onChange={e => set('completed_date', e.target.value)} />
                        </Field>
                        <div />
                    </div>
                )}

                {!isEdit ? (
                    <div className="form-row">
                        <Field label="Repeat">
                            <select className="select" value={f.recurrence_rule} onChange={e => set('recurrence_rule', e.target.value)}>
                                {RECURRENCE.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                        </Field>
                        {f.recurrence_rule ? (
                            <Field label="Repeat until" hint="Leave blank to schedule one year ahead.">
                                <input className="input" type="date" value={f.recurrence_end_date} min={f.date || undefined} onChange={e => set('recurrence_end_date', e.target.value)} />
                            </Field>
                        ) : <div />}
                    </div>
                ) : series ? (
                    <div className="callout">
                        <Icon name="refresh" size={18} />
                        <span>{log.recurrence_rule ? `First visit of a series repeating ${RECURRENCE_LABEL[log.recurrence_rule]?.toLowerCase() || log.recurrence_rule}${log.recurrence_end_date ? ` until ${fmtDate(log.recurrence_end_date)}` : ''}.` : 'One visit in a repeating series.'} Changes here apply to this visit only.</span>
                    </div>
                ) : null}

                <div className="form-row">
                    <Field label={f.status === 'completed' ? 'Labor hours' : 'Estimated labor hours'}>
                        <input className="input" type="number" min="0" step="0.25" value={f.labor_hours} onChange={e => set('labor_hours', e.target.value)} placeholder="0" />
                    </Field>
                    {showCosts ? (
                        <Field label="Labor cost ($)">
                            <input className="input" type="number" min="0" step="0.01" value={f.labor_cost} onChange={e => set('labor_cost', e.target.value)} placeholder="0.00" />
                        </Field>
                    ) : <div />}
                </div>

                <div className="field">
                    <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>Parts</span>
                        <button type="button" className="btn sm ghost" onClick={addPart}><Icon name="plus" />Add part</button>
                    </span>
                    {f.parts_used.length === 0 ? <div className="faint" style={{ fontSize: 13 }}>No parts listed.</div> : (
                        <div style={{ display: 'grid', gap: 6 }}>
                            {f.parts_used.map((p, i) => (
                                <div key={i} style={{ display: 'grid', gridTemplateColumns: showMoney ? '1fr 70px 110px 32px' : '1fr 70px 32px', gap: 6, alignItems: 'center' }}>
                                    <input className="input" value={p.name} onChange={e => setPart(i, 'name', e.target.value)} placeholder="Part name" aria-label="Part name" />
                                    <input className="input" type="number" min="1" value={p.quantity} onChange={e => setPart(i, 'quantity', parseInt(e.target.value) || 1)} aria-label="Quantity" />
                                    {showMoney && <input className="input" type="number" min="0" step="0.01" value={p.cost_cents ? (p.cost_cents / 100).toFixed(2) : ''}
                                        onChange={e => setPart(i, 'cost_cents', toCents(e.target.value))} placeholder="Unit $" aria-label="Unit cost" />}
                                    <button type="button" className="icon-btn" onClick={() => removePart(i)} aria-label="Remove part"><Icon name="x" /></button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {showCosts && (
                    <div className="form-row">
                        <Field label="Parts cost ($)" hint={itemsTotal > 0 ? 'Calculated from the part prices above.' : 'Enter a total, or price each part above.'}>
                            <input className="input" type="number" min="0" step="0.01" value={itemsTotal > 0 ? (itemsTotal / 100).toFixed(2) : f.parts_cost}
                                onChange={e => set('parts_cost', e.target.value)} readOnly={itemsTotal > 0} placeholder="0.00" />
                        </Field>
                        <Field label="Total cost">
                            <div className="input num" style={{ display: 'flex', alignItems: 'center', background: 'var(--surface-2)' }}>{fmtMoney(totalCents / 100)}</div>
                        </Field>
                    </div>
                )}

                {pastChecklists.length > 0 && (
                    <div className="field">
                        <span>Checklists</span>
                        {pastChecklists.map(c => {
                            const items = Array.isArray(c.items) ? c.items : []
                            const done = items.filter(i => i.checked).length
                            return (
                                <div key={c.id} className="callout">
                                    <Icon name="checkCircle" size={18} />
                                    <span style={{ flex: 1 }}>{c.template_name || 'Checklist'} · {done} of {items.length} done{c.completed_by_name ? ` by ${c.completed_by_name}` : ''}</span>
                                    {done < items.length && <Badge tone="warn">{items.length - done} skipped</Badge>}
                                </div>
                            )
                        })}
                    </div>
                )}

                {error && <div className="callout crit"><Icon name="alert" size={18} /><span>{error}</span></div>}
            </form>
        </Modal>
    )
}
