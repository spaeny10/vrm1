import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core'
import { useApiPolling } from '../hooks/useApiPolling'
import {
    apiGet, apiPut, changePassword, fetchSettings, updateSettings, purgeData, updateSolarScoreSettings,
    fetchJobSites, fetchBoardTrailers, reclusterJobSites, assignTrailer,
    fetchUsers, createUserAccount, updateUserAccount, deleteUserAccount, resetUserPassword,
    fetchCustomerSiteAccess, updateCustomerSiteAccess,
    fetchGpsTrailers, refreshGps, fetchUnlinkedIc2Devices, linkIc2Device,
    fetchDigestPreview, fetchEmailConfigStatus, sendTestEmail,
} from '../api/vrm'
import { useToast } from '../components/ToastProvider'
import { useAuth } from '../components/AuthProvider'
import { useWorkspace } from '../components/WorkspaceProvider'
import {
    Page, Card, Stats, Stat, Dot, Badge, Tabs, Chips, Search, Field, Modal,
    Empty, AllClear, Loading, DataTable, KV, Icon,
} from '../ui'
import { HEALTH, fmtAgo, fmtDate, fmtDateTime, fmtKwh, fmtNum, fmtPct, plural } from '../ui/format'

// ============================================================
// Settings (admins) / Account (everyone else).
// Each concern lives in its own tab; non-admins only get their account
// (plus GPS & devices for staff working in the Fleet workspace).
// ============================================================

const MIN_PASSWORD = 8

const ROLES = {
    admin: { label: 'Admin', tone: 'info', desc: 'Full access, including users and settings' },
    technician: { label: 'Technician', tone: 'plain', desc: 'Staff: can edit trailers, sites, rentals and service' },
    viewer: { label: 'Viewer', tone: 'plain', desc: 'Read-only access to the staff app' },
    customer: { label: 'Customer', tone: 'off', desc: 'Read-only portal, limited to the sites you grant' },
}

export default function Settings() {
    const { user } = useAuth()
    const { workspace } = useWorkspace()
    const isAdmin = user?.role === 'admin'
    // GPS tools are staff work owned by the Fleet Manager; admins always see them.
    const showGps = isAdmin || (user?.role === 'technician' && workspace === 'fleet')

    const tabs = [
        { key: 'account', label: 'Account' },
        ...(isAdmin ? [{ key: 'users', label: 'Users' }, { key: 'notifications', label: 'Notifications' }, { key: 'rules', label: 'Fleet rules' }] : []),
        ...(showGps ? [{ key: 'gps', label: 'GPS & devices' }] : []),
        ...(isAdmin ? [{ key: 'activity', label: 'Activity' }] : []),
    ]

    const [params, setParams] = useSearchParams()
    const requested = params.get('tab')
    const tab = tabs.some(t => t.key === requested) ? requested : 'account'
    const setTab = (key) => setParams(key === 'account' ? {} : { tab: key }, { replace: true })

    return (
        <Page title={isAdmin ? 'Settings' : 'Account'}
            sub={isAdmin ? 'Your account, users, notifications and fleet-wide rules' : 'Your profile and password'}>
            <div>
                {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
                {tab === 'account' && <AccountTab />}
                {tab === 'users' && isAdmin && <UsersTab />}
                {tab === 'notifications' && isAdmin && <NotificationsTab />}
                {tab === 'rules' && isAdmin && <FleetRulesTab />}
                {tab === 'gps' && showGps && <GpsTab isAdmin={isAdmin} />}
                {tab === 'activity' && isAdmin && <ActivityTab />}
            </div>
        </Page>
    )
}

// ------------------------------------------------------------
// Shared bits
// ------------------------------------------------------------
function ConfirmModal({ title, children, confirmLabel, danger, busy, onConfirm, onClose }) {
    return (
        <Modal title={title} onClose={onClose} footer={<>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className={danger ? 'btn danger solid' : 'btn primary'} onClick={onConfirm} disabled={busy}>
                {busy ? 'Working…' : confirmLabel}
            </button>
        </>}>
            <div style={{ display: 'grid', gap: 10 }}>{children}</div>
        </Modal>
    )
}

function passwordProblem(pw, confirm) {
    if (!pw) return null
    if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
    if (confirm != null && confirm && pw !== confirm) return "Passwords don't match."
    return null
}

function fmtBytes(bytes) {
    if (!bytes) return '—'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
    return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`
}

function humanize(s) {
    if (!s) return ''
    const t = String(s).replace(/_/g, ' ').trim()
    return t.charAt(0).toUpperCase() + t.slice(1)
}

// ------------------------------------------------------------
// Account
// ------------------------------------------------------------
function AccountTab() {
    const { user, updateDisplayName, markPasswordChanged } = useAuth()
    const toast = useToast()

    const [name, setName] = useState(user?.display_name || '')
    const [savingName, setSavingName] = useState(false)
    const nameChanged = name.trim() && name.trim() !== (user?.display_name || '')

    const saveName = async (e) => {
        e.preventDefault()
        if (!nameChanged) return
        setSavingName(true)
        try {
            await updateDisplayName(name.trim())
            toast.success('Display name updated')
        } catch (err) {
            toast.error(err.message)
        }
        setSavingName(false)
    }

    const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
    const [savingPw, setSavingPw] = useState(false)
    const pwProblem = passwordProblem(pw.next, pw.confirm)
    const pwReady = pw.current && pw.next && pw.confirm && !pwProblem

    const savePassword = async (e) => {
        e.preventDefault()
        if (!pwReady) return
        setSavingPw(true)
        try {
            await changePassword(pw.current, pw.next)
            markPasswordChanged?.()
            setPw({ current: '', next: '', confirm: '' })
            toast.success('Password changed')
        } catch (err) {
            toast.error(err.message)
        }
        setSavingPw(false)
    }

    return (
        <div className="grid-2">
            <div className="stack">
                <Card title="Profile">
                    <form className="form" onSubmit={saveName}>
                        <KV items={[
                            ['Username', <span className="mono" key="u">{user?.username}</span>],
                            ['Role', <Badge key="r" tone={ROLES[user?.role]?.tone}>{ROLES[user?.role]?.label || user?.role}</Badge>],
                        ]} />
                        <Field label="Display name" hint="Shown in the sidebar, on notes and in the activity log.">
                            <input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={80} />
                        </Field>
                        <div className="btn-row">
                            <button className="btn" type="submit" disabled={!nameChanged || savingName}>{savingName ? 'Saving…' : 'Save name'}</button>
                        </div>
                    </form>
                </Card>
                {user?.role !== 'customer' && <MyDigestCard />}
            </div>

            <Card title="Change password">
                <form className="form" onSubmit={savePassword}>
                    <Field label="Current password">
                        <input className="input" type="password" autoComplete="current-password" value={pw.current}
                            onChange={e => setPw(p => ({ ...p, current: e.target.value }))} />
                    </Field>
                    <Field label="New password" hint={`At least ${MIN_PASSWORD} characters.`}>
                        <input className="input" type="password" autoComplete="new-password" value={pw.next}
                            onChange={e => setPw(p => ({ ...p, next: e.target.value }))} />
                    </Field>
                    <Field label="Confirm new password">
                        <input className="input" type="password" autoComplete="new-password" value={pw.confirm}
                            onChange={e => setPw(p => ({ ...p, confirm: e.target.value }))} />
                    </Field>
                    {pwProblem && <div className="callout warn">{pwProblem}</div>}
                    <div className="btn-row">
                        <button className="btn primary" type="submit" disabled={!pwReady || savingPw}>{savingPw ? 'Changing…' : 'Change password'}</button>
                    </div>
                </form>
            </Card>
        </div>
    )
}

function MyDigestCard() {
    const toast = useToast()
    const [me, setMe] = useState(null)
    const [email, setEmail] = useState('')
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        apiGet('/auth/me').then(d => { setMe(d.user); setEmail(d.user?.email || '') }).catch(() => setMe(null))
    }, [])

    const save = async (updates, message) => {
        setSaving(true)
        try {
            const d = await apiPut('/auth/profile', updates)
            setMe(d.user)
            setEmail(d.user?.email || '')
            toast.success(message)
        } catch (err) {
            toast.error(err.message)
        }
        setSaving(false)
    }

    const emailChanged = email.trim() !== (me?.email || '')

    return (
        <Card title="Morning digest email">
            {!me ? <Loading /> : (
                <div className="form">
                    <Field label="Email address" hint="Where the digest and @mention notifications are sent.">
                        <div style={{ display: 'flex', gap: 8 }}>
                            <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" />
                            <button className="btn" type="button" disabled={!emailChanged || saving}
                                onClick={() => save({ email: email.trim() }, 'Email updated')}>Save</button>
                        </div>
                    </Field>
                    <label className="check">
                        <input type="checkbox" checked={!!me.digest_enabled} disabled={saving || !me.email}
                            onChange={e => save({ digest_enabled: e.target.checked }, e.target.checked ? 'Subscribed to the morning digest' : 'Unsubscribed from the morning digest')} />
                        Send me the morning fleet digest
                    </label>
                    {!me.email && <span className="faint" style={{ fontSize: 12.5 }}>Add an email address first.</span>}
                </div>
            )}
        </Card>
    )
}

// ------------------------------------------------------------
// Users
// ------------------------------------------------------------
function UsersTab() {
    const { user: me } = useAuth()
    const toast = useToast()
    const fetchFn = useCallback(() => fetchUsers(), [])
    const { data, loading, refetch } = useApiPolling(fetchFn, 120000)
    const users = useMemo(() => data?.users || [], [data])

    const [q, setQ] = useState('')
    const [filter, setFilter] = useState('active')
    const [creating, setCreating] = useState(false)
    const [editing, setEditing] = useState(null)
    const [resetting, setResetting] = useState(null)
    const [deleting, setDeleting] = useState(null)
    const [siteAccess, setSiteAccess] = useState(null)
    const [busy, setBusy] = useState(false)

    const counts = useMemo(() => ({
        active: users.filter(u => u.active !== false).length,
        inactive: users.filter(u => u.active === false).length,
        all: users.length,
    }), [users])

    const rows = useMemo(() => {
        const term = q.trim().toLowerCase()
        return users.filter(u => {
            if (filter === 'active' && u.active === false) return false
            if (filter === 'inactive' && u.active !== false) return false
            return !term || [u.username, u.display_name, u.email, u.role].some(v => v && String(v).toLowerCase().includes(term))
        })
    }, [users, q, filter])

    const doDelete = async () => {
        setBusy(true)
        try {
            await deleteUserAccount(deleting.id)
            toast.success(`${deleting.display_name || deleting.username} can no longer sign in`)
            setDeleting(null)
            refetch()
        } catch (err) {
            toast.error(err.message)
        }
        setBusy(false)
    }

    const columns = [
        {
            key: 'name', label: 'User', sort: u => (u.display_name || u.username).toLowerCase(),
            render: u => (
                <div>
                    <span className="primary">{u.display_name || u.username}</span>
                    {u.id === me.id && <span className="faint"> (you)</span>}
                    <div className="sub"><span className="mono">{u.username}</span>{u.google_id ? ' · Google sign-in' : ''}{u.email ? ` · ${u.email}` : ''}</div>
                </div>
            ),
        },
        { key: 'role', label: 'Role', sort: u => u.role, render: u => <Badge tone={ROLES[u.role]?.tone}>{ROLES[u.role]?.label || u.role}</Badge> },
        {
            key: 'active', label: 'Status', sort: u => (u.active === false ? 1 : 0),
            render: u => u.active === false ? <Badge tone="off">Deactivated</Badge> : <Badge tone="ok" dot>Active</Badge>,
        },
        {
            key: 'last_login', label: 'Last sign-in', sort: u => (u.last_login ? Number(u.last_login) : 0),
            render: u => u.last_login ? <span title={fmtDateTime(u.last_login)}>{fmtAgo(u.last_login)}</span> : <span className="faint">Never</span>,
        },
        {
            key: 'digest', label: 'Digest', sort: u => (u.digest_enabled ? 1 : 0),
            render: u => !u.digest_enabled ? <span className="faint">Off</span>
                : u.email ? <Badge tone="ok">On</Badge>
                    : <span title="Subscribed, but no email address on file"><Badge tone="warn">On · no email</Badge></span>,
        },
        {
            key: 'actions', label: '', render: u => (
                <div className="btn-row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                    {u.role === 'customer' && <button className="btn sm" onClick={() => setSiteAccess(u)}>Site access</button>}
                    <button className="btn sm ghost" onClick={() => setEditing(u)}>Edit</button>
                    {!u.google_id && <button className="btn sm ghost" onClick={() => setResetting(u)}>Reset password</button>}
                    {u.id !== me.id && u.active !== false && <button className="btn sm ghost danger" onClick={() => setDeleting(u)}>Delete</button>}
                </div>
            ),
        },
    ]

    return (
        <div>
            <div className="toolbar">
                <Search value={q} onChange={setQ} placeholder="Search name, username, role…" />
                <Chips value={filter} onChange={setFilter} options={[
                    { key: 'active', label: 'Active', count: counts.active },
                    { key: 'inactive', label: 'Deactivated', count: counts.inactive },
                    { key: 'all', label: 'All', count: counts.all },
                ]} />
                <div className="spacer" />
                <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" />Add user</button>
            </div>
            <Card flush foot="Customers only see the job sites you grant under Site access. Digest emails go to subscribed users that have an email address (from Google sign-in).">
                {loading && !data ? <Loading /> : (
                    <DataTable columns={columns} rows={rows} initialSort={{ key: 'name', dir: 'asc' }}
                        empty={<Empty compact title="No users match">Try a different search or filter.</Empty>} />
                )}
            </Card>

            {creating && <CreateUserModal onClose={() => setCreating(false)} onDone={(u) => { setCreating(false); refetch(); if (u?.role === 'customer') setSiteAccess(u) }} />}
            {editing && <EditUserModal target={editing} isSelf={editing.id === me.id} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refetch() }} />}
            {resetting && <ResetPasswordModal target={resetting} onClose={() => setResetting(null)} />}
            {siteAccess && <SiteAccessModal target={siteAccess} onClose={() => setSiteAccess(null)} />}
            {deleting && (
                <ConfirmModal title="Delete user" confirmLabel="Delete user" danger busy={busy} onConfirm={doDelete} onClose={() => setDeleting(null)}>
                    <p>Delete <b>{deleting.display_name || deleting.username}</b> (<span className="mono">{deleting.username}</span>)?</p>
                    <p className="muted">They can no longer sign in. Their past notes and activity stay in the record, and the account moves to the Deactivated list, where you can reactivate it from Edit.</p>
                </ConfirmModal>
            )}
        </div>
    )
}

function RoleSelect({ value, onChange, disabled }) {
    return (
        <Field label="Role" hint={ROLES[value]?.desc}>
            <select className="select" value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
                {Object.entries(ROLES).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}
            </select>
        </Field>
    )
}

function CreateUserModal({ onClose, onDone }) {
    const toast = useToast()
    const [f, setF] = useState({ username: '', display_name: '', role: 'technician', password: '' })
    const [saving, setSaving] = useState(false)
    const problem = passwordProblem(f.password)
    const ready = f.username.trim() && f.password && !problem
    const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }))

    const submit = async (e) => {
        e.preventDefault()
        if (!ready) return
        setSaving(true)
        try {
            const res = await createUserAccount({
                username: f.username.trim(),
                password: f.password,
                display_name: f.display_name.trim() || null,
                role: f.role,
            })
            toast.success(`Created ${res.user?.display_name || f.username.trim()}`)
            onDone(res.user)
        } catch (err) {
            toast.error(err.message)
            setSaving(false)
        }
    }

    return (
        <Modal title="Add user" onClose={onClose} footer={<>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" type="submit" form="create-user" disabled={!ready || saving}>{saving ? 'Creating…' : 'Create user'}</button>
        </>}>
            <form id="create-user" className="form" onSubmit={submit}>
                <div className="form-row" style={{ alignItems: 'start' }}>
                    <Field label="Username">
                        <input className="input" value={f.username} onChange={set('username')} autoFocus autoComplete="off" />
                    </Field>
                    <Field label="Display name" hint="Optional. Defaults to the username.">
                        <input className="input" value={f.display_name} onChange={set('display_name')} />
                    </Field>
                </div>
                <RoleSelect value={f.role} onChange={role => setF(p => ({ ...p, role }))} />
                <Field label="Temporary password" hint={problem || `At least ${MIN_PASSWORD} characters. Share it with them privately.`}>
                    <input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" />
                </Field>
                <div className="callout">
                    <Icon name="alert" size={16} />
                    <span>They'll be asked to choose their own password the first time they sign in.{f.role === 'customer' ? ' After creating, pick which job sites this customer can see.' : ''}</span>
                </div>
            </form>
        </Modal>
    )
}

function EditUserModal({ target, isSelf, onClose, onDone }) {
    const toast = useToast()
    const [f, setF] = useState({
        display_name: target.display_name || '',
        email: target.email || '',
        role: target.role,
        active: target.active !== false,
        digest_enabled: !!target.digest_enabled,
    })
    const [saving, setSaving] = useState(false)

    const submit = async (e) => {
        e.preventDefault()
        const updates = {}
        if (f.display_name.trim() && f.display_name.trim() !== (target.display_name || '')) updates.display_name = f.display_name.trim()
        if (f.email.trim() !== (target.email || '')) updates.email = f.email.trim()
        if (!isSelf && f.role !== target.role) updates.role = f.role
        if (!isSelf && f.active !== (target.active !== false)) updates.active = f.active
        if (f.digest_enabled !== !!target.digest_enabled) updates.digest_enabled = f.digest_enabled
        if (!Object.keys(updates).length) return onClose()
        setSaving(true)
        try {
            await updateUserAccount(target.id, updates)
            toast.success(`Updated ${f.display_name.trim() || target.username}`)
            onDone()
        } catch (err) {
            toast.error(err.message)
            setSaving(false)
        }
    }

    return (
        <Modal title={`Edit ${target.display_name || target.username}`} onClose={onClose} footer={<>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" type="submit" form="edit-user" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
        </>}>
            <form id="edit-user" className="form" onSubmit={submit}>
                <Field label="Display name">
                    <input className="input" value={f.display_name} onChange={e => setF(p => ({ ...p, display_name: e.target.value }))} />
                </Field>
                <Field label="Email">
                    <input className="input" type="email" value={f.email} onChange={e => setF(p => ({ ...p, email: e.target.value }))} placeholder="Used for the digest and @mentions" />
                </Field>
                <RoleSelect value={f.role} onChange={role => setF(p => ({ ...p, role }))} disabled={isSelf} />
                <label className="check">
                    <input type="checkbox" checked={f.active} disabled={isSelf} onChange={e => setF(p => ({ ...p, active: e.target.checked }))} />
                    Account is active (can sign in)
                </label>
                <label className="check">
                    <input type="checkbox" checked={f.digest_enabled} onChange={e => setF(p => ({ ...p, digest_enabled: e.target.checked }))} />
                    Receives the morning digest email
                </label>
                {f.digest_enabled && !f.email.trim() && <div className="callout warn">Add an email address, or the digest has nowhere to go.</div>}
                {isSelf && <span className="faint" style={{ fontSize: 12.5 }}>You can't change your own role or deactivate yourself.</span>}
            </form>
        </Modal>
    )
}

function ResetPasswordModal({ target, onClose }) {
    const toast = useToast()
    const [pw, setPw] = useState('')
    const [saving, setSaving] = useState(false)
    const problem = passwordProblem(pw)

    const submit = async (e) => {
        e.preventDefault()
        if (!pw || problem) return
        setSaving(true)
        try {
            await resetUserPassword(target.id, pw)
            toast.success(`Password reset for ${target.display_name || target.username}`)
            onClose()
        } catch (err) {
            toast.error(err.message)
            setSaving(false)
        }
    }

    return (
        <Modal title="Reset password" onClose={onClose} footer={<>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" type="submit" form="reset-pw" disabled={!pw || !!problem || saving}>{saving ? 'Resetting…' : 'Reset password'}</button>
        </>}>
            <form id="reset-pw" className="form" onSubmit={submit}>
                <p>Set a temporary password for <b>{target.display_name || target.username}</b>.</p>
                <Field label="Temporary password" hint={problem || `At least ${MIN_PASSWORD} characters.`}>
                    <input className="input" type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus autoComplete="new-password" />
                </Field>
                <div className="callout">
                    <Icon name="alert" size={16} />
                    <span>They'll have to choose a new password the next time they sign in.</span>
                </div>
            </form>
        </Modal>
    )
}

function SiteAccessModal({ target, onClose }) {
    const toast = useToast()
    const [sites, setSites] = useState(null)
    const [selected, setSelected] = useState(new Set())
    const [q, setQ] = useState('')
    const [saving, setSaving] = useState(false)
    const [loadError, setLoadError] = useState(null)

    // Load once per customer (not on every parent re-render, which would wipe unsaved ticks)
    useEffect(() => {
        let alive = true
        Promise.all([fetchJobSites(), fetchCustomerSiteAccess(target.id)])
            .then(([js, access]) => {
                if (!alive) return
                const list = (js.job_sites || []).slice().sort((a, b) =>
                    ((a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)) || a.name.localeCompare(b.name, undefined, { numeric: true }))
                setSites(list)
                setSelected(new Set(access.sites || []))
            })
            .catch(err => { if (alive) setLoadError(err.message) })
        return () => { alive = false }
    }, [target.id])

    const shown = useMemo(() => {
        const term = q.trim().toLowerCase()
        return (sites || []).filter(s => !term || [s.name, s.address, s.company_name, String(s.uid || s.id)].some(v => v && String(v).toLowerCase().includes(term)))
    }, [sites, q])

    const toggle = (id) => setSelected(prev => {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
    })

    const save = async () => {
        setSaving(true)
        try {
            await updateCustomerSiteAccess(target.id, [...selected])
            toast.success(`${target.display_name || target.username} can now see ${plural(selected.size, 'site')}`)
            onClose()
        } catch (err) {
            toast.error(err.message)
            setSaving(false)
        }
    }

    return (
        <Modal wide title={`Site access: ${target.display_name || target.username}`} onClose={onClose} footer={<>
            <span className="faint" style={{ marginRight: 'auto', alignSelf: 'center' }}>{selected.size} of {sites?.length ?? 0} selected</span>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={!sites || saving}>{saving ? 'Saving…' : 'Save access'}</button>
        </>}>
            {loadError ? <div className="callout crit">{loadError}</div> : !sites ? <Loading /> : (
                <div style={{ display: 'grid', gap: 12 }}>
                    <p className="muted">This customer sees read-only trailer health for the sites you tick, in their portal.</p>
                    <Search value={q} onChange={setQ} placeholder="Search site, customer, address…" />
                    <div className="card" style={{ maxHeight: 380, overflowY: 'auto' }}>
                        {shown.length === 0 ? <Empty compact>No sites match "{q}".</Empty> : (
                            <div className="list">
                                {shown.map(s => (
                                    <label key={s.id} className="list-row clickable" style={{ padding: '10px 14px' }}>
                                        <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
                                        <div className="main">
                                            <div className="title">
                                                {s.name}
                                                {s.is_headquarters && <Badge tone="info">HQ</Badge>}
                                                {s.status && s.status !== 'active' && <Badge tone="off">{humanize(s.status)}</Badge>}
                                            </div>
                                            <div className="desc">{[s.company_name, s.address].filter(Boolean).join(' · ') || 'No customer or address'}</div>
                                        </div>
                                        <div className="side">{plural(s.trailer_count || 0, 'trailer')}</div>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </Modal>
    )
}

// ------------------------------------------------------------
// Notifications
// ------------------------------------------------------------
const TEST_EMAILS = [
    { type: 'alert', label: 'Energy alert', desc: 'A sample 3-day energy deficit alert' },
    { type: 'digest', label: 'Morning digest', desc: "Today's real digest, sent to the alert recipients" },
    { type: 'geofence', label: 'Geofence breach', desc: 'A sample "trailer left its site" alert' },
]

function NotificationsTab() {
    const toast = useToast()
    const [status, setStatus] = useState(null)
    const [statusError, setStatusError] = useState(null)
    const [sending, setSending] = useState(null)

    useEffect(() => {
        fetchEmailConfigStatus().then(setStatus).catch(err => setStatusError(err.message))
    }, [])

    const sendTest = async (type, label) => {
        setSending(type)
        try {
            const res = await sendTestEmail(type)
            if (res.success) toast.success(`Test ${label.toLowerCase()} email sent to ${(res.recipients || []).join(', ') || 'the alert recipients'}`)
            else toast.error(res.error || 'Test email failed')
        } catch (err) {
            toast.error(err.message)
        }
        setSending(null)
    }

    const cfg = status?.config || {}
    const configured = !!status?.configured

    return (
        <div className="stack">
            <div className="grid-2">
                <Card title="Email delivery">
                    {statusError ? <div className="callout crit">{statusError}</div> : !status ? <Loading /> : (
                        <div style={{ display: 'grid', gap: 14 }}>
                            <div>{configured ? <Badge tone="ok" dot>Email is set up</Badge> : <Badge tone="warn" dot>Email is not set up</Badge>}</div>
                            <KV items={[
                                ['Sends from', cfg.fromEmail],
                                ['Alert recipients', cfg.recipientCount ? (cfg.recipients || []).join(', ') : <span className="faint">None</span>],
                                ['SendGrid key', cfg.hasApiKey ? 'Present' : <span className="faint">Missing</span>],
                            ]} />
                            {!configured && (
                                <p className="faint" style={{ fontSize: 12.5 }}>
                                    Email is configured on the server (SENDGRID_API_KEY, ALERT_FROM_EMAIL, ALERT_EMAIL_RECIPIENTS). Until then, alerts and digests aren't sent.
                                </p>
                            )}
                        </div>
                    )}
                </Card>
                <Card title="Send a test email">
                    <div className="list" style={{ margin: '-16px -18px' }}>
                        {TEST_EMAILS.map(t => (
                            <div key={t.type} className="list-row">
                                <div className="main">
                                    <div className="title">{t.label}</div>
                                    <div className="desc">{t.desc}</div>
                                </div>
                                <button className="btn sm" disabled={!configured || sending != null} onClick={() => sendTest(t.type, t.label)}>
                                    {sending === t.type ? 'Sending…' : 'Send test'}
                                </button>
                            </div>
                        ))}
                    </div>
                </Card>
            </div>
            <DigestPreview />
        </div>
    )
}

const signalWord = (dbm) => (dbm == null || dbm === 0) ? null : dbm >= -90 ? 'good' : dbm >= -105 ? 'fair' : 'poor'

function describeItem(item) {
    if (item.type === 'low_soc') return `${item.severity === 'critical' ? 'Battery critical' : 'Battery low'}: ${fmtPct(item.soc)}`
    if (item.type === 'alarm') return `Alarm: ${item.message}`
    if (item.type === 'energy_deficit') return `Using more energy than it makes, ${plural(item.streak_days, 'day')} running${item.has_throttled ? ' (some days throttled)' : ''}`
    return humanize(item.type)
}

function DigestPreview() {
    const [digest, setDigest] = useState(null)
    const [error, setError] = useState(null)
    const [loading, setLoading] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const res = await fetchDigestPreview()
            setDigest(res.digest)
        } catch (err) {
            setError(err.message)
        }
        setLoading(false)
    }, [])

    useEffect(() => { load() }, [load])

    const d = digest
    const y = d?.yesterday || {}
    const cur = d?.current || {}
    const net = d?.network || {}
    const reported = (y.trailers_reporting || 0) > 0

    return (
        <Card title="Morning digest preview" meta={d ? 'what the email would say right now' : null}
            actions={<button className="btn sm ghost" onClick={load} disabled={loading}><Icon name="refresh" />{loading ? 'Loading…' : 'Refresh'}</button>}>
            {error ? <div className="callout crit">{error}</div> : !d ? <Loading /> : (
                <div className="stack">
                    <Stats>
                        <Stat label="Deployed trailers" value={d.fleet_size ?? '—'}
                            hint={d.fleet_breakdown ? `${d.fleet_breakdown.vrm} with Victron · ${d.fleet_breakdown.ic2_only} router-only` : null} />
                        <Stat label="Reporting now" value={cur.online ?? '—'} unit={cur.total != null ? `/ ${cur.total}` : null} />
                        <Stat label="Average battery now" value={cur.online ? fmtPct(cur.avg_soc) : '—'} />
                        <Stat label="Solar yesterday" value={reported ? fmtNum(y.total_yield_kwh, 1) : '—'} unit={reported ? 'kWh' : null}
                            hint={reported ? `${plural(y.trailers_reporting, 'trailer')} reporting` : 'No data for yesterday'} />
                    </Stats>

                    <div className="grid-2">
                        <DigestList title="Dispatch now" tone="crit" items={d.critical_items || []} empty="Nothing critical." />
                        <DigestList title="Watch" tone="warn" items={d.watch_items || []} empty="Nothing on the watch list." />
                    </div>

                    <div className="grid-3">
                        <Card title="Yesterday">
                            <KV items={[
                                ['Avg battery at end of day', reported ? fmtPct(y.avg_eod_soc) : '—'],
                                ['Solar produced', reported ? fmtKwh(y.total_yield_kwh) : '—'],
                                ['Cellular data used', y.total_data_gb ? `${fmtNum(y.total_data_gb, 1)} GB` : '—'],
                                ['Trailers reporting', fmtNum(y.trailers_reporting)],
                            ]} />
                        </Card>
                        <Card title="Solar vs forecast (yesterday)">
                            {!(d.top_performers?.length || d.underperformers?.length) ? <span className="faint">No forecast comparison for yesterday.</span> : (
                                <div style={{ display: 'grid', gap: 12 }}>
                                    {d.underperformers?.length > 0 && <PerfList label="Under 70% of forecast" tone="warn" rows={d.underperformers} />}
                                    {d.top_performers?.length > 0 && <PerfList label="Beat forecast" tone="ok" rows={d.top_performers} />}
                                </div>
                            )}
                        </Card>
                        <Card title="Network (yesterday)">
                            <KV items={[
                                ['Average signal', net.avg_signal_dbm ? `${fmtNum(net.avg_signal_dbm)} dBm (${signalWord(net.avg_signal_dbm)})` : '—'],
                                ['Data used', net.total_data_gb ? `${fmtNum(net.total_data_gb, 1)} GB` : '—'],
                            ]} />
                            {net.high_usage?.length > 0 && (
                                <div style={{ marginTop: 12 }}>
                                    <div className="faint" style={{ fontSize: 12.5, marginBottom: 6 }}>Heavy data users (over 0.5 GB)</div>
                                    <KV items={net.high_usage.map(h => [h.device, `${fmtNum(h.usage_gb, 1)} GB`])} />
                                </div>
                            )}
                        </Card>
                    </div>
                </div>
            )}
        </Card>
    )
}

function DigestList({ title, tone, items, empty }) {
    return (
        <Card title={title} meta={items.length || null} flush>
            {items.length === 0 ? <AllClear>{empty}</AllClear> : (
                <div className="list">
                    {items.map((it, i) => (
                        <div key={i} className="list-row">
                            <Dot tone={tone} />
                            <div className="main">
                                <div className="title">{it.trailer}</div>
                                <div className="desc">{describeItem(it)}</div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </Card>
    )
}

function PerfList({ label, tone, rows }) {
    return (
        <div>
            <div className="faint" style={{ fontSize: 12.5, marginBottom: 6 }}>{label}</div>
            <KV items={rows.map(p => [p.site_name, <span key="v"><Badge tone={tone}>{fmtPct(p.percent)}</Badge> <span className="faint">{fmtKwh(p.yield_kwh)}</span></span>])} />
        </div>
    )
}

// ------------------------------------------------------------
// Fleet rules
// ------------------------------------------------------------
const SCORE_FIELDS = [
    { group: 'When the battery is full', key: 'throttle_soc_threshold', label: 'Treat solar as throttled above', unit: '% battery', desc: 'A full battery makes the charger hold back solar. Above this charge, low output is not counted as a panel problem.' },
    { group: 'When the battery is full', key: 'throttle_floor_soc', label: 'Guarantee a minimum score above', unit: '% battery', desc: 'Trailers this full get at least the minimum score below.' },
    { group: 'When the battery is full', key: 'throttle_floor_score', label: 'Minimum score for a full battery', unit: 'score', desc: 'The lowest solar score a full, throttled trailer can get.' },
    { group: 'When the battery is full', key: 'throttle_panel_min_pct', label: 'Panels count as healthy above', unit: '% of rated', desc: 'While throttled, panels producing at least this much are treated as working.' },
    { group: 'Score ratings', key: 'score_excellent', label: 'Excellent at or above', unit: 'score' },
    { group: 'Score ratings', key: 'score_good', label: 'Good at or above', unit: 'score' },
    { group: 'Score ratings', key: 'score_fair', label: 'Fair at or above', unit: 'score', desc: 'Anything lower is rated Poor.' },
]
const RETENTION_OPTIONS = [7, 30, 90, 180, 365]

function FleetRulesTab() {
    const toast = useToast()
    const fetchFn = useCallback(() => fetchSettings(), [])
    const { data, loading, refetch } = useApiPolling(fetchFn, 120000)
    const saved = data?.solar_score_config

    const [config, setConfig] = useState(null)
    useEffect(() => { if (saved && !config) setConfig(saved) }, [saved, config])
    const [savingScore, setSavingScore] = useState(false)

    const dirtyScore = config && saved && SCORE_FIELDS.some(f => Number(config[f.key]) !== Number(saved[f.key]))
    const invalid = config && SCORE_FIELDS.find(f => {
        const v = Number(config[f.key])
        return config[f.key] === '' || isNaN(v) || v < 0 || v > 100
    })
    const orderProblem = config && !(Number(config.score_excellent) > Number(config.score_good) && Number(config.score_good) > Number(config.score_fair))
        ? 'Ratings should go Excellent > Good > Fair.' : null

    const saveScore = async () => {
        setSavingScore(true)
        try {
            const body = Object.fromEntries(SCORE_FIELDS.map(f => [f.key, Number(config[f.key])]))
            const res = await updateSolarScoreSettings(body)
            if (res.success === false) throw new Error(res.error || 'Not saved')
            if (res.solar_score_config) setConfig(res.solar_score_config)
            toast.success('Solar scoring updated')
            refetch()
        } catch (err) {
            toast.error(err.message)
        }
        setSavingScore(false)
    }

    const [retention, setRetention] = useState(null)
    const shownRetention = retention ?? data?.retention_days ?? 90
    const [savingRet, setSavingRet] = useState(false)
    const [confirmPurge, setConfirmPurge] = useState(false)
    const [purging, setPurging] = useState(false)

    const saveRetention = async () => {
        setSavingRet(true)
        try {
            const res = await updateSettings({ retention_days: shownRetention })
            if (res.success === false) throw new Error(res.error || 'Not saved')
            toast.success(`History is now kept for ${shownRetention} days`)
            setRetention(null)
            refetch()
        } catch (err) {
            toast.error(err.message)
        }
        setSavingRet(false)
    }

    const purge = async () => {
        setPurging(true)
        try {
            const res = await purgeData()
            if (res.success === false) throw new Error(res.error || 'Purge failed')
            toast.success(`Old data removed. ${fmtNum(res.snapshot_count)} snapshots remain (${fmtBytes(res.db_size_bytes)}).`)
            setConfirmPurge(false)
            refetch()
        } catch (err) {
            toast.error(err.message)
        }
        setPurging(false)
    }

    if (loading && !data) return <Loading />
    const groups = [...new Set(SCORE_FIELDS.map(f => f.group))]

    return (
        <div className="grid-main">
            <Card title="Solar score"
                foot="The solar score compares each trailer's solar output with its forecast. These rules keep full batteries from looking like dirty or broken panels.">
                {!config ? <Loading /> : (
                    <div className="form">
                        {groups.map(g => (
                            <div key={g} style={{ display: 'grid', gap: 12 }}>
                                <div className="faint" style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>{g}</div>
                                {SCORE_FIELDS.filter(f => f.group === g).map(f => (
                                    <div key={f.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 150px', gap: 16, alignItems: 'center' }}>
                                        <div>
                                            <div style={{ fontWeight: 550 }}>{f.label}</div>
                                            {f.desc && <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>{f.desc}</div>}
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <input className="input num" type="number" min={0} max={100} step={1} style={{ width: 76 }}
                                                value={config[f.key] ?? ''} onChange={e => setConfig(c => ({ ...c, [f.key]: e.target.value }))} />
                                            <span className="faint" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{f.unit}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ))}
                        {invalid && <div className="callout warn">"{invalid.label}" must be a number from 0 to 100.</div>}
                        {!invalid && orderProblem && <div className="callout warn">{orderProblem}</div>}
                        <div className="btn-row">
                            <button className="btn primary" onClick={saveScore} disabled={!dirtyScore || !!invalid || !!orderProblem || savingScore}>
                                {savingScore ? 'Saving…' : 'Save scoring'}
                            </button>
                            {dirtyScore && <button className="btn ghost" onClick={() => setConfig(saved)}>Discard changes</button>}
                        </div>
                    </div>
                )}
            </Card>

            <Card title="Data retention">
                <div style={{ display: 'grid', gap: 16 }}>
                    <KV items={[
                        ['Database size', fmtBytes(data?.db_size_bytes)],
                        ['Telemetry snapshots', fmtNum(data?.snapshot_count)],
                        ['Currently keeping', data?.retention_days ? `${data.retention_days} days` : '—'],
                    ]} />
                    <Field label="Keep telemetry history for">
                        <select className="select" value={shownRetention} onChange={e => setRetention(Number(e.target.value))}>
                            {[...new Set([...RETENTION_OPTIONS, shownRetention])].sort((a, b) => a - b).map(d => (
                                <option key={d} value={d}>{d === 365 ? '1 year (365 days)' : `${d} days`}</option>
                            ))}
                        </select>
                    </Field>
                    <p className="faint" style={{ fontSize: 12.5 }}>Older telemetry is removed automatically. Rentals, notes and billing records are not affected.</p>
                    <div className="btn-row">
                        <button className="btn" onClick={saveRetention} disabled={savingRet || shownRetention === data?.retention_days}>{savingRet ? 'Saving…' : 'Save'}</button>
                        <button className="btn danger" onClick={() => setConfirmPurge(true)}>Purge old data now</button>
                    </div>
                </div>
            </Card>

            {confirmPurge && (
                <ConfirmModal title="Purge old data" confirmLabel="Purge now" danger busy={purging} onConfirm={purge} onClose={() => setConfirmPurge(false)}>
                    <p>Permanently delete telemetry older than <b>{data?.retention_days} days</b>?</p>
                    <p className="muted">This can't be undone. Charts and reports will no longer show anything older than that.</p>
                </ConfirmModal>
            )}
        </div>
    )
}

// ------------------------------------------------------------
// GPS & devices
// ------------------------------------------------------------
function GpsTab({ isAdmin }) {
    const toast = useToast()
    const boardFn = useCallback(() => fetchBoardTrailers(), [])
    const sitesFn = useCallback(() => fetchJobSites(), [])
    const board = useApiPolling(boardFn, 60000)
    const sites = useApiPolling(sitesFn, 120000)
    const [confirmPlace, setConfirmPlace] = useState(false)
    const [placing, setPlacing] = useState(false)

    const trailers = useMemo(() => (board.data?.trailers || []).filter(t => t.site_id != null), [board.data])
    const unassigned = trailers.filter(t => !t.site)

    const place = async () => {
        setPlacing(true)
        try {
            const r = await reclusterJobSites()
            if (r.success === false) throw new Error(r.error || 'Placement failed')
            if (!r.trailers) toast.info('Every trailer with GPS already has a site. Nothing to place.')
            else toast.success(`Placed ${plural(r.trailers, 'trailer')} at ${plural(r.jobSites, 'site')} (${r.created} new, ${r.updated} existing)`)
            setConfirmPlace(false)
            board.refetch()
            sites.refetch()
        } catch (err) {
            toast.error(err.message)
        }
        setPlacing(false)
    }

    return (
        <div className="stack">
            <div className="callout">
                <Icon name="pin" size={16} />
                <span>
                    Site settings (name, customer, HQ and geofence) are in each site's <b>Edit site</b> dialog: open it from <Link className="link" to="/sites">Sites</Link>.
                    GPS change approvals are on <Link className="link" to="/">Fleet Home</Link>.
                </span>
            </div>

            <Card title="Place unassigned trailers" meta={board.data ? plural(unassigned.length, 'trailer') + ' without a site' : null}
                actions={isAdmin ? <button className="btn sm" onClick={() => setConfirmPlace(true)} disabled={!board.data}>Place unassigned trailers</button> : null}>
                <p className="muted">
                    Groups trailers that have no site by GPS (within 300 m of each other) and puts them at a matching site, creating one if needed.
                    It only touches trailers without a site. Trailers already at a site, including ones you moved by hand, stay where they are.
                    {!isAdmin && ' Ask an admin to run it.'}
                </p>
            </Card>

            <TrailerBoard trailers={trailers} jobSites={sites.data?.job_sites} loading={board.loading && !board.data} onMoved={() => { board.refetch(); sites.refetch() }} />

            <GpsCheck />

            {confirmPlace && (
                <ConfirmModal title="Place unassigned trailers" confirmLabel="Place trailers" busy={placing} onConfirm={place} onClose={() => setConfirmPlace(false)}>
                    <p>{unassigned.length ? `${plural(unassigned.length, 'trailer')} currently ${unassigned.length === 1 ? 'has' : 'have'} no site.` : 'No trailers appear to be without a site right now.'}</p>
                    <p className="muted">Trailers with GPS will be grouped and placed at the nearest matching site; new sites are created for clusters with no site nearby. Trailers that already have a site are not moved.</p>
                </ConfirmModal>
            )}
        </div>
    )
}

const chipStyle = {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px', borderRadius: 999,
    border: '1px solid var(--border-strong)', background: 'var(--surface)', fontSize: 12.5, fontWeight: 550,
    whiteSpace: 'nowrap', userSelect: 'none', touchAction: 'none',
}

function ChipBody({ t }) {
    return (
        <>
            <Dot tone={HEALTH[t.health]?.tone || 'off'} />
            {t.unit}
            {t.soc != null && <span className="faint num">{Math.round(t.soc)}%</span>}
        </>
    )
}

function TrailerChip({ t, from, disabled }) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: `t:${t.site_id}`, data: { siteId: t.site_id, from, t }, disabled,
    })
    return (
        <span ref={setNodeRef} {...listeners} {...attributes}
            title={`${t.unit}: ${HEALTH[t.health]?.label || 'Unknown'}${t.diagnosis ? ` · ${t.diagnosis}` : ''}`}
            style={{ ...chipStyle, cursor: disabled ? 'default' : 'grab', opacity: isDragging ? 0.35 : 1 }}>
            <ChipBody t={t} />
        </span>
    )
}

function SiteLane({ site, trailers, activeFrom, droppable = true }) {
    const { setNodeRef, isOver } = useDroppable({ id: `s:${site.id}`, disabled: !droppable })
    const highlight = droppable && isOver && activeFrom !== site.id
    return (
        <div ref={setNodeRef} style={{
            border: `1px ${droppable ? 'solid' : 'dashed'} ${highlight ? 'var(--accent)' : 'var(--border-strong)'}`,
            background: highlight ? 'var(--accent-soft)' : 'var(--surface-2)',
            borderRadius: 'var(--radius-sm)', padding: 12, minHeight: 92, display: 'grid', alignContent: 'start', gap: 10,
            transition: 'background .1s, border-color .1s',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={site.name}>{site.name}</span>
                {site.is_headquarters && <Badge tone="info">HQ</Badge>}
                <span className="faint num" style={{ marginLeft: 'auto', fontSize: 12.5 }}>{trailers.length}</span>
            </div>
            {site.company_name && <div className="faint" style={{ fontSize: 12, marginTop: -6 }}>{site.company_name}</div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {trailers.length === 0
                    ? <span className="faint" style={{ fontSize: 12.5 }}>{droppable ? 'Drop a trailer here' : 'None'}</span>
                    : trailers.map(t => <TrailerChip key={t.site_id} t={t} from={site.id} />)}
            </div>
        </div>
    )
}

function TrailerBoard({ trailers, jobSites, loading, onMoved }) {
    const toast = useToast()
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
    const [active, setActive] = useState(null)
    const [moves, setMoves] = useState({}) // optimistic: trailer site_id -> job site id
    const [q, setQ] = useState('')

    const siteOf = useCallback((t) => (moves[t.site_id] !== undefined ? moves[t.site_id] : t.site?.id ?? null), [moves])

    const lanes = useMemo(() => {
        if (!jobSites) return []
        const term = q.trim().toLowerCase()
        const byId = new Map()
        for (const t of trailers) {
            const sid = siteOf(t)
            if (!byId.has(sid)) byId.set(sid, [])
            byId.get(sid).push(t)
        }
        for (const list of byId.values()) list.sort((a, b) => String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true }))
        return jobSites
            .filter(js => js.status === 'active' || js.is_headquarters || byId.has(js.id))
            .map(js => {
                const all = byId.get(js.id) || []
                const siteMatch = !term || js.name.toLowerCase().includes(term) || (js.company_name || '').toLowerCase().includes(term)
                return { site: js, trailers: siteMatch ? all : all.filter(t => String(t.unit).toLowerCase().includes(term)), siteMatch }
            })
            .filter(l => !term || l.siteMatch || l.trailers.length)
            .sort((a, b) => (b.site.is_headquarters ? 1 : 0) - (a.site.is_headquarters ? 1 : 0) || a.site.name.localeCompare(b.site.name, undefined, { numeric: true }))
    }, [jobSites, trailers, siteOf, q])

    const unassigned = useMemo(() => {
        const term = q.trim().toLowerCase()
        return trailers.filter(t => siteOf(t) == null && (!term || String(t.unit).toLowerCase().includes(term)))
    }, [trailers, siteOf, q])

    const onDragEnd = async ({ active: a, over }) => {
        setActive(null)
        if (!over) return
        const to = Number(String(over.id).slice(2))
        const { siteId, from, t } = a.data.current
        if (to === from) return
        const dest = jobSites.find(js => js.id === to)
        setMoves(m => ({ ...m, [siteId]: to }))
        try {
            await assignTrailer(to, siteId)
            toast.success(`${t.unit} moved to ${dest?.name || 'the new site'}`)
            await onMoved()
        } catch (err) {
            toast.error(`Couldn't move ${t.unit}: ${err.message}`)
        }
        setMoves(m => { const n = { ...m }; delete n[siteId]; return n })
    }

    return (
        <Card title="Trailer board" meta={canEdit ? 'drag a trailer onto another site to reassign it' : null}
            actions={<Search value={q} onChange={setQ} placeholder="Find site or trailer…" />}>
            {loading || !jobSites ? <Loading /> : lanes.length === 0 && unassigned.length === 0 ? (
                <Empty compact title="Nothing matches">Try a different search.</Empty>
            ) : (
                <DndContext sensors={sensors} onDragStart={e => setActive(e.active.data.current)} onDragCancel={() => setActive(null)} onDragEnd={onDragEnd}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 }}>
                        {unassigned.length > 0 && (
                            <SiteLane site={{ id: 'none', name: 'No site yet' }} trailers={unassigned} activeFrom={active?.from} droppable={false} />
                        )}
                        {lanes.map(l => <SiteLane key={l.site.id} site={l.site} trailers={l.trailers} activeFrom={active?.from} />)}
                    </div>
                    <DragOverlay>
                        {active ? <span style={{ ...chipStyle, cursor: 'grabbing', boxShadow: 'var(--shadow)', borderColor: 'var(--accent)' }}><ChipBody t={active.t} /></span> : null}
                    </DragOverlay>
                </DndContext>
            )}
        </Card>
    )
}

const GPS_STATUS = {
    mismatch: { tone: 'crit', label: 'Position mismatch', rank: 0 },
    none: { tone: 'warn', label: 'No GPS', rank: 1 },
    db_only: { tone: 'warn', label: 'No router GPS', rank: 2 },
    ic2_only: { tone: 'info', label: 'Not saved yet', rank: 3 },
    ok: { tone: 'ok', label: 'Matches', rank: 4 },
}

function metersBetween(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = Math.PI / 180
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
}

const fmtDistance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)
const fmtCoord = (lat, lon) => (lat != null && lon != null ? `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}` : null)

function GpsCheck() {
    const toast = useToast()
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const [rows, setRows] = useState(null)
    const [devices, setDevices] = useState([])
    const [filter, setFilter] = useState(null)
    const [refreshing, setRefreshing] = useState(false)
    const [linking, setLinking] = useState(null)

    const load = useCallback(async () => {
        try {
            const [g, d] = await Promise.all([fetchGpsTrailers(), fetchUnlinkedIc2Devices()])
            const list = (g.trailers || []).map(t => {
                const hasDb = t.db_latitude != null && t.db_longitude != null
                const hasIc2 = t.ic2_latitude != null && t.ic2_longitude != null
                const dist = hasDb && hasIc2 ? metersBetween(t.db_latitude, t.db_longitude, t.ic2_latitude, t.ic2_longitude) : null
                const status = !hasDb && !hasIc2 ? 'none' : !hasIc2 ? 'db_only' : !hasDb ? 'ic2_only' : dist > 150 ? 'mismatch' : 'ok'
                return { ...t, status, dist }
            })
            setRows(list)
            setDevices(d.devices || [])
        } catch (err) {
            toast.error(err.message)
            setRows(r => r || [])
        }
    }, [toast])

    useEffect(() => { load() }, [load])

    const refresh = async () => {
        setRefreshing(true)
        try {
            const r = await refreshGps()
            if (r.success === false) throw new Error(r.error || 'Refresh failed')
            toast.success(`GPS refreshed: ${r.updated} of ${r.total_gps_devices} routers updated${r.failed ? `, ${r.failed} failed` : ''}`)
            await load()
        } catch (err) {
            toast.error(`GPS refresh failed: ${err.message}`)
        }
        setRefreshing(false)
    }

    const issues = (rows || []).filter(r => r.status !== 'ok')
    const noRouter = (rows || []).filter(r => !r.ic2_device_id)
    const shownFilter = filter ?? 'issues'
    const shown = shownFilter === 'issues' ? issues : shownFilter === 'norouter' ? noRouter : (rows || [])

    const columns = [
        {
            key: 'name', label: 'Trailer', sort: r => r.site_name,
            render: r => (
                <div>
                    {r.site_id > 0 ? <Link className="primary" to={`/trailer/${r.site_id}`}>{r.site_name}</Link> : <span className="primary">{r.site_name}</span>}
                    <div className="sub">{r.ic2_online ? 'Router online' : 'Router offline'}{r.manual_override ? ' · placed by hand' : ''}</div>
                </div>
            ),
        },
        {
            key: 'router', label: 'Router', sort: r => (r.ic2_device_id ? 1 : 0),
            render: r => r.ic2_device_id ? <span className="mono">#{r.ic2_device_id}</span>
                : canEdit ? <button className="btn sm" onClick={() => setLinking(r)}>Link router</button>
                    : <span className="faint">Not linked</span>,
        },
        { key: 'db', label: 'Saved position', render: r => fmtCoord(r.db_latitude, r.db_longitude) ? <span className="mono">{fmtCoord(r.db_latitude, r.db_longitude)}</span> : <span className="faint">—</span> },
        { key: 'ic2', label: 'Router GPS', render: r => fmtCoord(r.ic2_latitude, r.ic2_longitude) ? <span className="mono">{fmtCoord(r.ic2_latitude, r.ic2_longitude)}</span> : <span className="faint">—</span> },
        {
            key: 'status', label: 'Status', sort: r => GPS_STATUS[r.status].rank,
            render: r => (
                <div>
                    <Badge tone={GPS_STATUS[r.status].tone}>{GPS_STATUS[r.status].label}</Badge>
                    {r.status === 'mismatch' && <div className="sub" style={{ marginTop: 3 }}>{fmtDistance(r.dist)} apart</div>}
                </div>
            ),
        },
    ]

    return (
        <Card title="GPS check" meta={rows ? `${plural(rows.length, 'trailer')} · ${issues.length} to review` : null} flush
            actions={canEdit ? <button className="btn sm" onClick={refresh} disabled={refreshing}><Icon name="refresh" />{refreshing ? 'Refreshing…' : 'Refresh GPS'}</button> : null}
            foot="Compares each trailer's saved position with live GPS from its Peplink router. Refresh GPS pulls fresh positions from every router and places any trailer that has no site.">
            {!rows ? <Loading /> : (
                <>
                    <div className="toolbar" style={{ padding: '14px 18px 0' }}>
                        <Chips value={shownFilter} onChange={setFilter} options={[
                            { key: 'issues', label: 'Needs review', dot: issues.length ? 'warn' : null, count: issues.length },
                            { key: 'norouter', label: 'No router linked', count: noRouter.length },
                            { key: 'all', label: 'All', count: rows.length },
                        ]} />
                        <div className="spacer" />
                        <span className="faint" style={{ fontSize: 12.5 }}>{plural(devices.length, 'router')} not linked to a trailer</span>
                    </div>
                    <DataTable columns={columns} rows={shown} rowKey="site_id" initialSort={{ key: 'status', dir: 'asc' }}
                        empty={shownFilter === 'issues' ? <AllClear>All {rows.length} trailers' saved positions match their routers.</AllClear>
                            : shownFilter === 'norouter' ? <AllClear>Every trailer has a router linked.</AllClear> : <Empty compact>No trailers yet.</Empty>} />
                </>
            )}
            {linking && <LinkRouterModal trailer={linking} devices={devices} onClose={() => setLinking(null)} onDone={() => { setLinking(null); load() }} />}
        </Card>
    )
}

function LinkRouterModal({ trailer, devices, onClose, onDone }) {
    const toast = useToast()
    const [deviceId, setDeviceId] = useState('')
    const [saving, setSaving] = useState(false)
    const sorted = useMemo(() => [...devices].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })), [devices])

    const save = async () => {
        setSaving(true)
        try {
            await linkIc2Device(trailer.site_id, Number(deviceId))
            const dev = devices.find(d => String(d.id) === String(deviceId))
            toast.success(`${trailer.site_name} linked to router ${dev?.name || '#' + deviceId}`)
            onDone()
        } catch (err) {
            toast.error(err.message)
            setSaving(false)
        }
    }

    return (
        <Modal title={`Link a router to ${trailer.site_name}`} onClose={onClose} footer={<>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={!deviceId || saving}>{saving ? 'Linking…' : 'Link router'}</button>
        </>}>
            {sorted.length === 0 ? (
                <Empty compact title="No unlinked routers">Every router reporting to InControl is already linked to a trailer.</Empty>
            ) : (
                <div className="form">
                    <Field label="Peplink router" hint="Only routers not yet linked to a trailer are listed. The trailer's GPS and signal will come from this router.">
                        <select className="select" value={deviceId} onChange={e => setDeviceId(e.target.value)} autoFocus>
                            <option value="">Choose a router…</option>
                            {sorted.map(d => <option key={d.id} value={d.id}>{d.name}{d.sn ? ` · ${d.sn}` : ''}{d.online ? '' : ' (offline)'}</option>)}
                        </select>
                    </Field>
                </div>
            )}
        </Modal>
    )
}

// ------------------------------------------------------------
// Activity (audit log)
// ------------------------------------------------------------
const ENTITY_TYPES = [
    { key: '', label: 'All' },
    { key: 'rental', label: 'Rentals' },
    { key: 'site', label: 'Sites' },
    { key: 'trailer', label: 'Trailers' },
    { key: 'company', label: 'Customers' },
    { key: 'contact', label: 'Contacts' },
    { key: 'gps_suggestion', label: 'GPS changes' },
]
const ENTITY_LABEL = { rental: 'Rental', site: 'Site', trailer: 'Trailer', company: 'Customer', contact: 'Contact', gps_suggestion: 'GPS change' }
const PAGE_SIZE = 50

function entityLink(e) {
    if (e.entity_type === 'site' && e.entity_id) return `/site/${e.entity_id}`
    if (e.entity_type === 'rental') return '/rentals'
    if (e.entity_type === 'company') return '/customers'
    if (e.entity_type === 'trailer') return '/trailers'
    return null
}

function actionLabel(action, type) {
    let a = String(action || '')
    const prefix = type === 'company' ? 'company_' : `${type}_`
    if (a.startsWith(prefix)) a = a.slice(prefix.length)
    return humanize(a)
}

function describeDetails(raw) {
    let d = raw
    if (typeof d === 'string') { try { d = JSON.parse(d) } catch { return d } }
    if (!d || typeof d !== 'object') return ''
    const parts = []
    for (const [k, v] of Object.entries(d)) {
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue
        if (k === 'fields' && Array.isArray(v)) parts.push(`Changed ${v.map(f => humanize(f).toLowerCase()).join(', ')}`)
        else if (k === 'name' || k === 'trailer' || k === 'site_name') parts.push(String(v))
        else if (k === 'note_id' || k === 'sid') continue
        else if (k === 'job_site_id' || k === 'target_job_site_id') parts.push(`Site #${v}`)
        else if (k === 'date') parts.push(fmtDate(v))
        else if (Array.isArray(v)) parts.push(`${humanize(k)}: ${v.map(x => (x && typeof x === 'object') ? (x.label || x.name || x.value || '') : x).filter(Boolean).join(', ')}`)
        else if (typeof v === 'object') parts.push(`${humanize(k)}: ${Object.entries(v).map(([a, b]) => `${humanize(a).toLowerCase()} ${b}`).join(', ')}`)
        else parts.push(`${humanize(k)}: ${v}`)
    }
    return parts.join(' · ')
}

function ActivityTab() {
    const toast = useToast()
    const [type, setType] = useState('')
    const [q, setQ] = useState('')
    const [page, setPage] = useState(0)
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        let alive = true
        setLoading(true)
        const p = new URLSearchParams({ limit: PAGE_SIZE, offset: page * PAGE_SIZE })
        if (type) p.set('entity_type', type)
        apiGet(`/audit-log?${p}`)
            .then(d => { if (alive) setData(d) })
            .catch(err => { if (alive) { toast.error(err.message); setData({ entries: [], total: 0 }) } })
            .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
    }, [type, page, toast])

    const entries = useMemo(() => {
        const list = (data?.entries || []).map(e => ({ ...e, summary: describeDetails(e.details) }))
        const term = q.trim().toLowerCase()
        return term ? list.filter(e => [e.actor, e.action, e.summary, ENTITY_LABEL[e.entity_type]].some(v => v && String(v).toLowerCase().includes(term))) : list
    }, [data, q])

    const total = data?.total || 0
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

    const columns = [
        { key: 'time', label: 'When', width: 150, render: e => <div><span>{fmtDateTime(e.created_at)}</span><div className="sub">{fmtAgo(e.created_at)}</div></div> },
        { key: 'actor', label: 'Who', render: e => e.actor && e.actor !== 'system' ? <span className="primary">{e.actor}</span> : <span className="faint">System</span> },
        {
            key: 'entity', label: 'What', render: e => {
                const to = entityLink(e)
                const label = `${ENTITY_LABEL[e.entity_type] || humanize(e.entity_type)}${e.entity_id ? ` #${e.entity_id}` : ''}`
                return to ? <Link className="link" to={to}>{label}</Link> : <span>{label}</span>
            },
        },
        { key: 'action', label: 'Action', render: e => actionLabel(e.action, e.entity_type) },
        { key: 'details', label: 'Details', render: e => e.summary ? <span className="muted">{e.summary}</span> : <span className="faint">—</span> },
    ]

    return (
        <div>
            <div className="toolbar">
                <Search value={q} onChange={setQ} placeholder="Search person, action, details…" />
                <Chips value={type} onChange={t => { setType(t); setPage(0) }} options={ENTITY_TYPES} />
            </div>
            <Card flush
                foot={total > PAGE_SIZE ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span>Page {page + 1} of {pages} · {fmtNum(total)} entries{q ? ' (search applies to this page)' : ''}</span>
                        <div className="spacer" />
                        <button className="btn sm" disabled={page === 0 || loading} onClick={() => setPage(p => p - 1)}><Icon name="back" />Newer</button>
                        <button className="btn sm" disabled={page >= pages - 1 || loading} onClick={() => setPage(p => p + 1)}>Older<Icon name="chevron" /></button>
                    </div>
                ) : (data ? `${plural(total, 'entry', 'entries')}. Changes to rentals, sites, trailers and customers are recorded here.` : null)}>
                {!data ? <Loading /> : (
                    <DataTable columns={columns} rows={entries}
                        empty={<Empty compact title={q ? 'No matching activity' : 'No activity recorded yet'}>
                            {q ? 'Try a different search.' : 'Edits to rentals, sites, trailers and customers will show up here.'}
                        </Empty>} />
                )}
            </Card>
        </div>
    )
}
