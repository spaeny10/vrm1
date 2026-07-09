import { deleteMaintenanceLog, getChecklistTemplates, getCompletedChecklists, getComponents, getIssueTemplates, getMaintenanceCalendar, getMaintenanceCostsByJobSite, getMaintenanceLog, getMaintenanceLogs, getMaintenanceStats, getUpcomingMaintenance, insertChecklistTemplate, insertCompletedChecklist, insertComponent, insertIssueTemplate, insertMaintenanceLog, updateChecklistTemplate, updateComponent, updateIssueTemplate, updateMaintenanceLog } from '../db.js';
import { requireRole } from '../middleware/auth.js';

function getNextDate(dateMs, rule) {
    const d = new Date(dateMs);
    switch (rule) {
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'biweekly': d.setDate(d.getDate() + 14); break;
        case 'monthly': d.setMonth(d.getMonth() + 1); break;
        case 'quarterly': d.setMonth(d.getMonth() + 3); break;
        case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
        default: return null;
    }
    return d.getTime();
}

async function generateRecurringInstances(parentLog) {
    if (!parentLog.recurrence_rule || !parentLog.scheduled_date) return;
    const endDate = parentLog.recurrence_end_date || (Date.now() + 365 * 86400000); // default 1 year
    const maxInstances = 52; // safety cap
    let nextDate = getNextDate(Number(parentLog.scheduled_date), parentLog.recurrence_rule);
    let count = 0;
    while (nextDate && nextDate <= endDate && count < maxInstances) {
        await insertMaintenanceLog({
            job_site_id: parentLog.job_site_id,
            site_id: parentLog.site_id,
            visit_type: parentLog.visit_type,
            status: 'scheduled',
            title: parentLog.title,
            description: parentLog.description,
            technician: parentLog.technician,
            assigned_technician_id: parentLog.assigned_technician_id,
            scheduled_date: nextDate,
            labor_hours: parentLog.labor_hours,
            labor_cost_cents: 0,
            parts_cost_cents: 0,
            parts_used: parentLog.parts_used,
            parent_log_id: parentLog.id,
        });
        nextDate = getNextDate(nextDate, parentLog.recurrence_rule);
        count++;
    }
    console.log(`[Maintenance] Generated ${count} recurring instances for log #${parentLog.id} (${parentLog.recurrence_rule})`);
}

// Parse date param that may be a ms timestamp or ISO date string
function parseDateParam(val) {
    if (!val) return null;
    const num = Number(val);
    if (!isNaN(num) && num > 1e10) return num; // ms timestamp
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.getTime();
}

function validateMaintenanceInput(body, isCreate = false) {
    const errors = [];
    if (isCreate) {
        if (!body.visit_type || !body.title) errors.push('visit_type and title are required');
    }
    if (body.visit_type && !VALID_VISIT_TYPES.includes(body.visit_type)) errors.push(`Invalid visit_type: ${body.visit_type}`);
    if (body.status && !VALID_STATUSES.includes(body.status)) errors.push(`Invalid status: ${body.status}`);
    if (body.labor_hours != null && (isNaN(body.labor_hours) || body.labor_hours < 0)) errors.push('labor_hours must be >= 0');
    if (body.labor_cost_cents != null && (isNaN(body.labor_cost_cents) || body.labor_cost_cents < 0)) errors.push('labor_cost_cents must be >= 0');
    if (body.parts_cost_cents != null && (isNaN(body.parts_cost_cents) || body.parts_cost_cents < 0)) errors.push('parts_cost_cents must be >= 0');
    if (body.recurrence_rule && !VALID_RECURRENCE.includes(body.recurrence_rule)) errors.push(`Invalid recurrence_rule: ${body.recurrence_rule}`);
    if (body.recurrence_rule && !body.scheduled_date) errors.push('Recurring tasks require a scheduled_date');
    return errors;
}

const VALID_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'];
const VALID_VISIT_TYPES = ['inspection', 'repair', 'scheduled', 'emergency', 'installation', 'decommission'];
const VALID_RECURRENCE = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

export function registerMaintenanceRoutes(app) {

app.get('/api/maintenance', async (req, res) => {
    try {
        const filters = {};
        if (req.query.job_site_id) filters.job_site_id = parseInt(req.query.job_site_id);
        if (req.query.site_id) filters.site_id = parseInt(req.query.site_id);
        if (req.query.status) {
            if (!['scheduled', 'in_progress', 'completed', 'cancelled'].includes(req.query.status)) {
                return res.status(400).json({ success: false, error: 'Invalid status filter' });
            }
            filters.status = req.query.status;
        }
        if (req.query.limit) filters.limit = parseInt(req.query.limit);
        const logs = await getMaintenanceLogs(filters);
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/maintenance/stats', async (req, res) => {
    try {
        const stats = await getMaintenanceStats();
        res.json({ success: true, stats });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/maintenance/costs-by-site', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const costs = await getMaintenanceCostsByJobSite(days);
        res.json({ success: true, costs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/maintenance/upcoming', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const logs = await getUpcomingMaintenance(days);
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Calendar must be before :id route so Express doesn't match "calendar" as an id
app.get('/api/maintenance/calendar', async (req, res) => {
    try {
        const start = req.query.start ? parseDateParam(req.query.start) : Date.now() - 30 * 86400000;
        const end = req.query.end ? parseDateParam(req.query.end) : Date.now() + 60 * 86400000;
        if (start === null || end === null) return res.status(400).json({ error: 'Invalid date range' });
        const techId = req.query.technician_id ? parseInt(req.query.technician_id) : null;
        if (req.query.technician_id && isNaN(techId)) return res.status(400).json({ error: 'Invalid technician_id' });
        const logs = await getMaintenanceCalendar(start, end, techId);
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/maintenance/:id', async (req, res) => {
    try {
        const log = await getMaintenanceLog(parseInt(req.params.id));
        if (!log) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/maintenance', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const errors = validateMaintenanceInput(req.body, true);
        if (errors.length > 0) return res.status(400).json({ success: false, error: errors.join('; ') });

        const log = await insertMaintenanceLog(req.body);

        // Generate recurring instances if recurrence_rule is set
        if (req.body.recurrence_rule && log) {
            await generateRecurringInstances(log);
        }

        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/maintenance/:id', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const errors = validateMaintenanceInput(req.body, false);
        if (errors.length > 0) return res.status(400).json({ success: false, error: errors.join('; ') });

        const log = await updateMaintenanceLog(parseInt(req.params.id), req.body);
        if (!log) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/maintenance/:id', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const log = await deleteMaintenanceLog(parseInt(req.params.id));
        if (!log) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/components/:siteId', async (req, res) => {
    try {
        const components = await getComponents(parseInt(req.params.siteId));
        res.json({ success: true, components });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/components', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { site_id, component_type } = req.body;
        if (!site_id || !component_type) {
            return res.status(400).json({ success: false, error: 'site_id and component_type are required' });
        }
        const component = await insertComponent(req.body);
        res.json({ success: true, component });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/components/:id', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const component = await updateComponent(parseInt(req.params.id), req.body);
        if (!component) return res.status(404).json({ success: false, error: 'Not found' });
        res.json({ success: true, component });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/checklist-templates', async (req, res) => {
    try {
        const templates = await getChecklistTemplates();
        res.json({ success: true, templates });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/checklist-templates', requireRole('admin'), async (req, res) => {
    try {
        const template = await insertChecklistTemplate(req.body);
        res.json({ success: true, template });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/checklist-templates/:id', requireRole('admin'), async (req, res) => {
    try {
        const template = await updateChecklistTemplate(parseInt(req.params.id), req.body);
        if (!template) return res.status(404).json({ error: 'Template not found' });
        res.json({ success: true, template });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/maintenance/:id/checklists', async (req, res) => {
    try {
        const checklists = await getCompletedChecklists(parseInt(req.params.id));
        res.json({ success: true, checklists });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/maintenance/:id/checklists', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const checklist = await insertCompletedChecklist({
            maintenance_log_id: parseInt(req.params.id),
            template_id: req.body.template_id,
            template_name: req.body.template_name,
            completed_by: req.user.id,
            items: req.body.items,
        });
        res.json({ success: true, checklist });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/issue-templates', async (req, res) => {
    try {
        const templates = await getIssueTemplates();
        res.json({ success: true, templates });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/issue-templates', requireRole('admin'), async (req, res) => {
    try {
        const template = await insertIssueTemplate(req.body);
        res.json({ success: true, template });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/issue-templates/:id', requireRole('admin'), async (req, res) => {
    try {
        const template = await updateIssueTemplate(parseInt(req.params.id), req.body);
        if (!template) return res.status(404).json({ error: 'Template not found' });
        res.json({ success: true, template });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

}
