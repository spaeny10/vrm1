import { pool } from './core.js';

export async function getMaintenanceLogs(filters = {}) {
    if (!pool) return [];
    let query = `SELECT ml.*, js.name as job_site_name, ta.site_name as trailer_name,
                        u.display_name as assigned_technician_name
                 FROM maintenance_logs ml
                 LEFT JOIN job_sites js ON ml.job_site_id = js.id
                 LEFT JOIN trailer_assignments ta ON ml.site_id = ta.site_id
                 LEFT JOIN users u ON ml.assigned_technician_id = u.id
                 WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (filters.job_site_id) {
        query += ` AND ml.job_site_id = $${idx}`;
        params.push(filters.job_site_id);
        idx++;
    }
    if (filters.site_id) {
        query += ` AND ml.site_id = $${idx}`;
        params.push(filters.site_id);
        idx++;
    }
    if (filters.status) {
        query += ` AND ml.status = $${idx}`;
        params.push(filters.status);
        idx++;
    }

    query += ` ORDER BY COALESCE(ml.scheduled_date, ml.created_at) DESC`;

    if (filters.limit) {
        query += ` LIMIT $${idx}`;
        params.push(filters.limit);
    }

    const result = await pool.query(query, params);
    return result.rows;
}

export async function getMaintenanceLog(id) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT ml.*, js.name as job_site_name, ta.site_name as trailer_name,
                u.display_name as assigned_technician_name
         FROM maintenance_logs ml
         LEFT JOIN job_sites js ON ml.job_site_id = js.id
         LEFT JOIN trailer_assignments ta ON ml.site_id = ta.site_id
         LEFT JOIN users u ON ml.assigned_technician_id = u.id
         WHERE ml.id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

export async function insertMaintenanceLog(log) {
    if (!pool) return null;
    const now = Date.now();
    const result = await pool.query(
        `INSERT INTO maintenance_logs
         (job_site_id, site_id, visit_type, status, title, description, technician, assigned_technician_id,
          scheduled_date, completed_date, labor_hours, labor_cost_cents, parts_cost_cents, parts_used,
          recurrence_rule, recurrence_end_date, parent_log_id,
          created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)
         RETURNING *`,
        [
            log.job_site_id || null, log.site_id || null, log.visit_type, log.status || 'scheduled',
            log.title, log.description || null, log.technician || null, log.assigned_technician_id || null,
            log.scheduled_date || null, log.completed_date || null,
            log.labor_hours || null, log.labor_cost_cents || 0, log.parts_cost_cents || 0,
            log.parts_used ? JSON.stringify(log.parts_used) : null,
            log.recurrence_rule || null, log.recurrence_end_date || null, log.parent_log_id || null,
            now
        ]
    );
    return result.rows[0];
}

export async function updateMaintenanceLog(id, updates) {
    if (!pool) return null;
    const allowedFields = [
        'job_site_id', 'site_id', 'visit_type', 'status', 'title', 'description',
        'technician', 'assigned_technician_id', 'scheduled_date', 'completed_date',
        'labor_hours', 'labor_cost_cents', 'parts_cost_cents', 'parts_used',
        'recurrence_rule', 'recurrence_end_date', 'parent_log_id'
    ];
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            if (key === 'parts_used') {
                fields.push(`${key} = $${idx}`);
                values.push(value ? JSON.stringify(value) : null);
            } else {
                fields.push(`${key} = $${idx}`);
                values.push(value);
            }
            idx++;
        }
    }
    if (fields.length === 0) return null;

    fields.push(`updated_at = $${idx}`);
    values.push(Date.now());
    idx++;

    values.push(id);
    const result = await pool.query(
        `UPDATE maintenance_logs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

export async function deleteMaintenanceLog(id) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE maintenance_logs SET status = 'cancelled', updated_at = $1 WHERE id = $2 RETURNING *`,
        [Date.now(), id]
    );
    return result.rows[0] || null;
}

export async function getMaintenanceStats() {
    if (!pool) return {};
    const result = await pool.query(`
        SELECT
            COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled')) as open_count,
            COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_date < $1) as overdue_count,
            COUNT(*) FILTER (WHERE status = 'scheduled'
                AND scheduled_date >= $1
                AND scheduled_date <= $2) as upcoming_week,
            COALESCE(SUM(labor_cost_cents + parts_cost_cents) FILTER (
                WHERE status = 'completed'
                AND completed_date >= $3
            ), 0) as cost_mtd_cents
        FROM maintenance_logs
    `, [Date.now(), Date.now() + 7 * 86400000, getMonthStart()]);
    return result.rows[0];
}

function getMonthStart() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export async function getMaintenanceCostsByJobSite(days = 30) {
    if (!pool) return [];
    const cutoffMs = Date.now() - days * 86400000;
    const result = await pool.query(
        `SELECT
            js.id as job_site_id,
            js.name as job_site_name,
            COUNT(ml.id) as log_count,
            COALESCE(SUM(ml.labor_cost_cents), 0) as labor_cost_cents,
            COALESCE(SUM(ml.parts_cost_cents), 0) as parts_cost_cents,
            COALESCE(SUM(ml.labor_cost_cents + ml.parts_cost_cents), 0) as total_cost_cents
         FROM job_sites js
         INNER JOIN maintenance_logs ml ON ml.job_site_id = js.id
            AND ml.created_at >= $1
            AND ml.status != 'cancelled'
         WHERE js.status = 'active'
         GROUP BY js.id, js.name
         HAVING SUM(ml.labor_cost_cents + ml.parts_cost_cents) > 0
         ORDER BY total_cost_cents DESC`,
        [cutoffMs]
    );
    return result.rows;
}

export async function getUpcomingMaintenance(days = 30) {
    if (!pool) return [];
    const cutoff = Date.now() + days * 86400000;
    const result = await pool.query(
        `SELECT ml.*, js.name as job_site_name, ta.site_name as trailer_name
         FROM maintenance_logs ml
         LEFT JOIN job_sites js ON ml.job_site_id = js.id
         LEFT JOIN trailer_assignments ta ON ml.site_id = ta.site_id
         WHERE ml.status = 'scheduled' AND ml.scheduled_date <= $1
         ORDER BY ml.scheduled_date ASC`,
        [cutoff]
    );
    return result.rows;
}

// ============================================================
// Trailer Components
// ============================================================

export async function getComponents(siteId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT * FROM trailer_components WHERE site_id = $1 ORDER BY component_type, created_at`,
        [siteId]
    );
    return result.rows;
}

export async function insertComponent(comp) {
    if (!pool) return null;
    const now = Date.now();
    const result = await pool.query(
        `INSERT INTO trailer_components
         (site_id, component_type, make, model, serial_number, installed_date, warranty_expiry, status, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         RETURNING *`,
        [comp.site_id, comp.component_type, comp.make || null, comp.model || null,
        comp.serial_number || null, comp.installed_date || null, comp.warranty_expiry || null,
        comp.status || 'active', comp.notes || null, now]
    );
    return result.rows[0];
}

export async function updateComponent(id, updates) {
    if (!pool) return null;
    const allowedFields = ['component_type', 'make', 'model', 'serial_number', 'installed_date', 'warranty_expiry', 'status', 'notes'];
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            fields.push(`${key} = $${idx}`);
            values.push(value);
            idx++;
        }
    }
    if (fields.length === 0) return null;

    fields.push(`updated_at = $${idx}`);
    values.push(Date.now());
    idx++;

    values.push(id);
    const result = await pool.query(
        `UPDATE trailer_components SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

// ============================================================
// Analytics Daily Metrics
// ============================================================


export async function getChecklistTemplates() {
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM checklist_templates WHERE active = TRUE ORDER BY name`);
    return result.rows;
}

export async function insertChecklistTemplate(template) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO checklist_templates (name, visit_type, items)
         VALUES ($1, $2, $3) RETURNING *`,
        [template.name, template.visit_type, JSON.stringify(template.items)]
    );
    return result.rows[0];
}

export async function updateChecklistTemplate(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
        if (['name', 'visit_type', 'active'].includes(key)) {
            fields.push(`${key} = $${idx++}`);
            values.push(val);
        } else if (key === 'items') {
            fields.push(`items = $${idx++}`);
            values.push(JSON.stringify(val));
        }
    }
    if (fields.length === 0) return null;
    fields.push(`updated_at = $${idx++}`);
    values.push(Date.now());
    values.push(id);
    const result = await pool.query(
        `UPDATE checklist_templates SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

// ============================================================
// Completed Checklists
// ============================================================

export async function getCompletedChecklists(maintenanceLogId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT c.*, u.display_name AS completed_by_name
         FROM completed_checklists c LEFT JOIN users u ON c.completed_by = u.id
         WHERE c.maintenance_log_id = $1 ORDER BY c.completed_at DESC`,
        [maintenanceLogId]
    );
    return result.rows;
}

export async function insertCompletedChecklist(checklist) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO completed_checklists (maintenance_log_id, template_id, template_name, completed_by, items)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [checklist.maintenance_log_id, checklist.template_id, checklist.template_name,
        checklist.completed_by, JSON.stringify(checklist.items)]
    );
    return result.rows[0];
}

// ============================================================
// Issue Templates
// ============================================================

export async function getIssueTemplates() {
    if (!pool) return [];
    const result = await pool.query(`SELECT * FROM issue_templates WHERE active = TRUE ORDER BY name`);
    return result.rows;
}

export async function insertIssueTemplate(template) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO issue_templates (name, visit_type, title, description, expected_parts, estimated_hours)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [template.name, template.visit_type, template.title, template.description,
        JSON.stringify(template.expected_parts || []), template.estimated_hours || null]
    );
    return result.rows[0];
}

export async function updateIssueTemplate(id, updates) {
    if (!pool) return null;
    const fields = [];
    const values = [];
    let idx = 1;
    for (const [key, val] of Object.entries(updates)) {
        if (['name', 'visit_type', 'title', 'description', 'estimated_hours', 'active'].includes(key)) {
            fields.push(`${key} = $${idx++}`);
            values.push(val);
        } else if (key === 'expected_parts') {
            fields.push(`expected_parts = $${idx++}`);
            values.push(JSON.stringify(val));
        }
    }
    if (fields.length === 0) return null;
    fields.push(`updated_at = $${idx++}`);
    values.push(Date.now());
    values.push(id);
    const result = await pool.query(
        `UPDATE issue_templates SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
    );
    return result.rows[0] || null;
}

// ============================================================
// Maintenance Calendar
// ============================================================

export async function getMaintenanceCalendar(startMs, endMs, technicianId) {
    if (!pool) return [];
    let query = `
        SELECT m.*, j.name AS job_site_name, u.display_name AS assigned_technician_name
        FROM maintenance_logs m
        LEFT JOIN job_sites j ON m.job_site_id = j.id
        LEFT JOIN users u ON m.assigned_technician_id = u.id
        WHERE m.status != 'cancelled'
    `;
    const params = [];
    let idx = 1;
    if (startMs) {
        query += ` AND (m.scheduled_date >= $${idx} OR m.completed_date >= $${idx})`;
        params.push(startMs);
        idx++;
    }
    if (endMs) {
        query += ` AND (m.scheduled_date <= $${idx} OR m.completed_date <= $${idx})`;
        params.push(endMs);
        idx++;
    }
    if (technicianId) {
        query += ` AND m.assigned_technician_id = $${idx}`;
        params.push(technicianId);
        idx++;
    }
    query += ` ORDER BY COALESCE(m.scheduled_date, m.created_at) ASC`;
    const result = await pool.query(query, params);
    return result.rows;
}

// ============================================================
// Customer Site Access (portal)
// ============================================================


// Per-trailer maintenance stats for the Health Grade maintenance component
export async function getMaintenanceStatsBySite() {
    if (!pool) return [];
    const now = Date.now();
    const result = await pool.query(`
        SELECT site_id,
               COUNT(*) FILTER (WHERE status NOT IN ('completed', 'cancelled')) AS open_count,
               COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_date < $1) AS overdue_count,
               COUNT(*) FILTER (WHERE visit_type = 'emergency' AND created_at > $2) AS emergency_30d
        FROM maintenance_logs
        WHERE site_id IS NOT NULL
        GROUP BY site_id
    `, [now, now - 30 * 86400000]);
    return result.rows;
}
