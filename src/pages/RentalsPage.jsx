import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useWorkspace } from '../components/WorkspaceProvider'
import { useToast } from '../components/ToastProvider'
import {
    fetchRentals, fetchRental, createRental, updateRental,
    fetchTrailers, fetchJobSites, fetchCompanies, fetchRateCards,
} from '../api/vrm'
import { Page, Card, DataTable, Chips, Search, Seg, Modal, Drawer, Field, KV, Empty, Loading, Icon, Badge } from '../ui'
import { fmtDate, fmtMoney, todayISO, isoDate, plural, toDate } from '../ui/format'
import {
    STATUS_LABELS, EVENT_LABELS, TERM_LABELS, CYCLE_LABELS, RentalStatusBadge, RentalActionButtons,
    pricingLabel, useRentalEventFlow,
} from '../components/RentalLifecycle'
import { generateCSV, downloadCSV } from '../utils/csv'

const STATUS_CHIPS = [
    { key: 'open', label: 'All open' },
    { key: 'billing', label: 'Billing' },
    { key: 'called_off', label: 'Called off' },
    { key: 'delivered', label: 'Delivered' },
    { key: 'reserved', label: 'Reserved' },
    { key: 'awaiting_pickup', label: 'Awaiting pickup' },
    { key: 'closed', label: 'Closed' },
]

const isOpen = r => r.status !== 'closed' && r.status !== 'cancelled'

export default function RentalsPage() {
    const { user } = useAuth()
    const { workspace } = useWorkspace()
    const toast = useToast()
    const [params, setParams] = useSearchParams()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const hideMoney = workspace === 'tech'

    const [view, setView] = useState('list')
    const [status, setStatus] = useState('open')
    const [q, setQ] = useState('')
    const [detailId, setDetailId] = useState(null)
    const [editing, setEditing] = useState(null)   // rental or 'new'
    const [prefill, setPrefill] = useState(null)

    const fetchFn = useCallback(() => fetchRentals(), [])
    const { data, loading, refetch } = useApiPolling(fetchFn, 60000)
    const rentals = data?.rentals || []
    const flow = useRentalEventFlow(() => refetch())

    // Deep links from other pages: ?new=1&trailer_id= | ?edit=ID | ?open=ID
    useEffect(() => {
        if (params.get('new')) {
            setPrefill({ trailer_id: params.get('trailer_id') || '' }); setEditing('new')
        } else if (params.get('edit')) {
            if (!rentals.length) return
            const r = rentals.find(x => x.id === Number(params.get('edit')))
            if (r) setEditing(r)
        } else if (params.get('open')) {
            setDetailId(Number(params.get('open')))
        } else return
        setParams({}, { replace: true })
    }, [params, rentals.length])

    const counts = useMemo(() => {
        const c = { open: 0 }
        for (const r of rentals) {
            c[r.status] = (c[r.status] || 0) + 1
            if (isOpen(r)) c.open++
        }
        c.closed = (c.closed || 0) + (c.cancelled || 0)
        return c
    }, [rentals])

    const filtered = useMemo(() => {
        const term = q.trim().toLowerCase()
        return rentals.filter(r => {
            if (status === 'open' && !isOpen(r)) return false
            if (status === 'closed' && isOpen(r)) return false
            if (!['open', 'closed'].includes(status) && r.status !== status) return false
            return !term || [r.unit_number, r.company_name, r.job_site_name, r.po_number].some(v => v && v.toLowerCase().includes(term))
        })
    }, [rentals, status, q])

    const columns = [
        { key: 'unit', label: 'Unit', sort: r => r.unit_number, render: r => <span className="primary">{r.unit_number}</span> },
        { key: 'customer', label: 'Customer', sort: r => r.company_name, render: r => r.company_name || <span className="faint">—</span> },
        { key: 'site', label: 'Site', sort: r => r.job_site_name, render: r => r.job_site_id ? <Link className="link" to={`/site/${r.job_site_id}`} onClick={e => e.stopPropagation()}>{r.job_site_name}</Link> : <span className="faint">—</span> },
        { key: 'po', label: 'PO', render: r => r.po_number || <span className="faint">—</span> },
        !hideMoney && { key: 'rate', label: 'Rate', render: r => <span className="muted">{pricingLabel(r) || TERM_LABELS[r.commitment_term] || '—'}</span> },
        { key: 'start', label: 'Billing since', sort: r => r.billing_start, render: r => fmtDate(r.billing_start) },
        { key: 'days', label: 'Days', align: 'r', sort: r => r.days_on_rent, render: r => <span className="num">{r.days_on_rent ?? '—'}</span> },
        !hideMoney && { key: 'due', label: 'Accrued', align: 'r', sort: r => r.total_due, render: r => <span className="num">{fmtMoney(r.total_due ?? r.accrued_amount)}</span> },
        { key: 'status', label: 'Status', sort: r => r.status, render: r => <RentalStatusBadge status={r.status} /> },
        canEdit && { key: 'act', label: '', align: 'r', render: r => <RentalActionButtons rental={r} onAction={flow.start} /> },
    ].filter(Boolean)

    const exportCsv = () => {
        const headers = ['Unit', 'Status', 'Customer', 'Site', 'PO', 'Term', 'Effective rate', 'Billing cycle', 'Volume tier', 'Billing start', 'Billing stop', 'Days', 'Accrued', 'Roll-back', 'Total due']
        downloadCSV(generateCSV(headers, filtered.map(r => [
            r.unit_number, STATUS_LABELS[r.status] || r.status, r.company_name || '', r.job_site_name || '', r.po_number || '',
            r.pricing_source === 'manual' ? 'Manual' : (TERM_LABELS[r.commitment_term] || ''), r.effective_rate ?? '', r.billing_cycle || '',
            r.volume_tier ? `${r.volume_tier.name} -${r.volume_tier.discount_pct}%` : '', r.billing_start || '', r.billing_stop || '',
            r.days_on_rent ?? '', r.accrued_amount ?? '', r.rollback_amount ?? '', r.total_due ?? '',
        ])), `rentals-${todayISO()}.csv`)
    }

    return (
        <Page title="Rentals" sub={data ? `${plural(counts.open, 'open rental')} · ${counts.billing || 0} billing` : 'Loading…'}
            actions={<>
                <button className="btn" onClick={exportCsv} disabled={!filtered.length}><Icon name="download" />Export</button>
                {canEdit && <button className="btn primary" onClick={() => { setPrefill(null); setEditing('new') }}><Icon name="plus" />New rental</button>}
            </>}>
            <div>
                <div className="toolbar">
                    <Seg value={view} onChange={setView} options={[{ key: 'list', label: 'List' }, { key: 'site', label: 'By site' }, { key: 'calendar', label: 'Calendar' }]} />
                    {view !== 'calendar' && <Search value={q} onChange={setQ} placeholder="Search unit, customer, site, PO…" />}
                </div>
                {view !== 'calendar' && (
                    <div className="toolbar"><Chips value={status} onChange={setStatus} options={STATUS_CHIPS.map(c => ({ ...c, count: counts[c.key] || 0 }))} /></div>
                )}

                {loading && !data ? <Card><Loading /></Card> : view === 'list' ? (
                    <Card flush>
                        <DataTable columns={columns} rows={filtered} onRowClick={r => setDetailId(r.id)}
                            empty={<Empty compact title={rentals.length ? 'No rentals match' : 'No rentals yet'}>{rentals.length ? 'Try another filter.' : 'Create a rental to put a trailer to work.'}</Empty>} />
                    </Card>
                ) : view === 'site' ? (
                    <BySite rows={filtered} columns={columns.filter(c => c.key !== 'site')} hideMoney={hideMoney} onOpen={r => setDetailId(r.id)} />
                ) : (
                    <RentalCalendar rentals={rentals} onOpen={r => setDetailId(r.id)} />
                )}
            </div>

            {detailId && (
                <RentalDrawer id={detailId} hideMoney={hideMoney} canEdit={canEdit} onClose={() => setDetailId(null)}
                    onAction={(r, ev) => flow.start(r, ev)} onEdit={r => { setDetailId(null); setEditing(r) }} />
            )}
            {editing && (
                <RentalForm rental={editing === 'new' ? null : editing} prefill={prefill}
                    onSaved={() => { refetch(); toast.success(editing === 'new' ? 'Rental created' : 'Rental updated') }}
                    onClose={() => setEditing(null)} />
            )}
            {flow.modal}
        </Page>
    )
}

function BySite({ rows, columns, hideMoney, onOpen }) {
    const groups = useMemo(() => {
        const m = new Map()
        for (const r of rows) {
            const k = r.job_site_id ?? 'none'
            if (!m.has(k)) m.set(k, { id: r.job_site_id, name: r.job_site_name || 'No site assigned', customer: r.company_name, rows: [], total: 0 })
            const g = m.get(k)
            g.rows.push(r)
            g.total += Number(r.total_due ?? r.accrued_amount ?? 0)
        }
        return [...m.values()].sort((a, b) => ((a.id == null) - (b.id == null)) || a.name.localeCompare(b.name))
    }, [rows])
    if (!groups.length) return <Card><Empty compact>No rentals match.</Empty></Card>
    return (
        <div className="stack">
            {groups.map(g => (
                <Card key={g.id ?? 'none'} flush
                    title={g.id ? <Link to={`/site/${g.id}`} className="link">{g.name}</Link> : g.name}
                    meta={`${g.customer ? g.customer + ' · ' : ''}${plural(g.rows.length, 'rental')}`}
                    actions={!hideMoney && <span className="num" style={{ fontWeight: 600 }}>{fmtMoney(g.total)}</span>}>
                    <DataTable columns={columns} rows={g.rows} onRowClick={onOpen} />
                </Card>
            ))}
        </div>
    )
}

const CAL_TYPES = [
    { field: 'reserved_at', label: 'Delivery due', tone: 'info', when: r => r.status === 'reserved' },
    { field: 'delivered_at', label: 'Delivered', tone: 'info' },
    { field: 'calloff_at', label: 'Call-off', tone: 'warn' },
    { field: 'picked_up_at', label: 'Picked up', tone: 'crit' },
    { field: 'returned_at', label: 'Returned', tone: 'ok' },
]

function RentalCalendar({ rentals, onOpen }) {
    const now = new Date()
    const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() })
    const [sel, setSel] = useState(null)

    const byDay = useMemo(() => {
        const map = {}
        for (const r of rentals) {
            if (r.status === 'cancelled') continue
            for (const t of CAL_TYPES) {
                if (!r[t.field] || (t.when && !t.when(r))) continue
                const k = String(r[t.field]).slice(0, 10)
                ;(map[k] = map[k] || []).push({ r, t })
            }
        }
        return map
    }, [rentals])

    const first = new Date(ym.y, ym.m, 1).getDay()
    const days = new Date(ym.y, ym.m + 1, 0).getDate()
    const key = d => `${ym.y}-${String(ym.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const shift = n => { setSel(null); setYm(p => { const d = new Date(p.y, p.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() } }) }
    const today = todayISO()

    return (
        <Card title={new Date(ym.y, ym.m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })}
            actions={<>
                <button className="btn sm ghost" onClick={() => shift(-1)} aria-label="Previous month"><Icon name="back" /></button>
                <button className="btn sm ghost" onClick={() => { setSel(null); setYm({ y: now.getFullYear(), m: now.getMonth() }) }}>Today</button>
                <button className="btn sm ghost" onClick={() => shift(1)} aria-label="Next month"><Icon name="chevron" /></button>
            </>}
            flush>
            <div className="cal">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="cal-h">{d}</div>)}
                {Array.from({ length: first }).map((_, i) => <div key={`b${i}`} className="cal-d blank" />)}
                {Array.from({ length: days }, (_, i) => i + 1).map(d => {
                    const k = key(d), items = byDay[k] || []
                    return (
                        <div key={d} className={`cal-d ${k === today ? 'today' : ''} ${sel === k ? 'sel' : ''}`} onClick={() => setSel(sel === k ? null : k)}>
                            <span className="cal-n">{d}</span>
                            {items.slice(0, 3).map((it, j) => <span key={j} className={`cal-ev ${it.t.tone}`}>{it.r.unit_number} · {it.t.label}</span>)}
                            {items.length > 3 && <span className="faint" style={{ fontSize: 11.5 }}>+{items.length - 3} more</span>}
                        </div>
                    )
                })}
            </div>
            {sel && (
                <div style={{ borderTop: '1px solid var(--border)' }}>
                    <div className="card-head"><h3>{toDate(sel).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</h3></div>
                    {(byDay[sel] || []).length === 0 ? <Empty compact>No rental activity.</Empty> : (
                        <div className="list">
                            {byDay[sel].map((it, i) => (
                                <div key={i} className="list-row clickable" onClick={() => onOpen(it.r)}>
                                    <Badge tone={it.t.tone}>{it.t.label}</Badge>
                                    <div className="main"><div className="title">{it.r.unit_number}</div><div className="desc">{[it.r.job_site_name, it.r.company_name].filter(Boolean).join(' · ')}</div></div>
                                    <RentalStatusBadge status={it.r.status} />
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </Card>
    )
}

const EVENT_TONE = { reserved: 'info', deliver: 'info', start_billing: 'ok', calloff: 'warn', stop_billing: 'warn', pickup: 'info', return: 'ok', cancel: 'crit', rollback_adjustment: 'crit' }

function RentalDrawer({ id, hideMoney, canEdit, onClose, onAction, onEdit }) {
    const fetchFn = useCallback(() => fetchRental(id), [id])
    const { data } = useApiPolling(fetchFn, 30000)
    const r = data?.rental
    const events = data?.events || []
    const transport = events.reduce((s, e) => s + (Number(e.transport_cost) || 0), 0)

    return (
        <Drawer title={r ? r.unit_number : 'Rental'} sub={r ? [r.company_name, r.job_site_name].filter(Boolean).join(' · ') : null} onClose={onClose}
            actions={r && canEdit && <button className="btn sm" onClick={() => onEdit(r)}><Icon name="edit" />Edit</button>}>
            {!r ? <Loading /> : <>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <RentalStatusBadge status={r.status} />
                    {!hideMoney && pricingLabel(r) && <span className="muted">{pricingLabel(r)}</span>}
                </div>
                {canEdit && <RentalActionButtons rental={r} onAction={onAction} align="start" />}
                <Card>
                    <KV items={[
                        ['PO number', r.po_number],
                        ['Commitment', TERM_LABELS[r.commitment_term] || r.commitment_term],
                        ['Reserved', fmtDate(r.reserved_at)],
                        ['Delivered', fmtDate(r.delivered_at)],
                        ['Billing start', fmtDate(r.billing_start)],
                        r.calloff_at && ['Called off', fmtDate(r.calloff_at)],
                        r.billing_stop && ['Billing stop', fmtDate(r.billing_stop)],
                        ['Days on rent', r.days_on_rent ?? '—'],
                        !hideMoney && ['Accrued', fmtMoney(r.accrued_amount)],
                        !hideMoney && r.rollback_amount > 0 && ['Roll-back adjustment', `+${fmtMoney(r.rollback_amount)}`],
                        !hideMoney && ['Total due', <b key="t">{fmtMoney(r.total_due)}</b>],
                        !hideMoney && transport > 0 && ['Transport costs (internal)', fmtMoney(transport)],
                    ]} />
                    {r.notes && <p className="muted" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>{r.notes}</p>}
                </Card>
                <div>
                    <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>History</h3>
                    {events.length === 0 ? <span className="faint">No events yet.</span> : (
                        <div className="timeline">
                            {events.map(e => (
                                <div key={e.id} className="tl-item">
                                    <span className={`tl-dot ${EVENT_TONE[e.event_type] || ''}`} />
                                    <div>
                                        <div className="tl-title">{EVENT_LABELS[e.event_type] || e.event_type} <span className="faint" style={{ fontWeight: 400 }}>· {fmtDate(e.event_date)}</span></div>
                                        <div className="tl-meta">
                                            {e.actor}
                                            {(e.transport_company || e.transport_cost) && ` · via ${e.transport_company || 'transport'}${e.transport_cost && !hideMoney ? ` (${fmtMoney(e.transport_cost)})` : ''}`}
                                            {e.notes && ` · ${e.notes}`}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </>}
        </Drawer>
    )
}

function RentalForm({ rental, prefill, onSaved, onClose }) {
    const toast = useToast()
    const isNew = !rental
    const [ref, setRef] = useState({ trailers: [], sites: [], companies: [], cards: [] })
    const [saving, setSaving] = useState(false)
    const [form, setForm] = useState(() => isNew ? {
        trailer_id: prefill?.trailer_id || '', company_id: '', job_site_id: '', po_number: '', commitment_term: 'monthly',
        reserved_at: todayISO(), rate_amount: '', rate_period: 'month', notes: '',
    } : {
        company_id: rental.company_id || '', job_site_id: rental.job_site_id || '', po_number: rental.po_number || '',
        commitment_term: rental.commitment_term || 'monthly', rate_amount: rental.rate_amount ?? '', rate_period: rental.rate_period || 'month',
        billing_start: isoDate(rental.billing_start), calloff_at: isoDate(rental.calloff_at), billing_stop: isoDate(rental.billing_stop), notes: rental.notes || '',
    })

    useEffect(() => {
        Promise.all([fetchTrailers(), fetchJobSites(), fetchCompanies(), fetchRateCards()])
            .then(([t, j, c, rc]) => setRef({ trailers: t.trailers || [], sites: j.job_sites || [], companies: c.companies || [], cards: rc.rate_cards || [] }))
            .catch(err => toast.error(err.message))
    }, [toast])

    const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))
    const trailer = ref.trailers.find(t => String(t.id) === String(form.trailer_id))
    const product = rental?.product_code || trailer?.product_code || 'BV1305'
    const cards = ref.cards.filter(c => c.product_code === product)
    const rentable = ref.trailers.filter(t => !t.open_rental_id && t.status !== 'retired')
    const sites = ref.sites.filter(s => !s.is_headquarters && (!form.company_id || s.company_id === Number(form.company_id)))

    // Picking a site fills in its customer
    const pickSite = e => {
        const s = ref.sites.find(x => String(x.id) === e.target.value)
        setForm(f => ({ ...f, job_site_id: e.target.value, company_id: s?.company_id ? String(s.company_id) : f.company_id }))
    }

    const save = async () => {
        if (!isNew && form.billing_start && form.billing_stop && form.billing_stop < form.billing_start) {
            toast.error('Billing stop cannot be before billing start'); return
        }
        setSaving(true)
        try {
            const common = {
                job_site_id: form.job_site_id ? Number(form.job_site_id) : null,
                company_id: form.company_id ? Number(form.company_id) : null,
                po_number: form.po_number || null,
                commitment_term: form.commitment_term,
                rate_amount: form.rate_amount !== '' ? Number(form.rate_amount) : null,
                rate_period: form.rate_period,
                notes: form.notes || null,
            }
            if (isNew) await createRental({ ...common, trailer_id: Number(form.trailer_id), reserved_at: form.reserved_at })
            else await updateRental(rental.id, { ...common, billing_start: form.billing_start || null, calloff_at: form.calloff_at || null, billing_stop: form.billing_stop || null })
            onSaved(); onClose()
        } catch (err) { toast.error(err.message) } finally { setSaving(false) }
    }

    return (
        <Modal title={isNew ? 'New rental' : `Edit rental — ${rental.unit_number}`} onClose={onClose} wide
            footer={<>
                <button className="btn ghost" onClick={onClose}>Cancel</button>
                <button className="btn primary" onClick={save} disabled={saving || (isNew && !form.trailer_id)}>{saving ? 'Saving…' : isNew ? 'Create rental' : 'Save changes'}</button>
            </>}>
            <div className="form">
                {isNew && (
                    <Field label="Trailer" hint={ref.trailers.length && !rentable.length ? 'Every trailer already has an open rental.' : null}>
                        <select className="select" value={form.trailer_id} onChange={set('trailer_id')}>
                            <option value="">Select a trailer…</option>
                            {rentable.map(t => <option key={t.id} value={t.id}>{t.unit_number}{t.current_job_site_name ? ` — at ${t.current_job_site_name}` : ''}</option>)}
                        </select>
                    </Field>
                )}
                <div className="form-row">
                    <Field label="Customer">
                        <select className="select" value={form.company_id} onChange={set('company_id')}>
                            <option value="">Select a customer…</option>
                            {ref.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                    </Field>
                    <Field label="Job site" hint="Required before the trailer can be delivered">
                        <select className="select" value={form.job_site_id} onChange={pickSite}>
                            <option value="">Select a site…</option>
                            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </Field>
                </div>
                <div className="form-row">
                    <Field label="Commitment term" hint="Volume discounts apply automatically each cycle">
                        <select className="select" value={form.commitment_term} onChange={set('commitment_term')}>
                            {(cards.length ? cards : [{ commitment_term: 'monthly' }, { commitment_term: '6_month' }, { commitment_term: '1_year' }]).map(c => (
                                <option key={c.commitment_term} value={c.commitment_term}>
                                    {TERM_LABELS[c.commitment_term]}{c.base_rate ? ` — ${fmtMoney(c.base_rate)} / ${CYCLE_LABELS[c.billing_cycle]}` : ''}
                                </option>
                            ))}
                        </select>
                    </Field>
                    <Field label="PO number"><input className="input" value={form.po_number} onChange={set('po_number')} placeholder="e.g. PO-4471" /></Field>
                </div>
                {isNew ? (
                    <Field label="Reserved date"><input className="input" type="date" value={form.reserved_at} onChange={set('reserved_at')} /></Field>
                ) : (
                    <>
                        <div className="form-row">
                            <Field label="Billing start"><input className="input" type="date" value={form.billing_start} onChange={set('billing_start')} /></Field>
                            <Field label="Call-off"><input className="input" type="date" value={form.calloff_at} onChange={set('calloff_at')} /></Field>
                        </div>
                        <Field label="Billing stop" hint="Date corrections are audit-logged. Use the lifecycle buttons for normal changes.">
                            <input className="input" type="date" value={form.billing_stop} onChange={set('billing_stop')} />
                        </Field>
                    </>
                )}
                <div className="form-row">
                    <Field label="Manual rate override ($)" hint="Leave blank to use the rate card">
                        <input className="input" type="number" min="0" step="0.01" value={form.rate_amount} onChange={set('rate_amount')} />
                    </Field>
                    <Field label="Override per">
                        <select className="select" value={form.rate_period} onChange={set('rate_period')} disabled={form.rate_amount === ''}>
                            <option value="day">Day</option><option value="week">Week</option><option value="month">28-day month</option>
                        </select>
                    </Field>
                </div>
                <Field label="Notes"><textarea className="textarea" rows={2} value={form.notes} onChange={set('notes')} /></Field>
            </div>
        </Modal>
    )
}
