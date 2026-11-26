import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useToast } from '../components/ToastProvider'
import { apiGet, apiPost, apiPut } from '../api/vrm'
import { Page, Card, Badge, HealthBadge, Soc, Signal, Seg, Field, Modal, KV, Empty, Loading, Icon } from '../ui'
import { TICKET_STATUS, fmtAgo, fmtDate, fmtDateTime, fmtKwh } from '../ui/format'
import Thread from '../components/helpdesk/Thread'

const VISIT_STATUS = { scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }

// One request: the conversation on the left, and beside it what the trailer
// is doing right now, so the answer can be written without leaving the page.
export default function HelpDeskTicket() {
    const { id } = useParams()
    const { user } = useAuth()
    const toast = useToast()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const fetchFn = useCallback(() => apiGet(`/tickets/${id}`), [id])
    const { data, loading, error, refetch } = useApiPolling(fetchFn, 30000)
    const [staff, setStaff] = useState([])
    const [busy, setBusy] = useState(false)
    const [scheduling, setScheduling] = useState(false)

    useEffect(() => { apiGet('/tickets/staff').then(d => setStaff(d.staff || [])).catch(() => { }) }, [])

    if (loading && !data) return <Loading label="Loading request…" />
    if (!data?.ticket) {
        return (
            <Page title="Request not found" crumbs={[{ label: 'Help desk', to: '/helpdesk' }, { label: `#${id}` }]}>
                <Empty title="We couldn't find this request">{error || 'It may have been removed.'} <Link to="/helpdesk" className="link">Back to the help desk</Link></Empty>
            </Page>
        )
    }

    const { ticket: t, messages, trailer_now: now, visit } = data
    const st = TICKET_STATUS[t.status] || TICKET_STATUS.open
    const resolved = t.status === 'resolved'
    const mine = t.assignee_id === user?.id

    const change = async (patch, done) => {
        setBusy(true)
        try {
            await apiPut(`/tickets/${t.id}`, patch)
            await refetch()
            if (done) toast.success(done)
        } catch (err) { toast.error(err.message) } finally { setBusy(false) }
    }

    const lastCustomer = [...messages].reverse().find(m => m.author_role === 'customer')
    const where = [t.trailer_unit, t.job_site_name, t.company_name].filter(Boolean).join(' · ')

    return (
        <Page
            crumbs={[{ label: 'Help desk', to: '/helpdesk' }, { label: `#${t.id}` }]}
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>{t.subject}<Badge tone={st.tone}>{st.label}</Badge>{t.priority === 'urgent' && !resolved && <Badge tone="warn">Urgent</Badge>}</span>}
            sub={[where, t.requester_name ? `from ${t.requester_name}` : `opened by ${t.created_by || 'our team'}`, fmtAgo(t.created_at)].filter(Boolean).join(' · ')}
            actions={canEdit && <>
                {!mine && !resolved && <button className="btn" disabled={busy} onClick={() => change({ assignee_id: user.id }, 'Assigned to you')}>Assign to me</button>}
                {resolved
                    ? <button className="btn" disabled={busy} onClick={() => change({ status: 'open' }, 'Reopened')}>Reopen</button>
                    : <button className="btn primary" disabled={busy} onClick={() => change({ status: 'resolved' }, 'Resolved')}><Icon name="check" />Resolve</button>}
            </>}>
            <div className="grid-main">
                <div className="stack">
                    {t.awaiting_reply && !resolved && (
                        <div className="callout warn">
                            <Icon name="alert" size={18} />
                            <div><b>{t.requester_name || 'The customer'} is waiting for a reply.</b>{lastCustomer ? ` Their last message was ${fmtAgo(lastCustomer.created_at)}.` : ''}</div>
                        </div>
                    )}
                    {visit?.status === 'completed' && !resolved && (
                        <div className="callout ok">
                            <Icon name="checkCircle" size={18} />
                            <div style={{ flex: 1 }}><b>The field visit is complete.</b> If that fixed it, let the customer know and resolve the request.</div>
                        </div>
                    )}
                    <Card title="Conversation">
                        <Thread messages={messages} empty={t.customer_visible ? 'No messages yet. Reply below to let the customer know you’re on it.' : 'No notes yet.'} />
                        {canEdit && <Composer ticket={t} onSent={refetch} />}
                    </Card>
                </div>

                <div className="stack">
                    <TrailerNow ticket={t} now={now} />
                    <Card title="Request">
                        <div className="form">
                            <Field label="Assigned to">
                                <select className="select" value={t.assignee_id ?? ''} disabled={!canEdit || busy} onChange={e => change({ assignee_id: e.target.value === '' ? null : Number(e.target.value) })}>
                                    <option value="">Unassigned</option>
                                    {t.assignee_id != null && !staff.some(s => s.id === t.assignee_id) && <option value={t.assignee_id}>{t.assignee_name || 'Former user'}</option>}
                                    {staff.map(s => <option key={s.id} value={s.id}>{s.display_name}{s.id === user?.id ? ' (me)' : ''}</option>)}
                                </select>
                            </Field>
                            <div className="form-row">
                                <Field label="Status">
                                    <select className="select" value={t.status} disabled={!canEdit || busy} onChange={e => change({ status: e.target.value })}>
                                        {Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                                    </select>
                                </Field>
                                <Field label="Priority">
                                    <select className="select" value={t.priority} disabled={!canEdit || busy} onChange={e => change({ priority: e.target.value })}>
                                        <option value="normal">Normal</option>
                                        <option value="urgent">Urgent</option>
                                    </select>
                                </Field>
                            </div>
                            <KV items={[
                                ['Reported by', t.requester_name || (t.customer_visible ? 'Customer' : 'Our team')],
                                t.requester_phone && ['Phone', <a className="link" href={`tel:${t.requester_phone}`}>{t.requester_phone}</a>],
                                t.requester_email && ['Email', <a className="link" href={`mailto:${t.requester_email}`}>{t.requester_email}</a>],
                                t.job_site_id && ['Site', <Link className="link" to={`/site/${t.job_site_id}`}>{t.job_site_name}</Link>],
                                t.company_name && ['Customer', t.company_name],
                                ['Opened', fmtDateTime(t.created_at)],
                                ['First reply', t.first_response_at ? fmtDateTime(t.first_response_at) : t.customer_visible ? 'Not yet' : '—'],
                                resolved && ['Resolved', fmtDateTime(t.resolved_at)],
                                ['Shared with customer', t.customer_visible ? 'Yes' : 'No, internal'],
                            ]} />
                        </div>
                    </Card>
                    <Card title="Field visit">
                        {visit && visit.status !== 'cancelled' ? (
                            <KV items={[
                                ['Status', VISIT_STATUS[visit.status] || visit.status],
                                ['When', visit.scheduled_date ? fmtDate(visit.scheduled_date) : 'Not dated'],
                                ['Technician', visit.technician || 'Unassigned'],
                                ['Work order', <Link className="link" to="/maintenance">{visit.title}</Link>],
                            ]} />
                        ) : (
                            <div style={{ display: 'grid', gap: 10 }}>
                                <span className="muted" style={{ fontSize: 13.5 }}>If this needs hands on site, schedule a visit. It appears in Field service, linked to this request.</span>
                                {canEdit && <div><button className="btn" onClick={() => setScheduling(true)}><Icon name="calendar" />Schedule a visit</button></div>}
                            </div>
                        )}
                    </Card>
                </div>
            </div>
            {scheduling && <VisitModal ticket={t} staff={staff} me={user} onClose={() => setScheduling(false)} onDone={() => { setScheduling(false); refetch() }} />}
        </Page>
    )
}

function TrailerNow({ ticket: t, now }) {
    if (!now) {
        return (
            <Card title="Trailer now">
                <span className="muted" style={{ fontSize: 13.5 }}>
                    {t.trailer_unit ? `${t.trailer_unit} is no longer on the fleet list.` : 'This request isn’t linked to a trailer.'}
                </span>
            </Card>
        )
    }
    const to = now.site_id != null ? `/trailer/${now.site_id}` : '/trailers?health=unknown'
    return (
        <Card title="Trailer now" actions={<Link className="btn ghost sm" to={to}>Open trailer<Icon name="chevron" /></Link>}>
            <div style={{ display: 'grid', gap: 12 }}>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontWeight: 600 }}>{now.unit}<HealthBadge health={now.health} /></div>
                    <div className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>{now.diagnosis || (now.health === 'good' ? 'Reporting normally.' : '—')}</div>
                </div>
                <KV items={[
                    ['Battery', <Soc value={now.soc} />],
                    ['Solar today', fmtKwh(now.yield_today_kwh)],
                    ['Router', <Signal bars={now.signal_bars} online={now.online} hasRouter={now.has_router} />],
                    ['Last data', now.last_seen ? fmtAgo(now.last_seen) : 'Never'],
                    ['Where', now.site?.name || 'No site'],
                ]} />
            </div>
        </Card>
    )
}

function Composer({ ticket: t, onSent }) {
    const toast = useToast()
    const [mode, setMode] = useState(t.customer_visible ? 'reply' : 'note')
    const [body, setBody] = useState('')
    const [then, setThen] = useState('')
    const [sending, setSending] = useState(false)
    const internal = mode === 'note' || !t.customer_visible

    const send = async (e) => {
        e.preventDefault()
        if (!body.trim()) return
        setSending(true)
        try {
            await apiPost(`/tickets/${t.id}/messages`, { body: body.trim(), internal, then: then || null })
            setBody(''); setThen('')
            await onSent()
            toast.success(internal ? 'Note added' : 'Reply sent')
        } catch (err) { toast.error(err.message) } finally { setSending(false) }
    }

    const hint = internal
        ? (t.customer_visible ? 'Only our team sees notes.' : 'This request is internal, so everything here stays with our team.')
        : t.requester_email ? `Emailed to ${t.requester_email}${t.requester_user_id ? ' and shown in their portal.' : '.'}`
            : 'No email on file. The reply is shown in the customer’s portal only, so call them if it’s urgent.'

    return (
        <form className="composer" onSubmit={send}>
            {t.customer_visible && (
                <div><Seg value={mode} onChange={setMode} options={[{ key: 'reply', label: 'Reply to customer' }, { key: 'note', label: 'Internal note' }]} /></div>
            )}
            <textarea className="textarea" rows={4} value={body} onChange={e => setBody(e.target.value)} maxLength={4000}
                placeholder={internal ? 'What you checked, what you found, what’s next…' : 'Write to the customer…'} />
            <div className="composer-foot">
                <span className="hint">{hint}</span>
                <select className="select" value={then} onChange={e => setThen(e.target.value)} aria-label="Status after sending">
                    <option value="">Keep status</option>
                    {t.customer_visible && t.status !== 'waiting' && <option value="waiting">Then wait on customer</option>}
                    {t.status !== 'resolved' && <option value="resolved">Then resolve</option>}
                </select>
                <button className="btn primary" disabled={sending || !body.trim()}>{sending ? 'Sending…' : internal ? 'Add note' : 'Send reply'}</button>
            </div>
        </form>
    )
}

function VisitModal({ ticket: t, staff, me, onClose, onDone }) {
    const toast = useToast()
    const tomorrow = new Date(Date.now() + 86400000)
    const iso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
    const [f, setF] = useState({ date: iso, tech: staff.some(s => s.id === me?.id) ? String(me.id) : '', type: 'repair', description: '' })
    const [saving, setSaving] = useState(false)
    const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))

    const save = async () => {
        setSaving(true)
        try {
            // Noon local time, so the date never slips a day in another timezone
            const [y, m, d] = f.date ? f.date.split('-').map(Number) : []
            await apiPost(`/tickets/${t.id}/visit`, {
                scheduled_date: f.date ? new Date(y, m - 1, d, 12).getTime() : null,
                assigned_technician_id: f.tech ? Number(f.tech) : null,
                visit_type: f.type,
                description: f.description,
            })
            toast.success('Visit scheduled in Field service')
            onDone()
        } catch (err) {
            toast.error(err.message)
            setSaving(false)
        }
    }

    return (
        <Modal title="Schedule a field visit" onClose={onClose}
            footer={<>
                <button className="btn ghost" onClick={onClose}>Cancel</button>
                <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Scheduling…' : 'Schedule visit'}</button>
            </>}>
            <div className="form">
                <p className="muted" style={{ fontSize: 13.5 }}>
                    {[t.trailer_unit, t.job_site_name].filter(Boolean).join(' at ') || 'No trailer or site on this request'} — “{t.subject}”
                </p>
                <div className="form-row">
                    <Field label="Date"><input className="input" type="date" value={f.date} onChange={set('date')} /></Field>
                    <Field label="Technician">
                        <select className="select" value={f.tech} onChange={set('tech')}>
                            <option value="">Decide later</option>
                            {staff.map(s => <option key={s.id} value={s.id}>{s.display_name}</option>)}
                        </select>
                    </Field>
                </div>
                <Field label="Type">
                    <select className="select" value={f.type} onChange={set('type')}>
                        <option value="repair">Repair</option>
                        <option value="inspection">Inspection</option>
                    </select>
                </Field>
                <Field label="Notes for the visit"><textarea className="textarea" rows={3} value={f.description} onChange={set('description')} maxLength={4000} placeholder="What to bring, what to check, who to meet on site…" /></Field>
            </div>
        </Modal>
    )
}
