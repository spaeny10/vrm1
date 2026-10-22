import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useWorkspace } from '../components/WorkspaceProvider'
import { useToast } from '../components/ToastProvider'
import {
    fetchCompanies, createCompany, updateCompanyApi, fetchContacts, createContact, updateContactApi, deleteContactApi,
    fetchJobSites, createJobSite, updateJobSite, fetchSiteContacts, assignContact, inviteContactToPortal, fetchRentals,
} from '../api/vrm'
import { Page, Card, DataTable, Search, Field, Modal, Drawer, Badge, Empty, Loading, KV, Icon } from '../ui'
import { fmtMoney, plural } from '../ui/format'
import { RentalStatusBadge, pricingLabel } from '../components/RentalLifecycle'

const ON_RENT = new Set(['billing', 'called_off'])
const EMPTY_COMPANY = { name: '', address: '', city: '', state: '', zip: '', notes: '' }
const EMPTY_CONTACT = { name: '', title: '', phone: '', email: '', is_primary: false }

// Billing workspace: every customer with their people, sites and what's on rent.
export default function CustomersPage() {
    const { user } = useAuth()
    const { workspace } = useWorkspace()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const hideMoney = workspace === 'tech'
    const [params, setParams] = useSearchParams()
    const [q, setQ] = useState('')
    const [creating, setCreating] = useState(false)

    const companiesFn = useCallback(() => fetchCompanies(), [])
    const rentalsFn = useCallback(() => fetchRentals({ open: 1 }), [])
    const sitesFn = useCallback(() => fetchJobSites(), [])
    const { data: companiesData, loading, refetch: refetchCompanies } = useApiPolling(companiesFn, 120000)
    const { data: rentalsData } = useApiPolling(rentalsFn, 120000)
    const { data: sitesData, refetch: refetchSites } = useApiPolling(sitesFn, 120000)

    const companies = useMemo(() => companiesData?.companies || [], [companiesData])
    const rentals = useMemo(() => rentalsData?.rentals || [], [rentalsData])
    const sites = useMemo(() => sitesData?.job_sites || [], [sitesData])

    const onRentBy = useMemo(() => {
        const m = new Map()
        for (const r of rentals) if (ON_RENT.has(r.status) && r.company_id) m.set(r.company_id, (m.get(r.company_id) || 0) + 1)
        return m
    }, [rentals])

    const filtered = useMemo(() => {
        const term = q.trim().toLowerCase()
        if (!term) return companies
        return companies.filter(c => [c.name, c.city, c.state, c.address].some(v => v && v.toLowerCase().includes(term)))
    }, [companies, q])

    const selectedId = Number(params.get('company')) || null
    const selected = companies.find(c => c.id === selectedId) || null
    const open = id => setParams(id ? { company: String(id) } : {})
    const refreshAll = () => { refetchCompanies(); refetchSites() }
    const totalOnRent = [...onRentBy.values()].reduce((a, b) => a + b, 0)

    const columns = [
        {
            key: 'name', label: 'Customer', sort: c => c.name,
            render: c => <div><span className="primary">{c.name}</span><div className="sub">{[c.city, c.state].filter(Boolean).join(', ') || '—'}</div></div>,
        },
        { key: 'contacts', label: 'Contacts', align: 'r', sort: c => Number(c.contact_count), render: c => <span className="num">{Number(c.contact_count) || 0}</span> },
        { key: 'sites', label: 'Sites', align: 'r', sort: c => Number(c.site_count), render: c => <span className="num">{Number(c.site_count) || 0}</span> },
        {
            key: 'rent', label: 'On rent', align: 'r', sort: c => onRentBy.get(c.id) || 0,
            render: c => onRentBy.get(c.id) ? <span className="num">{onRentBy.get(c.id)}</span> : <span className="faint">—</span>,
        },
    ]

    return (
        <Page title="Customers"
            sub={companiesData ? `${plural(companies.length, 'customer')} · ${plural(totalOnRent, 'trailer')} on rent` : 'Loading…'}
            actions={canEdit && <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" />New customer</button>}>
            <div>
                <div className="toolbar">
                    <Search value={q} onChange={setQ} placeholder="Search name or city…" />
                </div>
                <Card flush>
                    {loading && !companiesData ? <Loading /> : (
                        <DataTable columns={columns} rows={filtered} onRowClick={c => open(c.id)} initialSort={{ key: 'name', dir: 'asc' }}
                            empty={q
                                ? <Empty compact title="No customers match">Try a different name or city.</Empty>
                                : <Empty title="No customers yet">{canEdit ? 'Add your first customer to start creating sites and rentals.' : 'Customers appear here once they are added.'}</Empty>} />
                    )}
                </Card>
            </div>

            {selected && (
                <CustomerDrawer key={selected.id} company={selected} allSites={sites} rentals={rentals}
                    canEdit={canEdit} isAdmin={user?.role === 'admin'} hideMoney={hideMoney}
                    onChanged={refreshAll} onClose={() => open(null)} />
            )}
            {creating && (
                <NewCustomerModal onClose={() => setCreating(false)}
                    onCreated={async (c) => { setCreating(false); await refetchCompanies(); open(c.id) }} />
            )}
        </Page>
    )
}

function CompanyFields({ value, set }) {
    return (
        <>
            <Field label="Company name">
                <input className="input" value={value.name} onChange={e => set('name', e.target.value)} placeholder="ABC Construction LLC" autoFocus />
            </Field>
            <Field label="Street address">
                <input className="input" value={value.address || ''} onChange={e => set('address', e.target.value)} placeholder="123 Main St" />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
                <Field label="City"><input className="input" value={value.city || ''} onChange={e => set('city', e.target.value)} /></Field>
                <Field label="State"><input className="input" value={value.state || ''} onChange={e => set('state', e.target.value)} maxLength={2} placeholder="TX" /></Field>
                <Field label="ZIP"><input className="input" value={value.zip || ''} onChange={e => set('zip', e.target.value)} /></Field>
            </div>
            <Field label="Internal notes">
                <textarea className="textarea" rows={2} value={value.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Billing preferences, PO requirements…" />
            </Field>
        </>
    )
}

function NewCustomerModal({ onClose, onCreated }) {
    const toast = useToast()
    const [form, setForm] = useState(EMPTY_COMPANY)
    const [saving, setSaving] = useState(false)
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

    const save = async (e) => {
        e?.preventDefault()
        if (!form.name.trim()) return
        setSaving(true)
        try {
            const res = await createCompany({ ...form, name: form.name.trim() })
            toast.success(`${res.company.name} added`)
            onCreated(res.company)
        } catch (err) { toast.error(err.message); setSaving(false) }
    }

    return (
        <Modal title="New customer" onClose={onClose}
            footer={<>
                <button className="btn ghost" onClick={onClose}>Cancel</button>
                <button className="btn primary" onClick={save} disabled={!form.name.trim() || saving}>{saving ? 'Adding…' : 'Add customer'}</button>
            </>}>
            <form className="form" onSubmit={save}>
                <CompanyFields value={form} set={set} />
                <button type="submit" hidden />
            </form>
        </Modal>
    )
}

// ------------------------------------------------------------
// Customer drawer
// ------------------------------------------------------------
function Section({ title, count, action, children }) {
    return (
        <section>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                    {title}{count ? <span className="faint" style={{ marginLeft: 6 }}>{count}</span> : null}
                </h3>
                {action && <div className="btn-row">{action}</div>}
            </div>
            {children}
        </section>
    )
}

const boxStyle = { border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }
const formBoxStyle = { border: '1px solid var(--border-strong)', borderRadius: 'var(--radius)', padding: 14, background: 'var(--surface-2)', marginBottom: 10 }

function CustomerDrawer({ company, allSites, rentals, canEdit, isAdmin, hideMoney, onChanged, onClose }) {
    const toast = useToast()
    const [editingInfo, setEditingInfo] = useState(null)
    const [contacts, setContacts] = useState(null)
    const [siteLinks, setSiteLinks] = useState({}) // contactId -> [siteId]
    const [contactForm, setContactForm] = useState(null) // { id?, ...fields }
    const [inviteFor, setInviteFor] = useState(null)
    const [inviteResult, setInviteResult] = useState(null)
    const [siteForm, setSiteForm] = useState(null)
    const [linking, setLinking] = useState(false)
    const [busy, setBusy] = useState(false)

    const sites = useMemo(() => allSites.filter(s => s.company_id === company.id).sort((a, b) => a.name.localeCompare(b.name)), [allSites, company.id])
    const unlinked = useMemo(() => allSites.filter(s => !s.company_id && !s.is_headquarters).sort((a, b) => a.name.localeCompare(b.name)), [allSites])
    const myRentals = rentals.filter(r => r.company_id === company.id)
    const onRent = myRentals.filter(r => ON_RENT.has(r.status))
    const accrued = myRentals.reduce((a, r) => a + (Number(r.total_due ?? r.accrued_amount) || 0), 0)
    const siteKey = sites.map(s => s.id).join(',')

    const loadContacts = useCallback(async () => {
        try {
            const d = await fetchContacts(company.id)
            setContacts(d?.contacts || [])
        } catch (err) { toast.error(err.message); setContacts([]) }
    }, [company.id, toast])

    // Which sites each contact is assigned to (drives portal visibility)
    const loadLinks = useCallback(async () => {
        const ids = siteKey ? siteKey.split(',').map(Number) : []
        const results = await Promise.all(ids.map(id => fetchSiteContacts(id).then(d => [id, d?.contacts || []]).catch(() => [id, []])))
        const map = {}
        for (const [sid, list] of results) for (const c of list) (map[c.contact_id] ||= []).push(sid)
        setSiteLinks(map)
    }, [siteKey])

    useEffect(() => { loadContacts() }, [loadContacts])
    useEffect(() => { loadLinks() }, [loadLinks])

    const run = async (fn, ok) => {
        setBusy(true)
        try { await fn(); if (ok) toast.success(ok); return true } catch (err) { toast.error(err.message); return false } finally { setBusy(false) }
    }

    const saveInfo = async () => {
        if (!editingInfo.name?.trim()) return toast.error('Company name is required')
        const { name, address, city, state, zip, notes } = editingInfo
        if (await run(() => updateCompanyApi(company.id, { name: name.trim(), address, city, state, zip, notes }), 'Customer saved')) {
            setEditingInfo(null); onChanged()
        }
    }

    const saveContact = async () => {
        const f = contactForm
        if (!f.name?.trim()) return toast.error('Contact name is required')
        const body = { name: f.name.trim(), title: f.title || null, phone: f.phone || null, email: f.email?.trim() || null, is_primary: !!f.is_primary }
        const ok = await run(() => f.id ? updateContactApi(f.id, body) : createContact(company.id, body), f.id ? 'Contact saved' : 'Contact added')
        if (ok) { setContactForm(null); loadContacts(); onChanged() }
    }

    const deleteContact = async (c) => {
        if (!confirm(`Delete ${c.name}? They're removed from every site too.`)) return
        if (await run(() => deleteContactApi(c.id), 'Contact deleted')) { loadContacts(); loadLinks(); onChanged() }
    }

    const invite = async (c, siteIds) => {
        const already = siteLinks[c.id] || []
        let result = null
        const ok = await run(async () => {
            for (const sid of siteIds) if (!already.includes(sid)) await assignContact(sid, c.id, 'on-site')
            result = await inviteContactToPortal(c.id)
        })
        if (ok && result) {
            setInviteFor(null)
            setInviteResult({ name: c.name, username: c.email.toLowerCase(), password: result.temp_password, sites: result.sites_linked })
            loadContacts(); loadLinks()
        }
    }

    const createSite = async () => {
        if (!siteForm.name.trim()) return
        const ok = await run(() => createJobSite({ company_id: company.id, name: siteForm.name.trim(), address: siteForm.address.trim() || null }), 'Site created')
        if (ok) { setSiteForm(null); onChanged() }
    }

    const linkSite = async (siteId) => {
        if (await run(() => updateJobSite(siteId, { company_id: company.id }), 'Site linked')) { setLinking(false); onChanged() }
    }

    const copy = async (text) => {
        try { await navigator.clipboard.writeText(text); toast.success('Copied') } catch { toast.error('Copy failed — select the text and copy it manually') }
    }

    const location = [company.city, company.state].filter(Boolean).join(', ')

    return (
        <Drawer title={company.name} sub={location || null} onClose={onClose}
            actions={canEdit && !editingInfo && <button className="btn sm" onClick={() => setEditingInfo({ ...company })}><Icon name="edit" />Edit</button>}>

            {editingInfo ? (
                <div style={formBoxStyle} className="form">
                    <CompanyFields value={editingInfo} set={(k, v) => setEditingInfo(f => ({ ...f, [k]: v }))} />
                    <div className="btn-row">
                        <button className="btn primary sm" onClick={saveInfo} disabled={busy}>Save</button>
                        <button className="btn ghost sm" onClick={() => setEditingInfo(null)}>Cancel</button>
                    </div>
                </div>
            ) : (
                <KV items={[
                    ['Address', [company.address, company.city, company.state, company.zip].filter(Boolean).join(', ') || null],
                    ['On rent', plural(onRent.length, 'trailer')],
                    !hideMoney && ['Accrued (open rentals)', fmtMoney(accrued)],
                    company.notes && ['Notes', <span key="n" style={{ whiteSpace: 'pre-wrap', textAlign: 'left' }}>{company.notes}</span>],
                ]} />
            )}

            {inviteResult && (
                <div className="callout ok" style={{ display: 'grid', gap: 10 }}>
                    <div><b>Portal account created for {inviteResult.name}.</b> Send them these sign-in details. They'll be asked to choose their own password the first time they sign in, and this temporary password won't be shown again.</div>
                    <KV items={[
                        ['Username', <span key="u" className="mono">{inviteResult.username}</span>],
                        ['Temporary password', <span key="p" className="mono">{inviteResult.password}</span>],
                        ['Sites they can see', inviteResult.sites],
                    ]} />
                    <div className="btn-row">
                        <button className="btn sm" onClick={() => copy(`Sign in at ${window.location.origin}\nUsername: ${inviteResult.username}\nTemporary password: ${inviteResult.password}\nYou'll be asked to choose a new password when you first sign in.`)}>Copy sign-in details</button>
                        <button className="btn ghost sm" onClick={() => setInviteResult(null)}>Done</button>
                    </div>
                </div>
            )}

            <Section title="Contacts" count={contacts?.length}
                action={canEdit && !contactForm && <button className="btn sm" onClick={() => setContactForm({ ...EMPTY_CONTACT })}><Icon name="plus" />Add contact</button>}>
                {contactForm && !contactForm.id && <ContactForm value={contactForm} setValue={setContactForm} onSave={saveContact} onCancel={() => setContactForm(null)} busy={busy} />}
                {contacts == null ? <Loading /> : contacts.length === 0 && !contactForm ? (
                    <div style={boxStyle}><Empty compact title="No contacts yet">Add the project manager or site superintendent.</Empty></div>
                ) : contacts.length > 0 && (
                    <div className="list" style={boxStyle}>
                        {contacts.map(c => contactForm?.id === c.id ? (
                            <div key={c.id} style={{ padding: 12 }}><ContactForm value={contactForm} setValue={setContactForm} onSave={saveContact} onCancel={() => setContactForm(null)} busy={busy} /></div>
                        ) : (
                            <div key={c.id} className="list-row" style={{ display: 'block' }}>
                                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                    <div className="main">
                                        <div className="title">
                                            {c.name}
                                            {c.is_primary && <Badge tone="plain">Primary</Badge>}
                                            {c.portal_user_id && <Badge tone="ok">Portal access</Badge>}
                                        </div>
                                        <div className="desc">{[c.title, c.phone].filter(Boolean).join(' · ') || (c.email ? null : <span className="faint">No phone or email</span>)}</div>
                                        {c.email && <div className="desc" style={{ overflowWrap: 'anywhere' }}>{c.email}</div>}
                                        {(siteLinks[c.id] || []).length > 0 && (
                                            <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>
                                                On {sites.filter(s => siteLinks[c.id].includes(s.id)).map(s => s.name).join(', ')}
                                            </div>
                                        )}
                                    </div>
                                    {canEdit && (
                                        <div className="btn-row" style={{ flexShrink: 0 }}>
                                            {c.email && !c.portal_user_id && inviteFor !== c.id && <button className="btn sm" onClick={() => setInviteFor(c.id)}>Invite to portal</button>}
                                            <button className="btn ghost sm" onClick={() => setContactForm({ ...c })}>Edit</button>
                                            {isAdmin && <button className="btn ghost sm danger" onClick={() => deleteContact(c)}>Delete</button>}
                                        </div>
                                    )}
                                </div>
                                {inviteFor === c.id && (
                                    <InvitePanel contact={c} sites={sites} linked={siteLinks[c.id] || []} busy={busy}
                                        onInvite={ids => invite(c, ids)} onCancel={() => setInviteFor(null)} />
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            <Section title="Sites" count={sites.length}
                action={canEdit && !siteForm && !linking && <>
                    {unlinked.length > 0 && <button className="btn ghost sm" onClick={() => setLinking(true)}>Link existing</button>}
                    <button className="btn sm" onClick={() => setSiteForm({ name: '', address: '' })}><Icon name="plus" />New site</button>
                </>}>
                {siteForm && (
                    <div style={formBoxStyle} className="form">
                        <Field label="Site name">
                            <input className="input" value={siteForm.name} onChange={e => setSiteForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Downtown Tower Phase 2" autoFocus />
                        </Field>
                        <Field label="Address" hint="We look up the coordinates from the address so the site shows on the map.">
                            <input className="input" value={siteForm.address} onChange={e => setSiteForm(f => ({ ...f, address: e.target.value }))} placeholder="123 Main St, Dallas, TX"
                                onKeyDown={e => { if (e.key === 'Enter') createSite() }} />
                        </Field>
                        <div className="btn-row">
                            <button className="btn primary sm" onClick={createSite} disabled={!siteForm.name.trim() || busy}>{busy ? 'Creating…' : 'Create site'}</button>
                            <button className="btn ghost sm" onClick={() => setSiteForm(null)}>Cancel</button>
                        </div>
                    </div>
                )}
                {linking && (
                    <div style={formBoxStyle} className="form">
                        <Field label="Link a site that has no customer">
                            <select className="select" value="" onChange={e => e.target.value && linkSite(Number(e.target.value))} disabled={busy} autoFocus>
                                <option value="">Choose a site…</option>
                                {unlinked.map(s => <option key={s.id} value={s.id}>{s.name}{s.address ? ` — ${s.address}` : ''}</option>)}
                            </select>
                        </Field>
                        <div className="btn-row"><button className="btn ghost sm" onClick={() => setLinking(false)}>Cancel</button></div>
                    </div>
                )}
                {sites.length === 0 ? (
                    !siteForm && <div style={boxStyle}><Empty compact title="No sites yet">Create a site for each job location you deliver trailers to.</Empty></div>
                ) : (
                    <div className="list" style={boxStyle}>
                        {sites.map(s => (
                            <Link key={s.id} to={`/site/${s.id}`} className="list-row">
                                <Icon name="pin" size={16} />
                                <div className="main">
                                    <div className="title">{s.name}</div>
                                    <div className="desc">{s.address || <span className="faint">No address</span>}</div>
                                </div>
                                <div className="side">{plural(Number(s.trailer_count) || 0, 'trailer')}</div>
                            </Link>
                        ))}
                    </div>
                )}
            </Section>

            <Section title="Open rentals" count={myRentals.length}
                action={<Link to="/rentals" className="btn ghost sm">All rentals <Icon name="chevron" /></Link>}>
                {myRentals.length === 0 ? (
                    <div style={boxStyle}><Empty compact title="Nothing on rent">No reserved, delivered or billing rentals for this customer.</Empty></div>
                ) : (
                    <div className="list" style={boxStyle}>
                        {myRentals.map(r => (
                            <Link key={r.id} to={`/rentals?open=${r.id}`} className="list-row">
                                <div className="main">
                                    <div className="title">{r.unit_number} <RentalStatusBadge status={r.status} /></div>
                                    <div className="desc">{r.job_site_name || 'No site'}{!hideMoney && ` · ${pricingLabel(r) || 'No rate set'}`}</div>
                                </div>
                                {!hideMoney && <div className="side"><span className="num" style={{ color: 'var(--text)' }}>{fmtMoney(r.total_due ?? r.accrued_amount)}</span><br />accrued</div>}
                            </Link>
                        ))}
                    </div>
                )}
            </Section>
        </Drawer>
    )
}

function ContactForm({ value, setValue, onSave, onCancel, busy }) {
    const set = (k, v) => setValue(f => ({ ...f, [k]: v }))
    return (
        <div style={value.id ? undefined : formBoxStyle} className="form">
            <div className="form-row">
                <Field label="Name"><input className="input" value={value.name || ''} onChange={e => set('name', e.target.value)} autoFocus placeholder="Jordan Smith" /></Field>
                <Field label="Title"><input className="input" value={value.title || ''} onChange={e => set('title', e.target.value)} placeholder="Project manager" /></Field>
            </div>
            <div className="form-row">
                <Field label="Phone"><input className="input" value={value.phone || ''} onChange={e => set('phone', e.target.value)} placeholder="(555) 123-4567" /></Field>
                <Field label="Email"><input className="input" type="email" value={value.email || ''} onChange={e => set('email', e.target.value)} placeholder="name@company.com" /></Field>
            </div>
            <label className="check">
                <input type="checkbox" checked={!!value.is_primary} onChange={e => set('is_primary', e.target.checked)} />
                Primary contact
            </label>
            <div className="btn-row">
                <button className="btn primary sm" onClick={onSave} disabled={!value.name?.trim() || busy}>{value.id ? 'Save' : 'Add contact'}</button>
                <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    )
}

function InvitePanel({ contact, sites, linked, busy, onInvite, onCancel }) {
    const [picked, setPicked] = useState(() => linked.length ? linked : sites.map(s => s.id))
    const toggle = id => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
    return (
        <div style={{ ...formBoxStyle, marginTop: 10, marginBottom: 0 }} className="form">
            <div style={{ fontSize: 13.5 }}>
                Create a customer portal login for <b>{contact.name}</b> using <span className="mono">{contact.email.toLowerCase()}</span>. They'll only see the sites you pick.
            </div>
            {sites.length === 0 ? (
                <div className="faint" style={{ fontSize: 13 }}>This customer has no sites yet, so they won't see anything until you add one and assign them to it.</div>
            ) : (
                <div style={{ display: 'grid', gap: 6 }}>
                    {sites.map(s => (
                        <label key={s.id} className="check">
                            <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} disabled={linked.includes(s.id)} />
                            {s.name}{linked.includes(s.id) && <span className="faint">(already assigned)</span>}
                        </label>
                    ))}
                </div>
            )}
            <div className="btn-row">
                <button className="btn primary sm" onClick={() => onInvite(picked)} disabled={busy}>{busy ? 'Creating…' : 'Create portal login'}</button>
                <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    )
}
