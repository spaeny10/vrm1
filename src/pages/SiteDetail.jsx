import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useWorkspace } from '../components/WorkspaceProvider'
import { useToast } from '../components/ToastProvider'
import {
    fetchJobSite, updateJobSite, deleteJobSiteApi, fetchBoardTrailers, fetchRentals, fetchCompanies,
    fetchSiteContacts, fetchContacts, assignContact, removeContact,
    fetchSiteNotes, editSiteNote, deleteSiteNote, toggleNotePin, markNoteAsRead, fetchReplies, fetchMentionableUsers,
    apiGet, apiPost,
} from '../api/vrm'
import { Page, Card, Stats, Stat, Dot, Badge, HealthBadge, Soc, Signal, Search, Field, Modal, Empty, AllClear, Loading, Icon } from '../ui'
import { HEALTH, fmtAgo, fmtDate, fmtDateTime, fmtMoney, plural } from '../ui/format'
import { RentalStatusBadge, RentalActionButtons, pricingLabel, useRentalEventFlow } from '../components/RentalLifecycle'
import ReportPanel from '../components/ReportPanel'
import MentionInput, { extractMentions, renderNoteWithMentions } from '../components/MentionInput'
import TagPicker, { NOTE_CATEGORIES, parseTags } from '../components/TagPicker'

const HEALTH_ORDER = ['attention', 'offline', 'watch', 'unknown', 'good']
const CONTACT_ROLES = [
    { key: 'on-site', label: 'On-site' },
    { key: 'project-manager', label: 'Project manager' },
    { key: 'billing', label: 'Billing' },
    { key: 'emergency', label: 'Emergency' },
]
const roleLabel = r => CONTACT_ROLES.find(x => x.key === r)?.label || r
const VISIT_LABELS = { inspection: 'Inspection', repair: 'Repair', scheduled: 'Scheduled service', emergency: 'Emergency', installation: 'Installation', decommission: 'Decommission' }

// One job site: which trailers are there and how they're doing, the
// rentals that bill against it, the team's notes, contacts and service.
export default function SiteDetail() {
    const { id } = useParams()
    const siteId = Number(id)
    const navigate = useNavigate()
    const { user } = useAuth()
    const { workspace } = useWorkspace()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const isTech = workspace === 'tech'
    const [showReport, setShowReport] = useState(false)
    const [editing, setEditing] = useState(false)

    const siteFn = useCallback(() => fetchJobSite(id), [id])
    const boardFn = useCallback(() => fetchBoardTrailers(), [])
    const rentalsFn = useCallback(() => fetchRentals({ job_site_id: id, open: 1 }), [id])
    const { data: siteData, loading: siteLoading, error: siteError, refetch: refetchSite } = useApiPolling(siteFn, 60000)
    const { data: board, loading: boardLoading } = useApiPolling(boardFn, 60000)
    const { data: rentalsData, loading: rentalsLoading, refetch: refetchRentals } = useApiPolling(rentalsFn, 60000)
    const flow = useRentalEventFlow(() => refetchRentals())

    const site = siteData?.job_site?.id === siteId ? siteData.job_site : null
    const rentals = rentalsData?.rentals || []

    const trailers = useMemo(() => (board?.trailers || [])
        .filter(r => r.site?.id === siteId)
        .sort((a, b) => HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health) || String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true })),
    [board, siteId])

    const issues = trailers.filter(r => r.health === 'attention' || r.health === 'offline')
    const billing = rentals.filter(r => r.status === 'billing')

    if (!site) {
        if (siteLoading || (!siteData && !siteError)) return <Page title="Site" crumbs={[{ label: 'Sites', to: '/sites' }]}><Loading /></Page>
        return (
            <Page title="Site not found" crumbs={[{ label: 'Sites', to: '/sites' }]}>
                <Card><Empty title="We couldn't find this site">It may have been deleted. <Link className="link" to="/sites">Back to sites</Link></Empty></Card>
            </Page>
        )
    }

    const customer = site.company_id
        ? (workspace === 'billing'
            ? <Link className="link" to={`/customers?company=${site.company_id}`}>{site.company_name}</Link>
            : <span>{site.company_name}</span>)
        : <span className="faint">{site.is_headquarters ? 'Big View yard' : 'No customer'}</span>

    return (
        <Page
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>{site.name}{site.is_headquarters && <Badge tone="info">HQ</Badge>}</span>}
            crumbs={[{ label: 'Sites', to: '/sites' }, { label: site.name }]}
            sub={<span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {customer}
                <span className="faint">·</span><span>{site.address || <span className="faint">No address</span>}</span>
                {site.uid && <><span className="faint">·</span><span className="mono faint">{site.uid}</span></>}
            </span>}
            actions={<>
                <button className="btn" onClick={() => setShowReport(true)}><Icon name="doc" />Report</button>
                {canEdit && <button className="btn" onClick={() => setEditing(true)}><Icon name="edit" />Edit site</button>}
            </>}>

            <Stats>
                <Stat label="Trailers on site" value={board ? trailers.length : '—'} hint={board ? `${trailers.filter(t => t.online).length} online` : null} />
                <Stat label="Need attention or offline" value={board ? issues.length : '—'} tone={issues.length ? 'crit' : null} dot={issues.length ? 'crit' : 'ok'} />
                <Stat label="Rentals billing" value={rentalsData ? billing.length : '—'} dot="ok" />
                <Stat label="Open rentals" value={rentalsData ? rentals.length : '—'} hint={rentalsData && rentals.length > billing.length ? `${rentals.length - billing.length} not billing` : null} />
            </Stats>

            <div className="grid-main">
                <div className="stack">
                    <Card title="Trailers on this site" meta={trailers.length || null} flush>
                        {boardLoading && !board ? <Loading /> : trailers.length === 0 ? (
                            <Empty compact title="No trailers here right now">Trailers appear once they're delivered to this site.</Empty>
                        ) : (
                            <div className="list">
                                {trailers.map(r => (
                                    <Link key={r.key} to={`/trailer/${r.site_id}`} className="list-row">
                                        <Dot tone={HEALTH[r.health]?.tone} pulse={r.health === 'attention'} />
                                        <div className="main">
                                            <div className="title">{r.unit} <HealthBadge health={r.health} /></div>
                                            <div className="desc">
                                                {r.diagnosis || (r.health === 'good' ? 'Reporting normally' : '—')}
                                                {r.health === 'offline' && r.last_seen ? ` · last seen ${fmtAgo(r.last_seen)}` : ''}
                                            </div>
                                        </div>
                                        <div className="side" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                                            <Soc value={r.soc} />
                                            <Signal bars={r.signal_bars} online={r.online} />
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </Card>

                    <Card title="Rentals at this site" meta={rentals.length || null} flush
                        actions={!isTech && <Link to="/rentals" className="btn sm ghost">All rentals <Icon name="chevron" /></Link>}>
                        {rentalsLoading && !rentalsData ? <Loading /> : rentals.length === 0 ? (
                            <Empty compact title="No open rentals">Nothing is reserved, delivered or billing at this site.</Empty>
                        ) : (
                            <div className="list">
                                {rentals.map(r => (
                                    <div key={r.id} className="list-row">
                                        <div className="main">
                                            <div className="title">
                                                {r.vrm_site_id ? <Link className="link" to={`/trailer/${r.vrm_site_id}`}>{r.unit_number}</Link> : r.unit_number}
                                                <RentalStatusBadge status={r.status} />
                                                {r.po_number && <span className="faint" style={{ fontWeight: 400, fontSize: 12.5 }}>{r.po_number}</span>}
                                            </div>
                                            <div className="desc">
                                                {rentalWhen(r)}
                                                {!isTech && (pricingLabel(r) ? ` · ${pricingLabel(r)}` : ' · No rate set')}
                                            </div>
                                        </div>
                                        {!isTech && r.accrued_amount != null && (
                                            <div className="side"><span className="num" style={{ color: 'var(--text)' }}>{fmtMoney(r.total_due ?? r.accrued_amount)}</span><br />accrued</div>
                                        )}
                                        {canEdit && <RentalActionButtons rental={r} onAction={flow.start} />}
                                    </div>
                                ))}
                            </div>
                        )}
                    </Card>

                    <SiteNotes siteId={siteId} trailers={trailers} canEdit={canEdit} />
                </div>

                <div className="stack">
                    <ContactsCard site={site} canEdit={canEdit} workspace={workspace} />
                    <ServiceCard siteId={siteId} canEdit={canEdit} />
                </div>
            </div>

            {editing && <EditSiteModal site={site} isAdmin={user?.role === 'admin'} onClose={() => setEditing(false)}
                onSaved={() => { setEditing(false); refetchSite() }}
                onDeleted={() => navigate('/sites')} />}
            {showReport && <ReportPanel type="site" id={siteId} onClose={() => setShowReport(false)} />}
            {flow.modal}
        </Page>
    )
}

function rentalWhen(r) {
    if (r.status === 'reserved') return `Reserved ${fmtDate(r.reserved_at)}`
    if (r.status === 'delivered') return `Delivered ${fmtDate(r.delivered_at)}`
    if (r.status === 'called_off') return `Called off ${fmtDate(r.calloff_at)}`
    if (r.status === 'awaiting_pickup') return r.picked_up_at ? `Picked up ${fmtDate(r.picked_up_at)}` : `Billing stopped ${fmtDate(r.billing_stop)}`
    if (r.billing_start) return `Billing since ${fmtDate(r.billing_start)}`
    return ''
}

// ------------------------------------------------------------
// Notes thread
// ------------------------------------------------------------
function parseList(v) {
    if (!v) return []
    if (typeof v === 'string') { try { return JSON.parse(v) || [] } catch { return [] } }
    return Array.isArray(v) ? v : []
}

function SiteNotes({ siteId, trailers, canEdit }) {
    const { user } = useAuth()
    const toast = useToast()
    const [users, setUsers] = useState([])
    const [notes, setNotes] = useState([])
    const [total, setTotal] = useState(0)
    const [loaded, setLoaded] = useState(false)
    const [search, setSearch] = useState('')
    const [debounced, setDebounced] = useState('')
    const [tag, setTag] = useState('')
    const [author, setAuthor] = useState('')
    const [authors, setAuthors] = useState([])

    const [text, setText] = useState('')
    const [tags, setTags] = useState([])
    const [shared, setShared] = useState(false)
    const [posting, setPosting] = useState(false)

    const [editingId, setEditingId] = useState(null)
    const [editText, setEditText] = useState('')
    const [openThread, setOpenThread] = useState(null)
    const [replies, setReplies] = useState({})
    const [replyText, setReplyText] = useState('')
    const marked = useRef(new Set())

    useEffect(() => {
        fetchMentionableUsers().then(d => setUsers((d?.users || []).filter(u => u.role !== 'customer'))).catch(() => { })
    }, [])

    useEffect(() => {
        const t = setTimeout(() => setDebounced(search.trim()), 300)
        return () => clearTimeout(t)
    }, [search])

    const load = useCallback(async () => {
        try {
            const d = await fetchSiteNotes(siteId, { search: debounced, tag, author })
            const list = d?.notes || []
            setNotes(list)
            setTotal(d?.total || 0)
            if (!debounced && !tag && !author) setAuthors([...new Set(list.map(n => n.author).filter(Boolean))].sort())
            // Mark notes that @mention me as read so the author sees a receipt
            if (user?.display_name) {
                const me = user.display_name.toLowerCase()
                for (const n of list) {
                    const mentioned = parseList(n.mentions).some(m => String(m).toLowerCase() === me)
                    const read = (n.readers || []).some(r => r.user_id === user.id)
                    if (mentioned && !read && !marked.current.has(n.id)) {
                        marked.current.add(n.id)
                        markNoteAsRead(siteId, n.id).catch(() => { })
                    }
                }
            }
        } catch (err) {
            toast.error(`Couldn't load notes: ${err.message}`)
        } finally {
            setLoaded(true)
        }
    }, [siteId, debounced, tag, author, user, toast])

    useEffect(() => { load() }, [load])

    const loadReplies = async (noteId) => {
        try {
            const d = await fetchReplies(siteId, noteId)
            setReplies(prev => ({ ...prev, [noteId]: d?.replies || [] }))
        } catch (err) { toast.error(err.message) }
    }

    const post = async (e) => {
        e?.preventDefault?.()
        const body = text.trim()
        if (!body || posting) return
        setPosting(true)
        try {
            await apiPost(`/job-sites/${siteId}/notes`, {
                note: body, mentions: extractMentions(body, users), parent_id: null, tags, customer_visible: shared,
            })
            setText(''); setTags([]); setShared(false)
            toast.success(shared ? 'Note posted and shared with the customer' : 'Note posted')
            load()
        } catch (err) { toast.error(err.message) } finally { setPosting(false) }
    }

    const reply = async (parentId) => {
        const body = replyText.trim()
        if (!body) return
        try {
            await apiPost(`/job-sites/${siteId}/notes`, { note: body, mentions: extractMentions(body, users), parent_id: parentId, tags: [] })
            setReplyText('')
            await loadReplies(parentId)
            load()
        } catch (err) { toast.error(err.message) }
    }

    const saveEdit = async (noteId, parentId) => {
        const body = editText.trim()
        if (!body) return
        try {
            await editSiteNote(siteId, noteId, body)
            setEditingId(null)
            if (parentId) loadReplies(parentId)
            else load()
        } catch (err) { toast.error(err.message) }
    }

    const remove = async (n) => {
        if (!confirm(n.parent_id ? 'Delete this reply?' : 'Delete this note? Its replies are deleted too.')) return
        try {
            await deleteSiteNote(siteId, n.id)
            toast.success('Deleted')
            if (n.parent_id) loadReplies(n.parent_id)
            load()
        } catch (err) { toast.error(err.message) }
    }

    const pin = async (n) => {
        try {
            await toggleNotePin(siteId, n.id, !n.pinned)
            load()
        } catch (err) { toast.error(err.message) }
    }

    const toggleThread = (n) => {
        if (openThread === n.id) { setOpenThread(null); return }
        setOpenThread(n.id)
        setReplyText('')
        loadReplies(n.id)
    }

    const filtering = !!(debounced || tag || author)
    const tagOptions = [...NOTE_CATEGORIES, ...trailers.map(t => t.unit)]
    const canModify = n => user?.role === 'admin' || n.author === user?.display_name

    return (
        <Card title="Notes" meta={total || null} flush>
            {canEdit && (
                <form onSubmit={post} style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'grid', gap: 10 }}>
                    <MentionInput multiline rows={2} value={text} onChange={setText} onSubmit={post} users={users} disabled={posting}
                        placeholder="Add a note for the team… type @ to mention someone" />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <TagPicker trailers={trailers.map(t => ({ site_id: t.site_id, label: t.unit }))} selectedTags={tags} onTagsChange={setTags} />
                        <span className="spacer" />
                        <label className="check" title="Customers see shared notes in their portal">
                            <input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />
                            Share with customer
                        </label>
                        <button type="submit" className="btn primary sm" disabled={!text.trim() || posting}>{posting ? 'Posting…' : 'Post note'}</button>
                    </div>
                </form>
            )}

            <div className="toolbar" style={{ padding: '12px 18px 0', marginBottom: 0 }}>
                <Search value={search} onChange={setSearch} placeholder="Search notes…" />
                <select className="select" style={{ width: 'auto' }} value={tag} onChange={e => setTag(e.target.value)} aria-label="Filter by tag">
                    <option value="">All tags</option>
                    {tagOptions.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                {authors.length > 1 && (
                    <select className="select" style={{ width: 'auto' }} value={author} onChange={e => setAuthor(e.target.value)} aria-label="Filter by author">
                        <option value="">Anyone</option>
                        {authors.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                )}
                {filtering && <button className="btn ghost sm" onClick={() => { setSearch(''); setTag(''); setAuthor('') }}>Clear</button>}
            </div>

            <div style={{ padding: '4px 18px 6px' }}>
                {!loaded ? <Loading /> : notes.length === 0 ? (
                    filtering
                        ? <Empty compact title="No notes match">Try a different search or tag.</Empty>
                        : <Empty compact title="No notes yet">{canEdit ? 'Post the first note above — handoffs, access codes, customer requests.' : 'Nobody has written about this site yet.'}</Empty>
                ) : notes.map(n => {
                    const mentions = parseList(n.mentions)
                    const noteTags = parseTags(n.tags)
                    const replyCount = Number(n.reply_count) || 0
                    return (
                        <div key={n.id} className="note">
                            <NoteHead n={n} />
                            {editingId === n.id ? (
                                <EditBox value={editText} onChange={setEditText} onSave={() => saveEdit(n.id)} onCancel={() => setEditingId(null)} />
                            ) : (
                                <div className="note-body">{renderNoteWithMentions(n.note, mentions)}</div>
                            )}
                            {noteTags.length > 0 && (
                                <div className="btn-row" style={{ marginTop: 8 }}>
                                    {noteTags.map((t, i) => t.type === 'trailer'
                                        ? <Link key={i} to={`/trailer/${t.id}`}><Badge tone="info">{t.label}</Badge></Link>
                                        : <Badge key={i} tone="plain">{t.label}</Badge>)}
                                </div>
                            )}
                            {mentions.length > 0 && (
                                <div className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>
                                    {(n.readers || []).length > 0
                                        ? <>Seen by {n.readers.map(r => r.display_name).join(', ')}</>
                                        : <>Not seen yet by {mentions.join(', ')}</>}
                                </div>
                            )}
                            <div className="btn-row" style={{ marginTop: 6, marginLeft: -10 }}>
                                {(canEdit || replyCount > 0) && (
                                    <button className="btn ghost sm" onClick={() => toggleThread(n)}>
                                        {openThread === n.id ? 'Hide replies' : replyCount > 0 ? plural(replyCount, 'reply', 'replies') : 'Reply'}
                                    </button>
                                )}
                                {canEdit && <button className="btn ghost sm" onClick={() => pin(n)}>{n.pinned ? 'Unpin' : 'Pin'}</button>}
                                {canModify(n) && editingId !== n.id && <>
                                    <button className="btn ghost sm" onClick={() => { setEditingId(n.id); setEditText(n.note) }}>Edit</button>
                                    <button className="btn ghost sm danger" onClick={() => remove(n)}>Delete</button>
                                </>}
                            </div>
                            {openThread === n.id && (
                                <div style={{ marginLeft: 14, paddingLeft: 14, borderLeft: '2px solid var(--border)', marginTop: 6 }}>
                                    {!replies[n.id] ? <span className="faint" style={{ fontSize: 13 }}>Loading replies…</span>
                                        : replies[n.id].map(r => (
                                            <div key={r.id} className="note" style={{ padding: '8px 0' }}>
                                                <NoteHead n={r} />
                                                {editingId === r.id
                                                    ? <EditBox value={editText} onChange={setEditText} onSave={() => saveEdit(r.id, n.id)} onCancel={() => setEditingId(null)} />
                                                    : <div className="note-body">{renderNoteWithMentions(r.note, parseList(r.mentions))}</div>}
                                                {canModify(r) && editingId !== r.id && (
                                                    <div className="btn-row" style={{ marginTop: 4, marginLeft: -10 }}>
                                                        <button className="btn ghost sm" onClick={() => { setEditingId(r.id); setEditText(r.note) }}>Edit</button>
                                                        <button className="btn ghost sm danger" onClick={() => remove(r)}>Delete</button>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    {canEdit && (
                                        <div style={{ display: 'flex', gap: 8, padding: '8px 0 4px' }}>
                                            <MentionInput value={replyText} onChange={setReplyText} onSubmit={() => reply(n.id)} users={users} autoFocus
                                                placeholder="Write a reply…" />
                                            <button className="btn sm" style={{ height: 36 }} onClick={() => reply(n.id)} disabled={!replyText.trim()}>Reply</button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </Card>
    )
}

function NoteHead({ n }) {
    return (
        <div className="note-head" style={{ flexWrap: 'wrap' }}>
            <b>{n.author || 'System'}</b>
            <span title={fmtDateTime(n.created_at)}>{fmtAgo(n.created_at)}</span>
            {n.updated_at && <span title={`Edited ${fmtDateTime(n.updated_at)}`}>(edited)</span>}
            {n.pinned && <Badge tone="warn">Pinned</Badge>}
            {n.customer_visible && <Badge tone="info">Shared with customer</Badge>}
        </div>
    )
}

function EditBox({ value, onChange, onSave, onCancel }) {
    return (
        <div style={{ display: 'grid', gap: 8, margin: '4px 0' }}>
            <textarea className="textarea" rows={2} value={value} autoFocus onChange={e => onChange(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSave() }
                    if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
                }} />
            <div className="btn-row">
                <button className="btn sm" onClick={onSave} disabled={!value.trim()}>Save</button>
                <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    )
}

// ------------------------------------------------------------
// Contacts
// ------------------------------------------------------------
function ContactsCard({ site, canEdit, workspace }) {
    const toast = useToast()
    const fn = useCallback(() => fetchSiteContacts(site.id), [site.id])
    const { data, loading, refetch } = useApiPolling(fn, 300000)
    const contacts = data?.contacts || []
    const [assigning, setAssigning] = useState(false)

    const unassign = async (c) => {
        if (!confirm(`Remove ${c.name} from this site? They stay on the customer's contact list.`)) return
        try {
            await removeContact(site.id, c.contact_id)
            toast.success(`${c.name} removed from site`)
            refetch()
        } catch (err) { toast.error(err.message) }
    }

    return (
        <Card title="Contacts" meta={contacts.length || null} flush
            actions={canEdit && <button className="btn sm" onClick={() => setAssigning(true)}><Icon name="plus" />Assign</button>}>
            {loading && !data ? <Loading /> : contacts.length === 0 ? (
                <Empty compact title="No contacts on this site">
                    {site.company_id ? 'Assign someone from the customer so the field team knows who to call.' : 'Link this site to a customer first, then assign their contacts.'}
                </Empty>
            ) : (
                <div className="list">
                    {contacts.map(c => (
                        <div key={c.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                            <div className="main">
                                <div className="title">{c.name} {c.role && <Badge tone="plain">{roleLabel(c.role)}</Badge>}</div>
                                {c.title && <div className="desc">{c.title}</div>}
                                <div className="desc" style={{ display: 'grid', gap: 2, marginTop: 4 }}>
                                    {c.phone && <a className="link" href={`tel:${c.phone}`}>{c.phone}</a>}
                                    {c.email && <a className="link" href={`mailto:${c.email}`} style={{ overflowWrap: 'anywhere' }}>{c.email}</a>}
                                </div>
                            </div>
                            {canEdit && <button className="icon-btn" onClick={() => unassign(c)} title="Remove from site" aria-label={`Remove ${c.name}`}><Icon name="x" /></button>}
                        </div>
                    ))}
                </div>
            )}
            {assigning && <AssignContactModal site={site} assigned={contacts} workspace={workspace}
                onClose={() => setAssigning(false)} onDone={() => { setAssigning(false); refetch() }} />}
        </Card>
    )
}

function AssignContactModal({ site, assigned, workspace, onClose, onDone }) {
    const toast = useToast()
    const [available, setAvailable] = useState(null)
    const [contactId, setContactId] = useState('')
    const [role, setRole] = useState('on-site')
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (!site.company_id) { setAvailable([]); return }
        fetchContacts(site.company_id)
            .then(d => setAvailable((d?.contacts || []).filter(c => !assigned.some(a => a.contact_id === c.id))))
            .catch(() => setAvailable([]))
    }, [site.company_id, assigned])

    const save = async () => {
        setSaving(true)
        try {
            await assignContact(site.id, Number(contactId), role)
            toast.success('Contact assigned')
            onDone()
        } catch (err) { toast.error(err.message) } finally { setSaving(false) }
    }

    const addHint = workspace === 'billing'
        ? <>Add new people on the <Link className="link" to={`/customers?company=${site.company_id}`}>customer's page</Link>.</>
        : <>New people are added from the customer's page in the Billing workspace.</>

    return (
        <Modal title="Assign a contact" onClose={onClose}
            footer={available?.length ? <>
                <button className="btn ghost" onClick={onClose}>Cancel</button>
                <button className="btn primary" onClick={save} disabled={!contactId || saving}>{saving ? 'Assigning…' : 'Assign'}</button>
            </> : <button className="btn" onClick={onClose}>Close</button>}>
            {!site.company_id ? (
                <div className="callout">This site isn't linked to a customer yet. Choose a customer under Edit site, then assign their contacts.</div>
            ) : available == null ? <Loading /> : available.length === 0 ? (
                <div className="callout">Everyone at {site.company_name} is already assigned here, or they have no contacts yet. {addHint}</div>
            ) : (
                <div className="form">
                    <Field label="Contact">
                        <select className="select" value={contactId} onChange={e => setContactId(e.target.value)} autoFocus>
                            <option value="">Choose a contact…</option>
                            {available.map(c => <option key={c.id} value={c.id}>{c.name}{c.title ? ` — ${c.title}` : ''}</option>)}
                        </select>
                    </Field>
                    <Field label="Role at this site">
                        <select className="select" value={role} onChange={e => setRole(e.target.value)}>
                            {CONTACT_ROLES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                        </select>
                    </Field>
                    <small className="faint">{addHint}</small>
                </div>
            )}
        </Modal>
    )
}

// ------------------------------------------------------------
// Field service
// ------------------------------------------------------------
function ServiceCard({ siteId, canEdit }) {
    const navigate = useNavigate()
    const fn = useCallback(() => apiGet(`/maintenance?job_site_id=${siteId}&limit=30`), [siteId])
    const { data, loading } = useApiPolling(fn, 120000)
    const logs = data?.logs || []
    const now = Date.now()
    const upcoming = logs.filter(m => m.status === 'scheduled' || m.status === 'in_progress')
        .sort((a, b) => (a.scheduled_date || 0) - (b.scheduled_date || 0))
    const recent = logs.filter(m => m.status === 'completed' || m.status === 'cancelled')
        .sort((a, b) => (b.completed_date || b.scheduled_date || 0) - (a.completed_date || a.scheduled_date || 0))
        .slice(0, 5)

    const row = (m, done) => {
        const overdue = m.status === 'scheduled' && m.scheduled_date && m.scheduled_date < now - 86400000
        return (
            <Link key={m.id} to="/maintenance" className="list-row">
                <Dot tone={done ? (m.status === 'completed' ? 'ok' : 'off') : overdue ? 'crit' : m.status === 'in_progress' ? 'info' : 'warn'} />
                <div className="main">
                    <div className="title">{m.title}</div>
                    <div className="desc">{[VISIT_LABELS[m.visit_type] || m.visit_type, m.trailer_name, m.assigned_technician_name || m.technician].filter(Boolean).join(' · ')}</div>
                </div>
                <div className="side">
                    {m.status === 'in_progress' ? <Badge tone="info">In progress</Badge>
                        : overdue ? <Badge tone="crit">Overdue</Badge>
                            : m.status === 'cancelled' ? 'Cancelled'
                                : fmtDate(done ? (m.completed_date || m.scheduled_date) : m.scheduled_date, { year: false })}
                </div>
            </Link>
        )
    }

    return (
        <Card title="Service" flush
            actions={canEdit && <button className="btn sm" onClick={() => navigate(`/maintenance?new=1&job_site_id=${siteId}`)}><Icon name="calendar" />Schedule service</button>}>
            {loading && !data ? <Loading /> : (
                <>
                    <div className="faint" style={{ padding: '12px 18px 4px', fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>Upcoming</div>
                    {upcoming.length === 0 ? <AllClear>No service scheduled.</AllClear> : <div className="list">{upcoming.map(m => row(m, false))}</div>}
                    <div className="faint" style={{ padding: '12px 18px 4px', fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', borderTop: '1px solid var(--border)' }}>Recent</div>
                    {recent.length === 0 ? <div className="faint" style={{ padding: '6px 18px 16px', fontSize: 13 }}>No service history yet.</div> : <div className="list">{recent.map(m => row(m, true))}</div>}
                </>
            )}
        </Card>
    )
}

// ------------------------------------------------------------
// Edit site
// ------------------------------------------------------------
function EditSiteModal({ site, isAdmin, onClose, onSaved, onDeleted }) {
    const toast = useToast()
    const [form, setForm] = useState({
        name: site.name || '',
        address: site.address || '',
        geofence_radius_m: site.geofence_radius_m ?? 500,
        is_headquarters: !!site.is_headquarters,
        company_id: site.company_id ?? '',
    })
    const [companies, setCompanies] = useState([])
    const [saving, setSaving] = useState(false)
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [typed, setTyped] = useState('')
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

    useEffect(() => {
        fetchCompanies().then(d => setCompanies(d?.companies || [])).catch(() => { })
    }, [])

    const save = async (e) => {
        e?.preventDefault()
        const changes = {}
        const name = form.name.trim()
        const address = form.address.trim()
        const radius = parseInt(form.geofence_radius_m, 10)
        if (!name) return toast.error('Site name is required')
        if (!(radius > 0)) return toast.error('Geofence radius must be a positive number of meters')
        if (name !== site.name) changes.name = name
        if (address !== (site.address || '')) changes.address = address || null
        if (radius !== site.geofence_radius_m) changes.geofence_radius_m = radius
        const companyId = form.company_id === '' ? null : Number(form.company_id)
        if (companyId !== (site.company_id ?? null)) changes.company_id = companyId
        if (isAdmin && form.is_headquarters !== !!site.is_headquarters) changes.is_headquarters = form.is_headquarters
        if (!Object.keys(changes).length) return onClose()
        setSaving(true)
        try {
            await updateJobSite(site.id, changes)
            toast.success(changes.address ? 'Site saved — pin moved to the new address' : 'Site saved')
            onSaved()
        } catch (err) { toast.error(err.message) } finally { setSaving(false) }
    }

    const doDelete = async () => {
        setSaving(true)
        try {
            await deleteJobSiteApi(site.id)
            toast.success(`${site.name} deleted`)
            onDeleted()
        } catch (err) { toast.error(err.message); setSaving(false) }
    }

    if (confirmDelete) {
        return (
            <Modal title={`Delete ${site.name}?`} onClose={() => setConfirmDelete(false)}
                footer={<>
                    <button className="btn ghost" onClick={() => setConfirmDelete(false)} disabled={saving}>Keep site</button>
                    <button className="btn danger solid" onClick={doDelete} disabled={typed.trim() !== site.name || saving}>{saving ? 'Deleting…' : 'Delete site'}</button>
                </>}>
                <div className="form">
                    <div className="callout crit">
                        <Icon name="alert" size={18} />
                        <div>This permanently deletes the site and its notes. Trailers here become unassigned, and rentals and service visits lose their site link. This can't be undone.</div>
                    </div>
                    <Field label={<>Type <b>{site.name}</b> to confirm</>}>
                        <input className="input" value={typed} onChange={e => setTyped(e.target.value)} autoFocus />
                    </Field>
                </div>
            </Modal>
        )
    }

    return (
        <Modal title="Edit site" onClose={onClose}
            footer={<>
                {isAdmin && <button className="btn ghost danger" style={{ marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>Delete site…</button>}
                <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
                <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
            </>}>
            <form className="form" onSubmit={save}>
                <Field label="Site name">
                    <input className="input" value={form.name} onChange={e => set('name', e.target.value)} autoFocus />
                </Field>
                <Field label="Address" hint="Changing the address looks up its coordinates and moves the site pin.">
                    <input className="input" value={form.address} onChange={e => set('address', e.target.value)} placeholder="123 Main St, Dallas, TX" />
                </Field>
                <div className="form-row" style={{ alignItems: 'start' }}>
                    <Field label="Customer">
                        <select className="select" value={form.company_id} onChange={e => set('company_id', e.target.value)}>
                            <option value="">No customer</option>
                            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                    </Field>
                    <Field label="Geofence radius (m)" hint="Alerts when a trailer leaves this circle.">
                        <input className="input" type="number" min="50" step="50" value={form.geofence_radius_m} onChange={e => set('geofence_radius_m', e.target.value)} />
                    </Field>
                </div>
                {isAdmin && (
                    <label className="check">
                        <input type="checkbox" checked={form.is_headquarters} onChange={e => set('is_headquarters', e.target.checked)} />
                        This is the Big View yard (HQ)
                    </label>
                )}
                <button type="submit" hidden />
            </form>
        </Modal>
    )
}
