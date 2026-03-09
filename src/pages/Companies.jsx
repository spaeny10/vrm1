import { useState, useCallback, useEffect } from 'react'
import { fetchCompanies, createCompany, updateCompanyApi, fetchContacts, createContact, updateContactApi, deleteContactApi, fetchJobSites, inviteContactToPortal } from '../api/vrm'
import { useAuth } from '../components/AuthProvider'

export default function Companies() {
    const { user } = useAuth()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const [companies, setCompanies] = useState([])
    const [loading, setLoading] = useState(true)
    const [expandedId, setExpandedId] = useState(null)
    const [contacts, setContacts] = useState([])
    const [searchTerm, setSearchTerm] = useState('')
    const [showAddCompany, setShowAddCompany] = useState(false)
    const [newCompany, setNewCompany] = useState({ name: '', address: '', city: '', state: '', zip: '', notes: '' })
    const [saving, setSaving] = useState(false)
    const [showAddContact, setShowAddContact] = useState(false)
    const [newContact, setNewContact] = useState({ name: '', title: '', phone: '', email: '', is_primary: false })
    const [editingCompany, setEditingCompany] = useState(null)
    const [jobSites, setJobSites] = useState([])
    const [inviting, setInviting] = useState(null) // contactId currently being invited
    const [inviteResult, setInviteResult] = useState(null) // { username, temp_password, sites_linked }

    const loadCompanies = useCallback(async () => {
        try {
            const data = await fetchCompanies()
            setCompanies(data?.companies || [])
        } catch (err) {
            console.error('Failed to load companies:', err)
        } finally {
            setLoading(false)
        }
    }, [])

    const loadJobSites = useCallback(async () => {
        try {
            const data = await fetchJobSites()
            setJobSites(data?.job_sites || [])
        } catch (err) { console.error(err) }
    }, [])

    useEffect(() => { loadCompanies(); loadJobSites() }, [])

    const loadContacts = async (companyId) => {
        try {
            const data = await fetchContacts(companyId)
            setContacts(data?.contacts || [])
        } catch (err) {
            console.error('Failed to load contacts:', err)
            setContacts([])
        }
    }

    const handleExpand = (id) => {
        if (expandedId === id) {
            setExpandedId(null)
            setContacts([])
        } else {
            setExpandedId(id)
            loadContacts(id)
        }
    }

    const handleCreateCompany = async (e) => {
        e.preventDefault()
        if (!newCompany.name.trim()) return
        setSaving(true)
        try {
            await createCompany(newCompany)
            setShowAddCompany(false)
            setNewCompany({ name: '', address: '', city: '', state: '', zip: '', notes: '' })
            loadCompanies()
        } catch (err) {
            console.error('Failed to create company:', err)
        } finally {
            setSaving(false)
        }
    }

    const handleUpdateCompany = async (e) => {
        e.preventDefault()
        if (!editingCompany) return
        setSaving(true)
        try {
            await updateCompanyApi(editingCompany.id, editingCompany)
            setEditingCompany(null)
            loadCompanies()
        } catch (err) {
            console.error('Failed to update company:', err)
        } finally {
            setSaving(false)
        }
    }

    const handleCreateContact = async (e) => {
        e.preventDefault()
        if (!newContact.name.trim() || !expandedId) return
        setSaving(true)
        try {
            await createContact(expandedId, newContact)
            setShowAddContact(false)
            setNewContact({ name: '', title: '', phone: '', email: '', is_primary: false })
            loadContacts(expandedId)
        } catch (err) {
            console.error('Failed to create contact:', err)
        } finally {
            setSaving(false)
        }
    }

    const handleDeleteContact = async (contactId) => {
        if (!confirm('Remove this contact?')) return
        try {
            await deleteContactApi(contactId)
            loadContacts(expandedId)
        } catch (err) {
            console.error('Failed to delete contact:', err)
        }
    }

    const handleInviteToPortal = async (contact) => {
        if (!contact.email) return alert('This contact needs an email address before they can be invited.')
        setInviting(contact.id)
        try {
            const result = await inviteContactToPortal(contact.id)
            setInviteResult({
                name: contact.name,
                username: contact.email.toLowerCase(),
                temp_password: result.temp_password,
                sites_linked: result.sites_linked,
            })
        } catch (err) {
            const msg = err?.message || 'Failed to invite'
            alert(msg)
        } finally {
            setInviting(null)
        }
    }

    const filtered = companies.filter(c =>
        c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (c.address || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (c.city || '').toLowerCase().includes(searchTerm.toLowerCase())
    )

    if (loading) {
        return (
            <div className="companies-page">
                <div className="page-header"><h1>Companies</h1></div>
                <div className="page-loading"><div className="spinner" /><p>Loading companies...</p></div>
            </div>
        )
    }

    return (
        <div className="companies-page">
            <div className="page-header">
                <div className="page-header-row">
                    <h1>Companies</h1>
                    <div className="page-header-actions">
                        {canEdit && (
                            <button className="btn btn-sm btn-primary" onClick={() => setShowAddCompany(true)}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                Add Company
                            </button>
                        )}
                    </div>
                </div>
                <p className="page-subtitle">{companies.length} companies registered</p>
            </div>

            {/* Search */}
            <div className="fleet-controls" style={{ marginBottom: 16 }}>
                <div className="search-box">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input type="text" placeholder="Search companies..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
                </div>
            </div>

            {/* Companies List */}
            <div className="companies-list">
                {filtered.map(company => {
                    const isExpanded = expandedId === company.id
                    const companySites = jobSites.filter(js => js.company_id === company.id)
                    return (
                        <div key={company.id} className={`company-card ${isExpanded ? 'company-card-expanded' : ''}`}>
                            <div className="company-card-header" onClick={() => handleExpand(company.id)}>
                                <div className="company-info">
                                    <div className="company-name-row">
                                        <h3>{company.name}</h3>
                                        <div className="company-badges">
                                            <span className="company-badge">{company.contact_count || 0} contacts</span>
                                            <span className="company-badge">{company.site_count || 0} sites</span>
                                        </div>
                                    </div>
                                    {(company.address || company.city) && (
                                        <p className="company-address">
                                            {[company.address, company.city, company.state, company.zip].filter(Boolean).join(', ')}
                                        </p>
                                    )}
                                </div>
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                    style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', flexShrink: 0 }}>
                                    <polyline points="6 9 12 15 18 9" />
                                </svg>
                            </div>

                            {isExpanded && (
                                <div className="company-detail">
                                    {/* Edit Company */}
                                    {canEdit && (
                                        <div className="company-actions-bar">
                                            <button className="btn btn-sm btn-ghost" onClick={() => setEditingCompany({ ...company })}>
                                                Edit Company
                                            </button>
                                        </div>
                                    )}

                                    {/* Contacts Section */}
                                    <div className="company-section">
                                        <div className="company-section-header">
                                            <h4>Contacts</h4>
                                            {canEdit && (
                                                <button className="btn btn-sm btn-ghost" onClick={() => setShowAddContact(true)}>
                                                    + Add Contact
                                                </button>
                                            )}
                                        </div>
                                        {contacts.length === 0 ? (
                                            <p className="company-empty">No contacts yet. Add one to get started.</p>
                                        ) : (
                                            <div className="contacts-grid">
                                                {contacts.map(c => (
                                                    <div key={c.id} className="contact-card">
                                                        <div className="contact-card-top">
                                                            <div className="contact-avatar">{c.name.charAt(0).toUpperCase()}</div>
                                                            <div className="contact-info">
                                                                <span className="contact-name">{c.name}</span>
                                                                {c.title && <span className="contact-title">{c.title}</span>}
                                                            </div>
                                                            {c.is_primary && <span className="contact-primary-badge">Primary</span>}
                                                        </div>
                                                        <div className="contact-details">
                                                            {c.phone && (
                                                                <span className="contact-detail">
                                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                                                                    </svg>
                                                                    {c.phone}
                                                                </span>
                                                            )}
                                                            {c.email && (
                                                                <span className="contact-detail">
                                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                                                                        <polyline points="22,6 12,13 2,6" />
                                                                    </svg>
                                                                    {c.email}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {canEdit && (
                                                            <div className="contact-card-actions">
                                                                {c.email && !c.portal_user_id && (
                                                                    <button
                                                                        className="btn btn-xs btn-accent"
                                                                        onClick={() => handleInviteToPortal(c)}
                                                                        disabled={inviting === c.id}
                                                                        title="Create a portal account for this contact"
                                                                    >
                                                                        {inviting === c.id ? '...' : '🔑 Invite to Portal'}
                                                                    </button>
                                                                )}
                                                                {c.portal_user_id && (
                                                                    <span className="contact-portal-badge">✓ Portal Access</span>
                                                                )}
                                                                <button className="contact-delete" onClick={() => handleDeleteContact(c.id)} title="Remove contact">
                                                                    &times;
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Linked Sites Section */}
                                    <div className="company-section">
                                        <div className="company-section-header">
                                            <h4>Linked Sites</h4>
                                        </div>
                                        {companySites.length === 0 ? (
                                            <p className="company-empty">No sites linked to this company yet.</p>
                                        ) : (
                                            <div className="sites-mini-list">
                                                {companySites.map(s => (
                                                    <div key={s.id} className="site-mini-card" onClick={() => window.location.hash = `/site/${s.id}`}>
                                                        <span className="site-mini-name">{s.name}</span>
                                                        <span className={`site-mini-status site-status-${s.status}`}>{s.status}</span>
                                                        <span className="site-mini-trailers">{s.trailer_count || 0} trailers</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                })}

                {filtered.length === 0 && (
                    <div className="no-results">
                        <p>{searchTerm ? 'No companies match your search' : 'No companies yet. Create one to get started.'}</p>
                    </div>
                )}
            </div>

            {/* Add Company Modal */}
            {showAddCompany && (
                <div className="modal-overlay" onClick={() => setShowAddCompany(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
                        <div className="modal-header">
                            <h2>Add New Company</h2>
                            <button className="modal-close" onClick={() => setShowAddCompany(false)}>&times;</button>
                        </div>
                        <form onSubmit={handleCreateCompany} style={{ padding: '20px' }}>
                            <div style={{ display: 'grid', gap: '14px' }}>
                                <div>
                                    <label className="form-label">Company Name *</label>
                                    <input className="input" required value={newCompany.name} onChange={e => setNewCompany(s => ({ ...s, name: e.target.value }))} placeholder="ABC Construction LLC" />
                                </div>
                                <div>
                                    <label className="form-label">Address</label>
                                    <input className="input" value={newCompany.address} onChange={e => setNewCompany(s => ({ ...s, address: e.target.value }))} placeholder="123 Main St" />
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '12px' }}>
                                    <div>
                                        <label className="form-label">City</label>
                                        <input className="input" value={newCompany.city} onChange={e => setNewCompany(s => ({ ...s, city: e.target.value }))} placeholder="Kansas City" />
                                    </div>
                                    <div>
                                        <label className="form-label">State</label>
                                        <input className="input" value={newCompany.state} onChange={e => setNewCompany(s => ({ ...s, state: e.target.value }))} placeholder="KS" />
                                    </div>
                                    <div>
                                        <label className="form-label">ZIP</label>
                                        <input className="input" value={newCompany.zip} onChange={e => setNewCompany(s => ({ ...s, zip: e.target.value }))} placeholder="66101" />
                                    </div>
                                </div>
                                <div>
                                    <label className="form-label">Notes</label>
                                    <textarea className="input" rows="2" value={newCompany.notes} onChange={e => setNewCompany(s => ({ ...s, notes: e.target.value }))} placeholder="Internal notes about this company..." style={{ resize: 'vertical' }} />
                                </div>
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-secondary" onClick={() => setShowAddCompany(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary" disabled={!newCompany.name.trim() || saving}>
                                    {saving ? 'Creating...' : 'Create Company'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Edit Company Modal */}
            {editingCompany && (
                <div className="modal-overlay" onClick={() => setEditingCompany(null)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
                        <div className="modal-header">
                            <h2>Edit Company</h2>
                            <button className="modal-close" onClick={() => setEditingCompany(null)}>&times;</button>
                        </div>
                        <form onSubmit={handleUpdateCompany} style={{ padding: '20px' }}>
                            <div style={{ display: 'grid', gap: '14px' }}>
                                <div>
                                    <label className="form-label">Company Name *</label>
                                    <input className="input" required value={editingCompany.name} onChange={e => setEditingCompany(s => ({ ...s, name: e.target.value }))} />
                                </div>
                                <div>
                                    <label className="form-label">Address</label>
                                    <input className="input" value={editingCompany.address || ''} onChange={e => setEditingCompany(s => ({ ...s, address: e.target.value }))} />
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '12px' }}>
                                    <div>
                                        <label className="form-label">City</label>
                                        <input className="input" value={editingCompany.city || ''} onChange={e => setEditingCompany(s => ({ ...s, city: e.target.value }))} />
                                    </div>
                                    <div>
                                        <label className="form-label">State</label>
                                        <input className="input" value={editingCompany.state || ''} onChange={e => setEditingCompany(s => ({ ...s, state: e.target.value }))} />
                                    </div>
                                    <div>
                                        <label className="form-label">ZIP</label>
                                        <input className="input" value={editingCompany.zip || ''} onChange={e => setEditingCompany(s => ({ ...s, zip: e.target.value }))} />
                                    </div>
                                </div>
                                <div>
                                    <label className="form-label">Notes</label>
                                    <textarea className="input" rows="2" value={editingCompany.notes || ''} onChange={e => setEditingCompany(s => ({ ...s, notes: e.target.value }))} style={{ resize: 'vertical' }} />
                                </div>
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-secondary" onClick={() => setEditingCompany(null)}>Cancel</button>
                                <button type="submit" className="btn btn-primary" disabled={saving}>
                                    {saving ? 'Saving...' : 'Save Changes'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Add Contact Modal */}
            {showAddContact && expandedId && (
                <div className="modal-overlay" onClick={() => setShowAddContact(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
                        <div className="modal-header">
                            <h2>Add Contact</h2>
                            <button className="modal-close" onClick={() => setShowAddContact(false)}>&times;</button>
                        </div>
                        <form onSubmit={handleCreateContact} style={{ padding: '20px' }}>
                            <div style={{ display: 'grid', gap: '14px' }}>
                                <div>
                                    <label className="form-label">Name *</label>
                                    <input className="input" required value={newContact.name} onChange={e => setNewContact(s => ({ ...s, name: e.target.value }))} placeholder="John Smith" />
                                </div>
                                <div>
                                    <label className="form-label">Title</label>
                                    <input className="input" value={newContact.title} onChange={e => setNewContact(s => ({ ...s, title: e.target.value }))} placeholder="Project Manager" />
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                    <div>
                                        <label className="form-label">Phone</label>
                                        <input className="input" value={newContact.phone} onChange={e => setNewContact(s => ({ ...s, phone: e.target.value }))} placeholder="(555) 123-4567" />
                                    </div>
                                    <div>
                                        <label className="form-label">Email</label>
                                        <input className="input" type="email" value={newContact.email} onChange={e => setNewContact(s => ({ ...s, email: e.target.value }))} placeholder="john@example.com" />
                                    </div>
                                </div>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                                    <input type="checkbox" checked={newContact.is_primary} onChange={e => setNewContact(s => ({ ...s, is_primary: e.target.checked }))} />
                                    Primary contact
                                </label>
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-secondary" onClick={() => setShowAddContact(false)}>Cancel</button>
                                <button type="submit" className="btn btn-primary" disabled={!newContact.name.trim() || saving}>
                                    {saving ? 'Adding...' : 'Add Contact'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Invite Credentials Modal */}
            {inviteResult && (
                <div className="modal-overlay" onClick={() => setInviteResult(null)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
                        <div className="modal-header">
                            <h2>Portal Account Created</h2>
                            <button className="modal-close" onClick={() => setInviteResult(null)}>&times;</button>
                        </div>
                        <div style={{ padding: 20 }}>
                            <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: 14 }}>
                                A customer portal account has been created for <strong>{inviteResult.name}</strong>.
                                Share the credentials below so they can log in.
                            </p>
                            <div className="invite-credentials">
                                <div className="invite-cred-row">
                                    <span className="invite-cred-label">Username</span>
                                    <code className="invite-cred-value">{inviteResult.username}</code>
                                </div>
                                <div className="invite-cred-row">
                                    <span className="invite-cred-label">Temp Password</span>
                                    <code className="invite-cred-value">{inviteResult.temp_password}</code>
                                </div>
                                <div className="invite-cred-row">
                                    <span className="invite-cred-label">Sites Linked</span>
                                    <span className="invite-cred-value">{inviteResult.sites_linked} site(s)</span>
                                </div>
                            </div>
                            <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                                The customer will only see sites they are assigned to as a contact.
                            </p>
                            <div className="modal-footer">
                                <button className="btn btn-primary" onClick={() => {
                                    navigator.clipboard.writeText(`Username: ${inviteResult.username}\nPassword: ${inviteResult.temp_password}`)
                                    setInviteResult(null)
                                }}>Copy Credentials & Close</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
