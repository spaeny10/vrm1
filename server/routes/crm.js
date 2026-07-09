import bcrypt from 'bcryptjs';
import { createUser, deleteContact, getCompanies, getCompany, getContactById, getContactSiteIds, getContacts, getJobSites, getUserByUsername, insertAuditLog, insertCompany, insertContact, setContactPortalUserId, updateCompany, updateContact, upsertCustomerSiteAccess } from '../db.js';
import { requireRole } from '../middleware/auth.js';

export function registerCrmRoutes(app) {

// ============================================================
// Companies API
// ============================================================
app.get('/api/companies', async (req, res) => {
    try {
        const companies = await getCompanies();
        res.json({ success: true, companies });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/companies/:id', async (req, res) => {
    try {
        const company = await getCompany(parseInt(req.params.id));
        if (!company) return res.status(404).json({ success: false, error: 'Company not found' });
        const contacts = await getContacts(company.id);
        const jobSites = await getJobSites();
        const sites = jobSites.filter(js => js.company_id === company.id);
        res.json({ success: true, company, contacts, sites });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/companies', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { name } = req.body;
        if (!name?.trim()) return res.status(400).json({ success: false, error: 'Company name is required' });
        const created = await insertCompany(req.body);
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('company', created.id, 'company_created', { name: created.name }, actor).catch(() => { });
        res.status(201).json({ success: true, company: created });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, error: 'A company with that name already exists' });
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/companies/:id', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const updated = await updateCompany(parseInt(req.params.id), req.body);
        if (!updated) return res.status(404).json({ success: false, error: 'Company not found' });
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('company', updated.id, 'company_updated', { fields: Object.keys(req.body) }, actor).catch(() => { });
        res.json({ success: true, company: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Contacts API
// ============================================================
app.get('/api/companies/:id/contacts', async (req, res) => {
    try {
        const contacts = await getContacts(parseInt(req.params.id));
        res.json({ success: true, contacts });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/companies/:id/contacts', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { name } = req.body;
        if (!name?.trim()) return res.status(400).json({ success: false, error: 'Contact name is required' });
        const created = await insertContact({ ...req.body, company_id: parseInt(req.params.id) });
        res.status(201).json({ success: true, contact: created });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/contacts/:id', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const updated = await updateContact(parseInt(req.params.id), req.body);
        if (!updated) return res.status(404).json({ success: false, error: 'Contact not found' });
        res.json({ success: true, contact: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/contacts/:id', requireRole('admin'), async (req, res) => {
    try {
        await deleteContact(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Invite contact to customer portal
app.post('/api/contacts/:id/invite', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const contactId = parseInt(req.params.id);
        const contact = await getContactById(contactId);
        if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });

        if (!contact.email) return res.status(400).json({ success: false, error: 'Contact must have an email address to be invited' });

        // Check if user already exists with this email as username
        const existing = await getUserByUsername(contact.email.toLowerCase());
        if (existing) return res.status(409).json({ success: false, error: `A portal account already exists for ${contact.email}` });

        // Generate a temporary password
        const tempPassword = 'BV-' + Math.random().toString(36).slice(2, 8).toUpperCase() + Math.floor(Math.random() * 90 + 10);
        const hash = await bcrypt.hash(tempPassword, 10);

        // Create the customer user account
        const newUser = await createUser(contact.email.toLowerCase(), hash, contact.name, 'customer');

        // Auto-link site access from contact's site assignments
        const siteIds = await getContactSiteIds(contactId);
        if (siteIds.length > 0) {
            for (const siteId of siteIds) {
                await upsertCustomerSiteAccess(newUser.id, siteId);
            }
        }

        // Store portal user reference on contact
        await setContactPortalUserId(contactId, newUser.id);

        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('contact', contactId, 'portal_invited', {
            user_id: newUser.id,
            email: contact.email,
            sites_linked: siteIds.length
        }, actor).catch(() => { });

        res.status(201).json({
            success: true,
            user: newUser,
            temp_password: tempPassword,
            sites_linked: siteIds.length,
            message: `Portal account created for ${contact.name}. Username: ${contact.email}, Temp password: ${tempPassword}`
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

}
