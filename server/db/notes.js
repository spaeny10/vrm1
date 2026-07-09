import { pool } from './core.js';

export async function getSiteNotes(jobSiteId, { limit = 50, offset = 0, search, tag, author } = {}) {
    if (!pool) return { notes: [], total: 0 };
    const conditions = ['sn.job_site_id = $1', 'sn.parent_id IS NULL'];
    const params = [jobSiteId];
    let paramIdx = 2;
    if (search) {
        conditions.push(`sn.note ILIKE $${paramIdx++}`);
        params.push(`%${search}%`);
    }
    if (tag) {
        conditions.push(`sn.tags @> $${paramIdx++}::jsonb`);
        params.push(JSON.stringify([{ label: tag }]));
    }
    if (author) {
        conditions.push(`sn.author = $${paramIdx++}`);
        params.push(author);
    }
    const where = 'WHERE ' + conditions.join(' AND ');
    const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM site_notes sn ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);
    const dataParams = [...params, limit, offset];
    const result = await pool.query(
        `SELECT sn.*, (SELECT COUNT(*) FROM site_notes r WHERE r.parent_id = sn.id) as reply_count
         FROM site_notes sn
         ${where}
         ORDER BY sn.pinned DESC NULLS LAST, sn.created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        dataParams
    );
    return { notes: result.rows, total };
}

export async function getReplies(noteId) {
    if (!pool) return [];
    const result = await pool.query(
        'SELECT * FROM site_notes WHERE parent_id = $1 ORDER BY created_at ASC',
        [noteId]
    );
    return result.rows;
}

export async function getAllSiteNotes({ limit = 100, offset = 0, siteId, author, search, dateFrom, dateTo } = {}) {
    if (!pool) return { notes: [], total: 0 };
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (siteId) {
        conditions.push(`sn.job_site_id = $${paramIdx++}`);
        params.push(siteId);
    }
    if (author) {
        conditions.push(`sn.author ILIKE $${paramIdx++}`);
        params.push(`%${author}%`);
    }
    if (search) {
        conditions.push(`sn.note ILIKE $${paramIdx++}`);
        params.push(`%${search}%`);
    }
    if (dateFrom) {
        conditions.push(`sn.created_at >= $${paramIdx++}`);
        params.push(dateFrom);
    }
    if (dateTo) {
        conditions.push(`sn.created_at <= $${paramIdx++}`);
        params.push(dateTo);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM site_notes sn ${where}`, params
    );
    const total = parseInt(countResult.rows[0].total);

    const dataParams = [...params, limit, offset];
    const result = await pool.query(
        `SELECT sn.*, js.name as site_name, js.address as site_address
         FROM site_notes sn
         LEFT JOIN job_sites js ON sn.job_site_id = js.id
         ${where}
         ORDER BY sn.created_at DESC
         LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
        dataParams
    );
    return { notes: result.rows, total };
}

export async function getSiteNote(noteId) {
    if (!pool) return null;
    const result = await pool.query('SELECT * FROM site_notes WHERE id = $1', [noteId]);
    return result.rows[0] || null;
}

export async function insertSiteNote(jobSiteId, noteText, author = 'system', mentions = [], parentId = null, tags = []) {
    if (!pool) return null;
    const result = await pool.query(
        `INSERT INTO site_notes (job_site_id, note, author, mentions, parent_id, tags, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [jobSiteId, noteText, author, JSON.stringify(mentions), parentId, JSON.stringify(tags), Date.now()]
    );
    return result.rows[0];
}

export async function updateSiteNote(noteId, newText) {
    if (!pool) return null;
    const result = await pool.query(
        `UPDATE site_notes SET note = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
        [newText, Date.now(), noteId]
    );
    return result.rows[0];
}

export async function deleteSiteNote(noteId) {
    if (!pool) return;
    await pool.query('DELETE FROM site_notes WHERE id = $1', [noteId]);
}

export async function togglePinNote(noteId, pinned) {
    if (!pool) return null;
    const result = await pool.query(
        'UPDATE site_notes SET pinned = $1 WHERE id = $2 RETURNING *',
        [pinned, noteId]
    );
    return result.rows[0];
}

export async function markNoteRead(noteId, userId) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO note_reads (note_id, user_id, read_at) VALUES ($1, $2, $3)
         ON CONFLICT (note_id, user_id) DO NOTHING`,
        [noteId, userId, Date.now()]
    );
}

export async function getNoteReaders(noteIds) {
    if (!pool || !noteIds.length) return {};
    const result = await pool.query(
        `SELECT nr.note_id, nr.read_at, u.id as user_id, u.display_name
         FROM note_reads nr
         JOIN users u ON u.id = nr.user_id
         WHERE nr.note_id = ANY($1)
         ORDER BY nr.read_at ASC`,
        [noteIds]
    );
    const grouped = {};
    for (const row of result.rows) {
        if (!grouped[row.note_id]) grouped[row.note_id] = [];
        grouped[row.note_id].push({ user_id: row.user_id, display_name: row.display_name, read_at: row.read_at });
    }
    return grouped;
}

export async function getNotesByTrailer(siteId, { limit = 20, offset = 0 } = {}) {
    if (!pool) return { notes: [], total: 0 };
    const tagFilter = `EXISTS (
        SELECT 1 FROM jsonb_array_elements(sn.tags) tag
        WHERE tag->>'type' = 'trailer' AND (tag->>'id')::integer = $1
    ) AND sn.parent_id IS NULL`;
    const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM site_notes sn WHERE ${tagFilter}`,
        [siteId]
    );
    const total = parseInt(countResult.rows[0].total);
    const result = await pool.query(
        `SELECT sn.*, js.name as job_site_name,
                (SELECT COUNT(*) FROM site_notes r WHERE r.parent_id = sn.id) as reply_count
         FROM site_notes sn
         LEFT JOIN job_sites js ON sn.job_site_id = js.id
         WHERE ${tagFilter}
         ORDER BY sn.created_at DESC LIMIT $2 OFFSET $3`,
        [siteId, limit, offset]
    );
    return { notes: result.rows, total };
}

// ============================================================
// Companies
// ============================================================
