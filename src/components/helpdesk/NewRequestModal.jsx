import { useEffect, useMemo, useState } from 'react'
import { apiPost, fetchBoardSites, fetchBoardTrailers } from '../../api/vrm'
import { useToast } from '../ToastProvider'
import { Modal, Field, Seg } from '../../ui'

// Staff log a request: for a customer who called or emailed, or about a trailer
// our own team spotted. `initial` can prefill { trailer, subject, reportedBy }.
export default function NewRequestModal({ initial = {}, onClose, onCreated }) {
    const toast = useToast()
    const [trailers, setTrailers] = useState([])
    const [sites, setSites] = useState([])
    const [saving, setSaving] = useState(false)
    const [f, setF] = useState({
        subject: initial.subject || '',
        trailer: initial.trailer != null ? String(initial.trailer) : '',
        job_site_id: '',
        reported_by: initial.reportedBy || 'customer',
        requester_name: '', requester_phone: '', requester_email: '',
        body: '',
        urgent: false,
        assign_to_me: true,
    })
    const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

    useEffect(() => {
        fetchBoardTrailers().then(d => setTrailers(d.trailers || [])).catch(() => { })
        fetchBoardSites().then(d => setSites((d.sites || []).filter(s => !s.is_hq))).catch(() => { })
    }, [])

    const refOf = (t) => String(t.site_id ?? t.key)
    const picked = useMemo(() => trailers.find(t => refOf(t) === f.trailer) || null, [trailers, f.trailer])
    // A trailer's site is known, so it decides the site; without one the site is picked by hand
    const siteId = picked?.site && !picked.site.is_hq ? String(picked.site.id) : f.job_site_id
    const options = useMemo(() => [...trailers].sort((a, b) => a.unit.localeCompare(b.unit, undefined, { numeric: true })), [trailers])

    const save = async () => {
        setSaving(true)
        try {
            const { ticket } = await apiPost('/tickets', {
                subject: f.subject.trim(),
                trailer: f.trailer || null,
                job_site_id: siteId ? Number(siteId) : null,
                reported_by: f.reported_by,
                requester_name: f.requester_name, requester_phone: f.requester_phone, requester_email: f.requester_email,
                body: f.body,
                priority: f.urgent ? 'urgent' : 'normal',
                assign_to_me: f.assign_to_me,
                source: initial.source,
            })
            toast.success(`Request #${ticket.id} opened`)
            onCreated?.(ticket)
        } catch (err) {
            toast.error(err.message)
            setSaving(false)
        }
    }

    const forCustomer = f.reported_by === 'customer'
    return (
        <Modal title="New request" onClose={onClose}
            footer={<>
                <button className="btn ghost" onClick={onClose}>Cancel</button>
                <button className="btn primary" onClick={save} disabled={saving || !f.subject.trim()}>{saving ? 'Opening…' : 'Open request'}</button>
            </>}>
            <div className="form">
                <Field label="What's the problem?">
                    <input className="input" value={f.subject} onChange={set('subject')} maxLength={160} placeholder="Camera 2 has no video" autoFocus />
                </Field>
                <div className="form-row">
                    <Field label="Trailer">
                        <select className="select" value={f.trailer} onChange={set('trailer')}>
                            <option value="">Not about one trailer</option>
                            {options.map(t => <option key={t.key} value={refOf(t)}>{t.unit}{t.site ? ` — ${t.site.name}` : ''}</option>)}
                        </select>
                    </Field>
                    <Field label="Site">
                        <select className="select" value={siteId} onChange={set('job_site_id')} disabled={!!(picked?.site && !picked.site.is_hq)}>
                            <option value="">No site</option>
                            {sites.map(s => <option key={s.id} value={s.id}>{s.name}{s.customer ? ` — ${s.customer.name}` : ''}</option>)}
                        </select>
                    </Field>
                </div>
                <Field label="Who reported it?" hint={forCustomer
                    ? 'The customer sees this request and our replies in their portal, and replies are emailed to them.'
                    : 'Internal: the customer never sees this request.'}>
                    <div><Seg value={f.reported_by} onChange={v => setF(p => ({ ...p, reported_by: v }))} options={[{ key: 'customer', label: 'A customer' }, { key: 'team', label: 'Our team' }]} /></div>
                </Field>
                {forCustomer && (
                    <>
                        <div className="form-row">
                            <Field label="Their name"><input className="input" value={f.requester_name} onChange={set('requester_name')} maxLength={120} /></Field>
                            <Field label="Phone"><input className="input" type="tel" value={f.requester_phone} onChange={set('requester_phone')} maxLength={40} /></Field>
                        </div>
                        <Field label="Email" hint="Where our replies are sent"><input className="input" type="email" value={f.requester_email} onChange={set('requester_email')} maxLength={200} /></Field>
                    </>
                )}
                <Field label="Details" hint="What they told you and what you've checked. Kept internal.">
                    <textarea className="textarea" rows={3} value={f.body} onChange={set('body')} maxLength={4000} />
                </Field>
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                    <label className="check"><input type="checkbox" checked={f.assign_to_me} onChange={set('assign_to_me')} />Assign to me</label>
                    <label className="check"><input type="checkbox" checked={f.urgent} onChange={set('urgent')} />Urgent</label>
                </div>
            </div>
        </Modal>
    )
}
