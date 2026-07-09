import { pool } from './core.js';

export async function upsertEmbedding(contentType, contentId, contentText, embedding, metadata = {}) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO fleet_embeddings
      (content_type, content_id, content_text, embedding, metadata, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (content_type, content_id)
     DO UPDATE SET content_text = $3, embedding = $4, metadata = $5, timestamp = $6`,
        [contentType, contentId, contentText, JSON.stringify(embedding), metadata, Date.now()]
    );
}

export async function semanticSearch(queryEmbedding, contentTypes = null, limit = 20) {
    if (!pool) return [];

    let query = `
        SELECT
            content_type,
            content_id,
            content_text,
            metadata,
            timestamp,
            1 - (embedding <=> $1::vector) as similarity
        FROM fleet_embeddings
    `;

    const params = [JSON.stringify(queryEmbedding)];

    if (contentTypes && contentTypes.length > 0) {
        query += ` WHERE content_type = ANY($2)`;
        params.push(contentTypes);
    }

    query += ` ORDER BY embedding <=> $1::vector LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);
    return result.rows;
}

export async function getEmbeddingStats() {
    if (!pool) return {};
    const result = await pool.query(`
        SELECT
            content_type,
            COUNT(*) as count,
            MAX(timestamp) as latest_timestamp
        FROM fleet_embeddings
        GROUP BY content_type
        ORDER BY content_type
    `);
    return result.rows;
}

export async function getAllContentForEmbedding() {
    if (!pool) return [];

    // Get all sites with latest data
    const sites = await pool.query(`
        SELECT DISTINCT ON (site_id)
            site_id,
            site_name,
            battery_soc,
            battery_voltage,
            solar_watts,
            charge_state,
            timestamp
        FROM site_snapshots
        ORDER BY site_id, timestamp DESC
    `);

    // Get all pepwave devices with latest data
    const devices = await pool.query(`
        SELECT DISTINCT ON (device_name)
            device_name,
            online,
            signal_bar,
            rsrp,
            carrier,
            technology,
            timestamp
        FROM pepwave_snapshots
        ORDER BY device_name, timestamp DESC
    `);

    // Get active/recent maintenance logs with context
    const maintenance = await pool.query(`
        SELECT m.*, j.name AS job_site_name,
               ta.site_name AS trailer_name,
               u.display_name AS assigned_technician_name
        FROM maintenance_logs m
        LEFT JOIN job_sites j ON m.job_site_id = j.id
        LEFT JOIN trailer_assignments ta ON m.site_id = ta.site_id
        LEFT JOIN users u ON m.assigned_technician_id = u.id
        WHERE m.status != 'cancelled'
        ORDER BY m.updated_at DESC
        LIMIT 200
    `);

    // Get all job sites with trailer counts
    const jobSites = await pool.query(`
        SELECT js.*, COUNT(ta.id) AS trailer_count
        FROM job_sites js
        LEFT JOIN trailer_assignments ta ON ta.job_site_id = js.id
        GROUP BY js.id
        ORDER BY js.status, js.name
    `);

    return {
        sites: sites.rows,
        devices: devices.rows,
        maintenance: maintenance.rows,
        jobSites: jobSites.rows,
    };
}

// ============================================================
// Job Sites
// ============================================================

