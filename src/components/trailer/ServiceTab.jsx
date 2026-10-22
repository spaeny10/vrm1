import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApiPolling } from '../../hooks/useApiPolling'
import { apiGet, fetchComponents, createComponent, updateComponent } from '../../api/vrm'
import { useToast } from '../ToastProvider'
import { Card, Badge, DataTable, Empty, Loading, Icon } from '../../ui'
import { fmtDate, daysSince } from '../../ui/format'
import ComponentForm, { COMPONENT_TYPE_LABELS } from '../ComponentForm'
import { epochToISODate } from './telemetry'

const STATUS = {
    scheduled: { tone: 'info', label: 'Scheduled' },
    in_progress: { tone: 'warn', label: 'In progress' },
    completed: { tone: 'ok', label: 'Completed' },
    cancelled: { tone: 'plain', label: 'Cancelled' },
}
const VISIT = { inspection: 'Inspection', repair: 'Repair', scheduled: 'Scheduled service', emergency: 'Emergency', installation: 'Installation', decommission: 'Decommission' }
const COMP_STATUS = { active: { tone: 'ok', label: 'Active' }, replaced: { tone: 'plain', label: 'Replaced' }, failed: { tone: 'crit', label: 'Failed' } }

function isOverdue(m) {
    return (m.status === 'scheduled' || m.status === 'in_progress') && m.scheduled_date && Number(m.scheduled_date) < Date.now() - 86400000
}

// Service: maintenance visits for this unit and its component inventory.
export default function ServiceTab({ siteId, jobSiteId, canEdit }) {
    const navigate = useNavigate()
    const toast = useToast()
    const maintFn = useCallback(() => apiGet(`/maintenance?site_id=${siteId}`), [siteId])
    const compFn = useCallback(() => fetchComponents(siteId), [siteId])
    const { data: maint, loading: maintLoading, error: maintError } = useApiPolling(maintFn, 120000)
    const { data: comps, loading: compLoading, refetch: refetchComps } = useApiPolling(compFn, 300000)
    const [editing, setEditing] = useState(null) // component object, or 'new'

    const logs = maint?.logs || []
    const open = logs.filter(m => m.status === 'scheduled' || m.status === 'in_progress')
        .sort((a, b) => Number(a.scheduled_date || 0) - Number(b.scheduled_date || 0))
    const past = logs.filter(m => !(m.status === 'scheduled' || m.status === 'in_progress'))
        .sort((a, b) => Number(b.completed_date || b.scheduled_date || b.created_at) - Number(a.completed_date || a.scheduled_date || a.created_at))
    const components = comps?.components || []

    const schedule = () => {
        const qs = new URLSearchParams({ new: '1', site_id: String(siteId) })
        if (jobSiteId) qs.set('job_site_id', String(jobSiteId))
        navigate(`/maintenance?${qs}`)
    }

    const save = async (payload) => {
        if (editing === 'new') await createComponent(payload)
        else await updateComponent(editing.id, payload)
        toast.success(editing === 'new' ? `${COMPONENT_TYPE_LABELS[payload.component_type] || 'Component'} added` : 'Component updated')
        setEditing(null)
        refetchComps()
    }

    const compColumns = [
        { key: 'type', label: 'Type', sort: c => COMPONENT_TYPE_LABELS[c.component_type] || c.component_type, render: c => <span className="primary">{COMPONENT_TYPE_LABELS[c.component_type] || c.component_type}</span> },
        { key: 'make', label: 'Make / model', sort: c => `${c.make || ''} ${c.model || ''}`, render: c => [c.make, c.model].filter(Boolean).join(' ') || <span className="faint">—</span> },
        { key: 'serial', label: 'Serial', render: c => c.serial_number ? <span className="mono">{c.serial_number}</span> : <span className="faint">—</span> },
        { key: 'installed', label: 'Installed', sort: c => Number(c.installed_date) || null, render: c => fmtDate(epochToISODate(c.installed_date)) },
        { key: 'warranty', label: 'Warranty', sort: c => Number(c.warranty_expiry) || null, render: c => <Warranty value={c.warranty_expiry} /> },
        { key: 'status', label: 'Status', sort: c => c.status, render: c => { const s = COMP_STATUS[c.status] || { tone: 'plain', label: c.status }; return <Badge tone={s.tone}>{s.label}</Badge> } },
        ...(canEdit ? [{ key: 'edit', label: '', width: 60, render: c => <button className="btn ghost sm" onClick={() => setEditing(c)}>Edit</button> }] : []),
    ]

    return (
        <div className="stack">
            <Card title="Service visits" meta={open.length ? `${open.length} open` : null}
                actions={canEdit && <button className="btn primary sm" onClick={schedule}><Icon name="plus" />Schedule service</button>} flush>
                {maintLoading && !maint ? <Loading /> : maintError && !maint ? <Empty compact title="Couldn't load service history">{maintError}</Empty>
                    : logs.length === 0 ? <Empty compact title="No service history">Visits scheduled for this unit will appear here.</Empty> : (
                        <div className="list">
                            {[...open, ...past].map(m => {
                                const s = STATUS[m.status] || { tone: 'plain', label: m.status }
                                const overdue = isOverdue(m)
                                const when = m.status === 'completed' ? m.completed_date || m.scheduled_date : m.scheduled_date
                                return (
                                    <div key={m.id} className="list-row">
                                        <div className="main">
                                            <div className="title">{m.title}{overdue ? <Badge tone="crit">Overdue {daysSince(Number(m.scheduled_date))}d</Badge> : <Badge tone={s.tone}>{s.label}</Badge>}</div>
                                            <div className="desc">{[VISIT[m.visit_type] || m.visit_type, m.assigned_technician_name || m.technician, m.description].filter(Boolean).join(' · ')}</div>
                                        </div>
                                        <div className="side">{when ? `${m.status === 'completed' ? 'Done' : 'Due'} ${fmtDate(Number(when))}` : '—'}</div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
            </Card>

            <Card title="Components" meta={components.length || null}
                actions={canEdit && <button className="btn sm" onClick={() => setEditing('new')}><Icon name="plus" />Add component</button>} flush>
                {compLoading && !comps ? <Loading /> : (
                    <DataTable columns={compColumns} rows={components}
                        empty={<Empty compact title="No components logged">Track batteries, panels, routers and cameras here to keep serials and warranties in one place.</Empty>} />
                )}
            </Card>

            {editing && <ComponentForm component={editing === 'new' ? null : editing} siteId={siteId} onSave={save} onClose={() => setEditing(null)} />}
        </div>
    )
}

function Warranty({ value }) {
    const iso = epochToISODate(value)
    if (!iso) return <span className="faint">—</span>
    const days = -daysSince(iso) // days until expiry
    return (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {fmtDate(iso)}
            {days < 0 ? <Badge tone="warn">Expired</Badge> : days <= 60 ? <Badge tone="info">{days}d left</Badge> : null}
        </span>
    )
}
