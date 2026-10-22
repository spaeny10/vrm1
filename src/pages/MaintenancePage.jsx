import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useToast } from '../components/ToastProvider'
import { useWorkspace } from '../components/WorkspaceProvider'
import {
    fetchMaintenanceLogs, fetchMaintenanceStats, fetchMaintenanceCalendar, fetchMaintenanceCostsBySite,
    fetchMentionableUsers, fetchIssueTemplates, fetchChecklistTemplates,
    updateMaintenanceLog, deleteMaintenanceLog, submitChecklist,
} from '../api/vrm'
import { Page, Card, Stats, Stat, Dot, Badge, Seg, Chips, Search, Field, Modal, Empty, AllClear, Loading, DataTable, Icon } from '../ui'
import { fmtDate, fmtDateShort, fmtMoney, isoDate, daysSince, plural } from '../ui/format'
import MaintenanceForm, { VISIT_LABEL, STATUS_LABEL, completedMs } from '../components/MaintenanceForm'
import ChecklistPanel, { checklistFromTemplate, missingRequired } from '../components/ChecklistPanel'
import { generateCSV, downloadCSV } from '../utils/csv'

const DAY = 86400000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const isOverdue = (l, now = Date.now()) => l.status === 'scheduled' && l.scheduled_date != null && l.scheduled_date < now
const costOf = (l) => (Number(l.labor_cost_cents) || 0) + (Number(l.parts_cost_cents) || 0)
const assigneeOf = (l) => l.assigned_technician_name || l.technician || null

// Status tone shared by badges, dots and calendar events
function toneOf(l) {
    if (l.status === 'completed') return 'ok'
    if (l.status === 'cancelled') return 'off'
    if (l.status === 'in_progress') return 'info'
    if (isOverdue(l)) return 'crit'
    return 'plain'
}

function StatusBadge({ log }) {
    if (isOverdue(log)) return <Badge tone="crit">Overdue</Badge>
    return <Badge tone={toneOf(log)}>{STATUS_LABEL[log.status] || log.status}</Badge>
}

// "Today 9:00 AM", "Tomorrow", "Thu Oct 30", "3 days overdue"
function whenLabel(l) {
    if (l.status === 'completed') return l.completed_date ? `Done ${fmtDateShort(l.completed_date)}` : 'Done'
    if (l.scheduled_date == null) return 'No date set'
    const ago = daysSince(l.scheduled_date)
    const time = new Date(l.scheduled_date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    if (isOverdue(l) && ago > 0) return `${plural(ago, 'day')} overdue`
    if (ago === 0) return `Today ${time}`
    if (ago === -1) return `Tomorrow ${time}`
    if (ago < 0 && ago > -7) return new Date(l.scheduled_date).toLocaleDateString([], { weekday: 'short' }) + ` ${fmtDateShort(l.scheduled_date)}`
    return fmtDate(l.scheduled_date, { year: ago < -300 || ago > 300 })
}

const dayKey = (ms) => isoDate(ms)

// Field service: maintenance done on site, scheduled by the Fleet Manager.
export default function MaintenancePage() {
    const { user } = useAuth()
    const toast = useToast()
    const { workspace } = useWorkspace()
    const [params, setParams] = useSearchParams()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const showMoney = workspace !== 'tech'

    const [view, setView] = useState('board')
    const [who, setWho] = useState('all') // 'all' | 'mine'

    // ---------- data ----------
    const logsFn = useCallback(() => fetchMaintenanceLogs(), [])
    const statsFn = useCallback(() => fetchMaintenanceStats(), [])
    const { data: logsData, loading: logsLoading, refetch: refetchLogs } = useApiPolling(logsFn, 60000)
    const { data: statsData, refetch: refetchStats } = useApiPolling(statsFn, 60000)
    const logs = useMemo(() => logsData?.logs || [], [logsData])
    const stats = statsData?.stats

    const [users, setUsers] = useState([])
    const [issueTemplates, setIssueTemplates] = useState([])
    const [checklistTemplates, setChecklistTemplates] = useState([])
    useEffect(() => {
        // /users/mentionable works for every staff role (the old page used admin-only /users)
        fetchMentionableUsers().then(d => setUsers(d.users || [])).catch(err => toast.error(`Couldn't load people: ${err.message}`))
        fetchIssueTemplates().then(d => setIssueTemplates(d.templates || [])).catch(() => {})
        fetchChecklistTemplates().then(d => setChecklistTemplates(d.templates || [])).catch(() => {})
    }, [toast])

    const [calTick, setCalTick] = useState(0)
    const refresh = useCallback(() => { refetchLogs(); refetchStats(); setCalTick(t => t + 1) }, [refetchLogs, refetchStats])

    // ---------- overlays ----------
    const [form, setForm] = useState(null) // { log } | { prefill }
    const [completing, setCompleting] = useState(null)
    const [cancelling, setCancelling] = useState(null)
    const [busy, setBusy] = useState(null)

    // Deep link from other pages: /maintenance?new=1&site_id=X&job_site_id=Y
    useEffect(() => {
        if (params.get('new') !== '1') return
        if (canEdit) {
            setForm({ prefill: { site_id: params.get('site_id') || '', job_site_id: params.get('job_site_id') || '' } })
        } else if (user) {
            toast.info('You have view-only access, so you can’t schedule service.')
        } else return
        setParams({}, { replace: true })
    }, [params, setParams, canEdit, user, toast])

    const mine = useCallback((l) => !!user && Number(l.assigned_technician_id) === Number(user.id), [user])
    const scoped = useMemo(() => who === 'mine' ? logs.filter(mine) : logs, [logs, who, mine])
    const mineOpen = useMemo(() => logs.filter(l => mine(l) && (l.status === 'scheduled' || l.status === 'in_progress')).length, [logs, mine])

    const counts = useMemo(() => {
        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
        return {
            inProgress: stats?.in_progress_count != null ? Number(stats.in_progress_count) : logs.filter(l => l.status === 'in_progress').length,
            doneMonth: stats?.completed_mtd != null ? Number(stats.completed_mtd) : logs.filter(l => l.status === 'completed' && l.completed_date >= monthStart.getTime()).length,
        }
    }, [logs, stats])

    // ---------- actions ----------
    const start = async (l) => {
        setBusy(l.id)
        try {
            await updateMaintenanceLog(l.id, { status: 'in_progress' })
            toast.success(`Started: ${l.title}`)
            refresh()
        } catch (err) { toast.error(err.message) } finally { setBusy(null) }
    }

    const confirmCancel = async () => {
        const l = cancelling
        setBusy(l.id)
        try {
            await deleteMaintenanceLog(l.id) // soft cancel: sets status = 'cancelled'
            toast.success('Job cancelled')
            setCancelling(null)
            setForm(null)
            refresh()
        } catch (err) { toast.error(err.message) } finally { setBusy(null) }
    }

    const openNew = (prefill = {}) => setForm({ prefill })
    const edit = (l) => canEdit && setForm({ log: l })
    const actions = { canEdit, busy, onStart: start, onComplete: setCompleting, onEdit: edit, showMoney }

    const whoChips = (
        <Chips value={who} onChange={setWho} options={[
            { key: 'all', label: 'Everyone' },
            { key: 'mine', label: 'Mine', count: mineOpen },
        ]} />
    )

    return (
        <Page title="Field service" sub="On-site maintenance and repairs, overdue first"
            actions={<>
                <Seg value={view} onChange={setView} options={[{ key: 'board', label: 'Board' }, { key: 'calendar', label: 'Calendar' }, { key: 'list', label: 'List' }]} />
                {canEdit && <button className="btn primary" onClick={() => openNew()}><Icon name="plus" />Schedule service</button>}
            </>}>
            <Stats>
                <Stat label="Overdue" value={stats ? Number(stats.overdue_count) : '—'} tone={Number(stats?.overdue_count) ? 'crit' : null}
                    hint={Number(stats?.overdue_count) ? 'Past their scheduled time' : 'Nothing late'} />
                <Stat label="Due this week" value={stats ? Number(stats.upcoming_week) : '—'} hint="Scheduled in the next 7 days" />
                <Stat label="In progress" value={logsData ? counts.inProgress : '—'} dot={counts.inProgress ? 'info' : null} hint="Crews on site now" />
                <Stat label="Completed this month" value={logsData ? counts.doneMonth : '—'}
                    hint={showMoney && stats ? `${fmtMoney(Number(stats.cost_mtd_cents) / 100)} total cost` : null} />
            </Stats>

            {logsLoading && !logsData ? <Card><Loading /></Card> : (
                <>
                    {view === 'board' && <BoardView logs={scoped} who={who} whoChips={whoChips} actions={actions} hasAny={logs.length > 0} onNew={canEdit ? openNew : null} />}
                    {view === 'calendar' && <CalendarView logs={logs} who={who} mine={mine} whoChips={whoChips} actions={actions} tick={calTick} onNew={canEdit ? openNew : null} />}
                    {view === 'list' && <ListView logs={scoped} whoChips={whoChips} canEdit={canEdit} showMoney={showMoney} onEdit={edit} onCancel={setCancelling} />}
                </>
            )}

            {form && (
                <MaintenanceForm log={form.log} prefill={form.prefill} users={users} issueTemplates={issueTemplates} showMoney={showMoney}
                    onSaved={() => { setForm(null); refresh() }} onClose={() => setForm(null)} onCancelJob={setCancelling} />
            )}
            {completing && (
                <CompleteModal log={completing} templates={checklistTemplates} showMoney={showMoney}
                    onDone={() => { setCompleting(null); refresh() }} onClose={() => setCompleting(null)} />
            )}
            {cancelling && (
                <Modal title="Cancel this job?" onClose={() => setCancelling(null)}
                    footer={<>
                        <button className="btn ghost" onClick={() => setCancelling(null)}>Keep job</button>
                        <button className="btn danger solid" disabled={busy === cancelling.id} onClick={confirmCancel}>Cancel job</button>
                    </>}>
                    <p><b>{cancelling.title}</b>{cancelling.trailer_name ? ` on ${cancelling.trailer_name}` : ''} will be marked cancelled and drop off the board. It stays in the List view under Cancelled.</p>
                </Modal>
            )}
        </Page>
    )
}

// ============================================================
// Board: exceptions first
// ============================================================
function BoardView({ logs, who, whoChips, actions, hasAny, onNew }) {
    const [showDone, setShowDone] = useState(false)
    const groups = useMemo(() => {
        const now = Date.now()
        const g = { overdue: [], soon: [], undated: [], progress: [], done: [], later: 0 }
        for (const l of logs) {
            if (l.status === 'in_progress') g.progress.push(l)
            else if (l.status === 'scheduled') {
                if (l.scheduled_date == null) g.undated.push(l)
                else if (l.scheduled_date < now) g.overdue.push(l)
                else if (l.scheduled_date <= now + 14 * DAY) g.soon.push(l)
                else g.later++
            } else if (l.status === 'completed' && l.completed_date >= now - 14 * DAY) g.done.push(l)
        }
        const asc = (a, b) => (a.scheduled_date || 0) - (b.scheduled_date || 0)
        g.overdue.sort(asc); g.soon.sort(asc); g.progress.sort(asc)
        g.done.sort((a, b) => b.completed_date - a.completed_date)
        return g
    }, [logs])

    const open = groups.overdue.length + groups.soon.length + groups.undated.length + groups.progress.length

    return (
        <div className="stack">
            <div className="toolbar" style={{ marginBottom: 0 }}>{whoChips}</div>

            {open === 0 && (
                <Card>
                    {!hasAny ? (
                        <Empty title="No field service yet">Schedule inspections, repairs and installs for crews on site.
                            {onNew && <div style={{ marginTop: 12 }}><button className="btn" onClick={() => onNew()}><Icon name="plus" />Schedule service</button></div>}
                        </Empty>
                    ) : (
                        <AllClear>{who === 'mine' ? 'Nothing assigned to you is due in the next 14 days.' : 'Nothing overdue, in progress, or due in the next 14 days.'}</AllClear>
                    )}
                </Card>
            )}

            {groups.overdue.length > 0 && (
                <Card title={<><Dot tone="crit" />Overdue</>} meta={groups.overdue.length} flush>
                    <JobList items={groups.overdue} {...actions} />
                </Card>
            )}
            {groups.progress.length > 0 && (
                <Card title={<><Dot tone="info" />In progress</>} meta={groups.progress.length} flush>
                    <JobList items={groups.progress} {...actions} />
                </Card>
            )}
            {(groups.soon.length > 0 || (open > 0 && groups.later > 0)) && (
                <Card title="Due in the next 14 days" meta={groups.soon.length} flush
                    foot={groups.later > 0 ? `${plural(groups.later, 'more job')} scheduled after that. See Calendar or List.` : null}>
                    {groups.soon.length ? <JobList items={groups.soon} {...actions} /> : <div className="faint" style={{ padding: 18 }}>Nothing in the next two weeks.</div>}
                </Card>
            )}
            {groups.undated.length > 0 && (
                <Card title="Not yet dated" meta={groups.undated.length} flush>
                    <JobList items={groups.undated} {...actions} />
                </Card>
            )}

            <Card title="Recently completed" meta={groups.done.length ? `${groups.done.length} in the last 14 days` : 'none in the last 14 days'} flush
                actions={groups.done.length > 0 && <button className="btn sm ghost" onClick={() => setShowDone(s => !s)}>{showDone ? 'Hide' : 'Show'}</button>}>
                {showDone ? <JobList items={groups.done} {...actions} /> : null}
            </Card>
        </div>
    )
}

function JobList({ items, ...actions }) {
    return <div className="list">{items.map(l => <JobRow key={l.id} log={l} {...actions} />)}</div>
}

function JobRow({ log: l, canEdit, busy, onStart, onComplete, onEdit, showMoney }) {
    const overdue = isOverdue(l)
    const who = assigneeOf(l)
    return (
        <div className="list-row">
            <Dot tone={toneOf(l) === 'plain' ? 'off' : toneOf(l)} />
            <div className="main">
                <div className="title">{l.title} <Badge tone="plain">{VISIT_LABEL[l.visit_type] || l.visit_type}</Badge></div>
                <div className="desc">
                    {l.site_id != null ? <Link to={`/trailer/${l.site_id}`} className="link">{l.trailer_name || `Trailer ${l.site_id}`}</Link> : <span className="faint">Whole site</span>}
                    {' · '}
                    {l.job_site_id ? <Link to={`/site/${l.job_site_id}`} className="link">{l.job_site_name || 'Site'}</Link> : <span className="faint">No site</span>}
                    {' · '}
                    {who ? <span>{who}</span> : <span className="faint">Unassigned</span>}
                    {l.status === 'completed' && showMoney && costOf(l) > 0 && <span> · {fmtMoney(costOf(l) / 100)}</span>}
                </div>
            </div>
            <div className="side" style={overdue ? { color: 'var(--crit)' } : undefined}>{whenLabel(l)}</div>
            {canEdit && (
                <div className="btn-row" style={{ flexWrap: 'nowrap' }}>
                    {l.status === 'scheduled' && <button className="btn sm" disabled={busy === l.id} onClick={() => onStart(l)}>Start</button>}
                    {(l.status === 'scheduled' || l.status === 'in_progress') && <button className="btn sm" disabled={busy === l.id} onClick={() => onComplete(l)}><Icon name="check" />Complete</button>}
                    <button className="btn sm ghost" onClick={() => onEdit(l)} aria-label={`Edit ${l.title}`}><Icon name="edit" />Edit</button>
                </div>
            )}
        </div>
    )
}

// ============================================================
// Completion: date, hours, costs, notes, checklist
// ============================================================
function CompleteModal({ log, templates, showMoney, onDone, onClose }) {
    const toast = useToast()
    const template = useMemo(() => templates.find(t => t.visit_type === log.visit_type && t.active !== false), [templates, log.visit_type])
    const [items, setItems] = useState(() => checklistFromTemplate(template))
    useEffect(() => { setItems(checklistFromTemplate(template)) }, [template])

    const today = isoDate(Date.now())
    const [f, setF] = useState({
        date: today,
        hours: log.labor_hours ?? '',
        labor: log.labor_cost_cents ? (log.labor_cost_cents / 100).toFixed(2) : '',
        parts: log.parts_cost_cents ? (log.parts_cost_cents / 100).toFixed(2) : '',
        notes: '',
    })
    const set = (k, v) => setF(p => ({ ...p, [k]: v }))
    const [saving, setSaving] = useState(false)
    const missing = missingRequired(items)
    const cents = (v) => { const n = parseFloat(v); return isNaN(n) || n < 0 ? 0 : Math.round(n * 100) }

    const submit = async (e) => {
        e.preventDefault()
        if (missing) return
        setSaving(true)
        try {
            const notes = f.notes.trim()
            const payload = {
                status: 'completed',
                completed_date: completedMs(f.date || today),
                labor_hours: f.hours === '' ? null : Number(f.hours),
            }
            if (showMoney) {
                payload.labor_cost_cents = cents(f.labor)
                payload.parts_cost_cents = cents(f.parts)
            }
            if (notes) payload.description = [log.description, `Completion notes (${fmtDate(payload.completed_date)}): ${notes}`].filter(Boolean).join('\n\n')
            await updateMaintenanceLog(log.id, payload)
            if (template && items.length) {
                try {
                    await submitChecklist(log.id, { template_id: template.id, template_name: template.name, items })
                } catch (err) {
                    toast.error(`Job completed, but the checklist didn’t save: ${err.message}`)
                    onDone()
                    return
                }
            }
            toast.success(`Completed: ${log.title}`)
            onDone()
        } catch (err) {
            toast.error(err.message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <Modal title="Complete job" onClose={onClose}
            footer={<>
                <button type="button" className="btn ghost" onClick={onClose}>Close</button>
                <button type="submit" form="complete-form" className="btn primary" disabled={saving || missing > 0}>{saving ? 'Saving…' : 'Mark complete'}</button>
            </>}>
            <form id="complete-form" className="form" onSubmit={submit}>
                <div>
                    <div style={{ fontWeight: 600 }}>{log.title}</div>
                    <div className="muted" style={{ fontSize: 13 }}>{[log.trailer_name, log.job_site_name, VISIT_LABEL[log.visit_type]].filter(Boolean).join(' · ')}</div>
                </div>
                <div className="form-row">
                    <Field label="Completed on">
                        <input className="input" type="date" value={f.date} max={today} onChange={e => set('date', e.target.value)} required />
                    </Field>
                    <Field label="Labor hours">
                        <input className="input" type="number" min="0" step="0.25" value={f.hours} onChange={e => set('hours', e.target.value)} placeholder="0" />
                    </Field>
                </div>
                {showMoney && (
                    <div className="form-row">
                        <Field label="Labor cost ($)">
                            <input className="input" type="number" min="0" step="0.01" value={f.labor} onChange={e => set('labor', e.target.value)} placeholder="0.00" />
                        </Field>
                        <Field label="Parts cost ($)">
                            <input className="input" type="number" min="0" step="0.01" value={f.parts} onChange={e => set('parts', e.target.value)} placeholder="0.00" />
                        </Field>
                    </div>
                )}
                {template && items.length > 0 && <ChecklistPanel title={template.name} items={items} onChange={setItems} />}
                <Field label="Notes">
                    <textarea className="textarea" rows={3} value={f.notes} onChange={e => set('notes', e.target.value)} placeholder="What was done, anything to follow up" />
                </Field>
                {missing > 0 && <div className="faint" style={{ fontSize: 12.5 }}>Tick the {plural(missing, 'required item')} to finish.</div>}
            </form>
        </Modal>
    )
}

// ============================================================
// Calendar: month grid
// ============================================================
function CalendarView({ logs, who, mine, whoChips, actions, tick, onNew }) {
    const toast = useToast()
    const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
    const [selected, setSelected] = useState(() => dayKey(Date.now()))
    const [items, setItems] = useState(null)

    useEffect(() => {
        let alive = true
        const startMs = month.getTime()
        const endMs = new Date(month.getFullYear(), month.getMonth() + 1, 0, 23, 59, 59, 999).getTime()
        fetchMaintenanceCalendar(startMs, endMs)
            .then(d => { if (alive) setItems(d.logs || []) })
            .catch(err => { if (alive) { setItems([]); toast.error(`Calendar didn’t load: ${err.message}`) } })
        return () => { alive = false }
    }, [month, tick, toast])

    // The calendar endpoint has no trailer names; enrich from the full log list
    const byDay = useMemo(() => {
        const full = new Map(logs.map(l => [l.id, l]))
        const map = {}
        for (const raw of items || []) {
            const l = { ...raw, ...(full.get(raw.id) || {}) }
            if (who === 'mine' && !mine(l)) continue
            const when = l.status === 'completed' && l.completed_date ? l.completed_date : l.scheduled_date
            if (when == null) continue
            const k = dayKey(when)
            ;(map[k] = map[k] || []).push(l)
        }
        for (const k in map) map[k].sort((a, b) => (a.scheduled_date || 0) - (b.scheduled_date || 0))
        return map
    }, [items, logs, who, mine])

    const cells = useMemo(() => {
        const first = month.getDay()
        const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
        const out = []
        for (let i = 0; i < first; i++) out.push(null)
        for (let d = 1; d <= days; d++) out.push(new Date(month.getFullYear(), month.getMonth(), d))
        while (out.length % 7) out.push(null)
        return out
    }, [month])

    const todayKey = dayKey(Date.now())
    const shift = (n) => { setMonth(m => new Date(m.getFullYear(), m.getMonth() + n, 1)); setSelected(null) }
    const goToday = () => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)); setSelected(todayKey) }
    const dayItems = selected ? (byDay[selected] || []) : []
    const selDate = selected ? new Date(`${selected}T00:00:00`) : null

    return (
        <div className="stack">
            <div className="toolbar" style={{ marginBottom: 0 }}>
                <div className="btn-row">
                    <button className="btn sm" onClick={() => shift(-1)} aria-label="Previous month"><Icon name="back" /></button>
                    <button className="btn sm" onClick={goToday}>Today</button>
                    <button className="btn sm" onClick={() => shift(1)} aria-label="Next month"><Icon name="chevron" /></button>
                </div>
                <h3 style={{ fontSize: 15, fontWeight: 600 }}>{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h3>
                <span className="spacer" />
                <span className="faint" style={{ fontSize: 12.5, display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span><Dot tone="crit" /> Overdue</span><span><Dot tone="info" /> In progress</span><span><Dot tone="ok" /> Done</span>
                </span>
                {whoChips}
            </div>
            <Card flush>
                {items == null ? <Loading /> : (
                    <div className="cal">
                        {WEEKDAYS.map(d => <div key={d} className="cal-h" style={{ minWidth: 0 }}>{d}</div>)}
                        {cells.map((d, i) => {
                            if (!d) return <div key={`b${i}`} className="cal-d blank" style={{ minWidth: 0 }} />
                            const k = dayKey(d.getTime())
                            const evs = byDay[k] || []
                            return (
                                <div key={k} style={{ minWidth: 0 }} className={`cal-d ${k === todayKey ? 'today' : ''} ${k === selected ? 'sel' : ''}`} onClick={() => setSelected(k)}>
                                    <span className="cal-n">{d.getDate()}</span>
                                    {evs.slice(0, 3).map(l => (
                                        <span key={l.id} className={`cal-ev ${toneOf(l) === 'plain' ? '' : toneOf(l)}`} title={`${l.title}${l.trailer_name ? ' · ' + l.trailer_name : ''}`}>
                                            {l.trailer_name ? `${l.trailer_name} ` : ''}{l.title}
                                        </span>
                                    ))}
                                    {evs.length > 3 && <span className="faint" style={{ fontSize: 11.5 }}>+{evs.length - 3} more</span>}
                                </div>
                            )
                        })}
                    </div>
                )}
            </Card>
            {selected && (
                <Card title={selDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })} meta={dayItems.length ? plural(dayItems.length, 'job') : null} flush
                    actions={onNew && <button className="btn sm ghost" onClick={() => onNew({ date: selected })}><Icon name="plus" />Schedule on this day</button>}>
                    {dayItems.length ? <JobList items={dayItems} {...actions} /> : <Empty compact>Nothing scheduled this day.</Empty>}
                </Card>
            )}
        </div>
    )
}

// ============================================================
// List: every log, filter, search, export, costs by site
// ============================================================
function ListView({ logs, whoChips, canEdit, showMoney, onEdit, onCancel }) {
    const [status, setStatus] = useState('open')
    const [q, setQ] = useState('')

    const counts = useMemo(() => {
        const c = { all: logs.length, open: 0, overdue: 0 }
        for (const l of logs) {
            c[l.status] = (c[l.status] || 0) + 1
            if (l.status === 'scheduled' || l.status === 'in_progress') c.open++
            if (isOverdue(l)) c.overdue++
        }
        return c
    }, [logs])

    const rows = useMemo(() => {
        const term = q.trim().toLowerCase()
        return logs.filter(l => {
            if (status === 'open' && !(l.status === 'scheduled' || l.status === 'in_progress')) return false
            if (status === 'overdue' && !isOverdue(l)) return false
            if (!['all', 'open', 'overdue'].includes(status) && l.status !== status) return false
            if (!term) return true
            return [l.title, l.trailer_name, l.job_site_name, assigneeOf(l), l.description, VISIT_LABEL[l.visit_type]]
                .some(v => v && String(v).toLowerCase().includes(term))
        })
    }, [logs, status, q])

    const dateOf = (l) => (l.status === 'completed' && l.completed_date) || l.scheduled_date || l.created_at

    const columns = [
        { key: 'date', label: 'Date', sort: dateOf, render: l => <span className="num">{fmtDate(dateOf(l))}</span> },
        {
            key: 'title', label: 'Job', sort: l => l.title,
            render: l => <div><span className="primary">{l.title}</span><div className="sub">{VISIT_LABEL[l.visit_type] || l.visit_type}</div></div>
        },
        {
            key: 'where', label: 'Trailer · site', sort: l => `${l.job_site_name || ''} ${l.trailer_name || ''}`,
            render: l => <div>
                {l.site_id != null ? <Link to={`/trailer/${l.site_id}`} className="link" onClick={e => e.stopPropagation()}>{l.trailer_name || `Trailer ${l.site_id}`}</Link> : <span className="faint">Whole site</span>}
                <div className="sub">{l.job_site_id ? <Link to={`/site/${l.job_site_id}`} onClick={e => e.stopPropagation()}>{l.job_site_name}</Link> : 'No site'}</div>
            </div>
        },
        { key: 'who', label: 'Assigned', sort: l => assigneeOf(l), render: l => assigneeOf(l) || <span className="faint">Unassigned</span> },
        { key: 'status', label: 'Status', sort: l => (isOverdue(l) ? 0 : ['in_progress', 'scheduled', 'completed', 'cancelled'].indexOf(l.status) + 1), render: l => <StatusBadge log={l} /> },
        showMoney && { key: 'cost', label: 'Cost', align: 'r', sort: costOf, render: l => costOf(l) ? <span className="num">{fmtMoney(costOf(l) / 100)}</span> : <span className="faint">—</span> },
        canEdit && {
            key: 'x', label: '', width: 44,
            render: l => (l.status === 'scheduled' || l.status === 'in_progress')
                ? <button className="icon-btn" title="Cancel job" aria-label={`Cancel ${l.title}`} onClick={e => { e.stopPropagation(); onCancel(l) }}><Icon name="x" /></button>
                : null
        },
    ].filter(Boolean)

    const exportCsv = () => {
        const headers = ['Scheduled', 'Completed', 'Created', 'Job site', 'Trailer', 'Title', 'Type', 'Status', 'Assigned to', 'Labor hours',
            ...(showMoney ? ['Labor cost', 'Parts cost', 'Total cost'] : []), 'Description']
        const money = (c) => ((Number(c) || 0) / 100).toFixed(2)
        downloadCSV(generateCSV(headers, rows.map(l => [
            l.scheduled_date ? fmtDate(l.scheduled_date) : '', l.completed_date ? fmtDate(l.completed_date) : '', fmtDate(l.created_at),
            l.job_site_name || '', l.trailer_name || '', l.title, VISIT_LABEL[l.visit_type] || l.visit_type,
            isOverdue(l) ? 'overdue' : l.status, assigneeOf(l) || '', l.labor_hours ?? '',
            ...(showMoney ? [money(l.labor_cost_cents), money(l.parts_cost_cents), money(costOf(l))] : []), l.description || '',
        ])), `field-service-${isoDate(Date.now())}.csv`)
    }

    const chips = [
        { key: 'open', label: 'Open' }, { key: 'overdue', label: 'Overdue', dot: 'crit' }, { key: 'scheduled', label: 'Scheduled' },
        { key: 'in_progress', label: 'In progress', dot: 'info' }, { key: 'completed', label: 'Completed', dot: 'ok' },
        { key: 'cancelled', label: 'Cancelled' }, { key: 'all', label: 'All' },
    ].map(c => ({ ...c, count: counts[c.key] ?? 0 }))

    return (
        <div className="stack">
            <div>
                <div className="toolbar">
                    <Search value={q} onChange={setQ} placeholder="Search job, trailer, site, person…" />
                    <Chips options={chips} value={status} onChange={setStatus} />
                    <span className="spacer" />
                    {whoChips}
                    <button className="btn" onClick={exportCsv} disabled={!rows.length}><Icon name="download" />Export</button>
                </div>
                <Card flush>
                    <DataTable columns={columns} rows={rows} onRowClick={canEdit ? onEdit : undefined} initialSort={{ key: 'date', dir: 'desc' }}
                        empty={<Empty compact title={logs.length ? 'No jobs match' : 'No field service yet'}>{logs.length ? 'Try a different search or filter.' : 'Scheduled jobs will show up here.'}</Empty>} />
                </Card>
            </div>
            {showMoney && <CostsBySite />}
        </div>
    )
}

function CostsBySite() {
    const [days, setDays] = useState(90)
    const fn = useCallback(() => fetchMaintenanceCostsBySite(days), [days])
    const { data } = useApiPolling(fn, 300000)
    const costs = data?.costs || []
    const total = costs.reduce((s, c) => s + Number(c.total_cost_cents || 0), 0)
    return (
        <Card title="Service cost by site" meta={data ? fmtMoney(total / 100) : null} flush
            actions={<Seg value={String(days)} onChange={v => setDays(Number(v))} options={[{ key: '30', label: '30d' }, { key: '90', label: '90d' }, { key: '365', label: '1y' }]} />}>
            {!data ? <Loading /> : costs.length === 0 ? <Empty compact>No service costs recorded in this period.</Empty> : (
                <DataTable rowKey="job_site_id" rows={costs} columns={[
                    { key: 'site', label: 'Site', render: c => <Link to={`/site/${c.job_site_id}`} className="link">{c.job_site_name}</Link> },
                    { key: 'n', label: 'Jobs', align: 'r', render: c => <span className="num">{c.log_count}</span> },
                    { key: 'labor', label: 'Labor', align: 'r', render: c => <span className="num">{fmtMoney(c.labor_cost_cents / 100)}</span> },
                    { key: 'parts', label: 'Parts', align: 'r', render: c => <span className="num">{fmtMoney(c.parts_cost_cents / 100)}</span> },
                    { key: 'total', label: 'Total', align: 'r', render: c => <b className="num">{fmtMoney(c.total_cost_cents / 100)}</b> },
                ]} />
            )}
        </Card>
    )
}
