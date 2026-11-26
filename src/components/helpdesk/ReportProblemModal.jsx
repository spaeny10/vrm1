import { useEffect, useState } from 'react'
import { apiPost, fetchPortalSites } from '../../api/vrm'
import { useToast } from '../ToastProvider'
import { Modal, Field } from '../../ui'

const COMMON = ['A camera has no video', 'The unit looks powered off', 'The unit was moved or damaged', 'We need the unit moved']

// Customer portal: tell BIGView something is wrong. `initial` can preselect { siteId, unit }.
export default function ReportProblemModal({ initial = {}, sites: given, onClose, onCreated }) {
    const toast = useToast()
    const [sites, setSites] = useState(given || [])
    const [siteId, setSiteId] = useState(initial.siteId != null ? String(initial.siteId) : '')
    const [unit, setUnit] = useState(initial.unit != null ? String(initial.unit) : '')
    const [subject, setSubject] = useState('')
    const [body, setBody] = useState('')
    const [sending, setSending] = useState(false)

    useEffect(() => {
        if (given) return
        fetchPortalSites().then(d => setSites(d.sites || [])).catch(err => toast.error(err.message))
    }, [given])

    // With one site there is nothing to choose
    useEffect(() => { if (!siteId && sites.length === 1) setSiteId(String(sites[0].id)) }, [sites, siteId])

    const site = sites.find(s => String(s.id) === siteId)
    const units = site?.trailers || []

    const send = async () => {
        setSending(true)
        try {
            const { ticket } = await apiPost('/portal/tickets', { job_site_id: Number(siteId), trailer: unit || null, subject: subject.trim(), body: body.trim() })
            toast.success('Sent. The BIGView team has been notified.')
            onCreated?.(ticket)
        } catch (err) {
            toast.error(err.message)
            setSending(false)
        }
    }

    return (
        <Modal title="Report a problem" onClose={onClose}
            footer={<>
                <button className="btn ghost" onClick={onClose}>Cancel</button>
                <button className="btn primary" onClick={send} disabled={sending || !siteId || !subject.trim()}>{sending ? 'Sending…' : 'Send to BIGView'}</button>
            </>}>
            <div className="form">
                <div className="form-row">
                    <Field label="Site">
                        <select className="select" value={siteId} onChange={e => { setSiteId(e.target.value); setUnit('') }}>
                            {sites.length !== 1 && <option value="">Choose a site</option>}
                            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </Field>
                    <Field label="Unit">
                        <select className="select" value={unit} onChange={e => setUnit(e.target.value)} disabled={!site}>
                            <option value="">Not sure, or the whole site</option>
                            {units.map(u => <option key={u.site_id} value={u.site_id}>{u.site_name}</option>)}
                        </select>
                    </Field>
                </div>
                <Field label="What's wrong?">
                    <input className="input" value={subject} onChange={e => setSubject(e.target.value)} maxLength={160} placeholder="In a few words" autoFocus />
                    <div className="chips">
                        {COMMON.map(c => <button key={c} type="button" className={`chip ${subject === c ? 'on' : ''}`} onClick={() => setSubject(c)}>{c}</button>)}
                    </div>
                </Field>
                <Field label="Details" hint="Which camera, when it started, and who we should call on site.">
                    <textarea className="textarea" rows={4} value={body} onChange={e => setBody(e.target.value)} maxLength={4000} />
                </Field>
            </div>
        </Modal>
    )
}
