import { runClustering } from '../clustering.js';
import { assignContactToSite, assignTrailerToJobSite, deleteJobSite, deleteSiteNote, getCompanies, getJobSite, getJobSites, getNoteReaders, getNotesByTrailer, getReplies, getSiteContacts, getSiteNote, getSiteNotes, getTrailerAssignments, getTrailersByJobSite, getUsers, insertAuditLog, insertJobSite, insertNotification, insertSiteNote, markNoteRead, removeContactFromSite, togglePinNote, updateJobSite, updateSiteNote } from '../db.js';
import { sendMentionNotification } from '../email.js';
import { hasVrmData } from '../lib/util.js';
import { requireRole } from '../middleware/auth.js';
import { checkGeofences } from '../services/geofence.js';
import { dbAvailable, geofenceAlerts, pepwaveCache, snapshotCache } from '../state.js';

export function registerJobsitesRoutes(app) {

// GET all job sites with aggregated live metrics
app.get('/api/job-sites', async (req, res) => {
    try {
        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();
        const companies = await getCompanies();
        const companyMap = new Map(companies.map(c => [c.id, c.name]));

        // Group assignments by job_site_id
        const assignmentsByJobSite = new Map();
        for (const a of assignments) {
            if (!assignmentsByJobSite.has(a.job_site_id)) {
                assignmentsByJobSite.set(a.job_site_id, []);
            }
            assignmentsByJobSite.get(a.job_site_id).push(a);
        }

        const result = jobSites.map(js => {
            const trailers = assignmentsByJobSite.get(js.id) || [];
            let totalSoc = 0, socCount = 0, minSoc = Infinity;
            let totalSolar = 0, trailersOnline = 0;
            let netOnline = 0, netTotal = 0;
            let totalDcLoad = 0, alarmCount = 0;
            let worstStatus = 'healthy';

            for (const t of trailers) {
                const snap = snapshotCache.get(t.site_id);
                const pw = pepwaveCache.get(t.site_name);
                const isIc2Only = t.site_id < 0;

                if (isIc2Only) {
                    // IC2-only trailer — count as online if Pepwave is online
                    if (pw?.online) trailersOnline++;
                } else if (snap && hasVrmData(snap)) {
                    trailersOnline++;
                    if (snap.battery_soc != null) {
                        totalSoc += snap.battery_soc;
                        socCount++;
                        if (snap.battery_soc < minSoc) minSoc = snap.battery_soc;
                        if (snap.battery_soc < 20) worstStatus = 'critical';
                        else if (snap.battery_soc < 50 && worstStatus !== 'critical') worstStatus = 'warning';
                    }
                    totalSolar += snap.solar_watts || 0;
                    if (snap.dc_load_watts != null) totalDcLoad += snap.dc_load_watts;
                    if (snap.alarm_reason || snap.error_code) alarmCount++;
                } else if (pw?.online) {
                    // No Cerbo/VRM data but Pepwave is online — not critical
                    trailersOnline++;
                } else if (!snap) {
                    // No VRM snapshot AND no Pepwave connectivity — truly offline
                    if (worstStatus !== 'critical') worstStatus = 'warning';
                }

                if (pw) {
                    netTotal++;
                    if (pw.online) netOnline++;
                }
            }

            return {
                ...js,
                company_name: companyMap.get(js.company_id) || null,
                trailer_count: trailers.length,
                trailers_online: trailersOnline,
                avg_soc: socCount > 0 ? +(totalSoc / socCount).toFixed(1) : null,
                min_soc: minSoc === Infinity ? null : +minSoc.toFixed(1),
                total_solar_watts: +totalSolar.toFixed(0),
                total_dc_load_watts: +totalDcLoad.toFixed(0),
                alarm_count: alarmCount,
                worst_status: trailers.length === 0 ? 'unknown' : worstStatus,
                net_online: netOnline,
                net_total: netTotal,
                trailers: trailers.map(t => {
                    const snap = snapshotCache.get(t.site_id);
                    const pw = pepwaveCache.get(t.site_name);
                    const isIc2Only = t.site_id < 0;
                    const fresh = hasVrmData(snap);
                    return {
                        site_id: t.site_id,
                        site_name: t.site_name,
                        battery_soc: fresh ? (snap?.battery_soc ?? null) : null,
                        solar_watts: fresh ? (snap?.solar_watts ?? null) : null,
                        solar_yield_today: fresh ? (snap?.solar_yield_today ?? null) : null,
                        charge_state: fresh ? (snap?.charge_state ?? null) : null,
                        online: isIc2Only ? (pw?.online ?? false) : (fresh || pw?.online || false),
                        ic2_only: isIc2Only,
                        network_online: pw?.online ?? false,
                        dc_load_watts: fresh ? (snap?.dc_load_watts ?? null) : null,
                        alarm_reason: fresh ? (snap?.alarm_reason ?? null) : null,
                        error_code: fresh ? (snap?.error_code ?? null) : null,
                        inverter_mode: fresh ? (snap?.inverter_mode ?? null) : null,
                        vrm_timestamp: snap?.vrm_timestamp ?? null,
                    };
                }),
            };
        });

        res.json({ success: true, job_sites: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET single job site with full details
app.get('/api/job-sites/:id', async (req, res) => {
    try {
        const jobSite = await getJobSite(parseInt(req.params.id));
        if (!jobSite) return res.status(404).json({ success: false, error: 'Job site not found' });

        const trailers = await getTrailersByJobSite(jobSite.id);
        const enrichedTrailers = trailers.map(t => {
            const snap = snapshotCache.get(t.site_id);
            const pw = pepwaveCache.get(t.site_name);
            const fresh = hasVrmData(snap);
            return {
                ...t,
                snapshot: fresh ? snap : null,
                pepwave: pw || null,
            };
        });

        res.json({ success: true, job_site: { ...jobSite, trailers: enrichedTrailers } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT update job site (rename, address, status, notes)
app.put('/api/job-sites/:id', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const siteId = parseInt(req.params.id);
        const updated = await updateJobSite(siteId, req.body);
        if (!updated) return res.status(404).json({ success: false, error: 'Job site not found' });
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('site', siteId, 'site_updated', { fields: Object.keys(req.body) }, actor).catch(() => { });
        res.json({ success: true, job_site: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE job site (admin only — unassigns trailers, cascades notes)
app.delete('/api/job-sites/:id', requireRole('admin'), async (req, res) => {
    try {
        const siteId = parseInt(req.params.id);
        const deleted = await deleteJobSite(siteId);
        if (!deleted) return res.status(404).json({ success: false, error: 'Job site not found' });
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('site', siteId, 'site_deleted', { name: deleted.name }, actor).catch(() => { });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST new job site
app.post('/api/job-sites', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
        // Sites belong to customers: a company is required (HQ is the exception)
        if (!req.body.company_id && !req.body.is_headquarters) {
            return res.status(400).json({ success: false, error: 'A company is required to create a job site. Add the company first under Companies.' });
        }

        const created = await insertJobSite(req.body);
        if (!created) return res.status(500).json({ success: false, error: 'Could not create job site' });
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('site', created.id, 'site_created', { name: created.name, uid: created.uid }, actor).catch(() => { });
        res.status(201).json({ success: true, job_site: created });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET site notes (paginated, filterable)
app.get('/api/job-sites/:id/notes', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const { search, tag, author } = req.query;
        const result = await getSiteNotes(parseInt(req.params.id), { limit, offset, search, tag, author });
        // Attach read receipts
        const noteIds = result.notes.map(n => n.id);
        const readers = noteIds.length ? await getNoteReaders(noteIds) : {};
        const notes = result.notes.map(n => ({ ...n, readers: readers[n.id] || [] }));
        res.json({ success: true, notes, total: result.total, limit, offset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET replies for a specific note
app.get('/api/job-sites/:id/notes/:noteId/replies', async (req, res) => {
    try {
        const replies = await getReplies(parseInt(req.params.noteId));
        res.json({ success: true, replies });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET notes tagged with a specific trailer
app.get('/api/trailers/:siteId/notes', async (req, res) => {
    try {
        const siteId = parseInt(req.params.siteId);
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const offset = parseInt(req.query.offset) || 0;
        const result = await getNotesByTrailer(siteId, { limit, offset });
        res.json({ success: true, notes: result.notes, total: result.total, limit, offset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST new site note (with @mention notifications + audit log)
app.post('/api/job-sites/:id/notes', async (req, res) => {
    try {
        const { note, mentions, parent_id, tags } = req.body;
        if (!note) return res.status(400).json({ success: false, error: 'Note is required' });
        const author = req.user ? req.user.display_name : 'system';
        const siteId = parseInt(req.params.id);
        const created = await insertSiteNote(siteId, note, author, mentions || [], parent_id || null, tags || []);

        // Audit log
        insertAuditLog('site', siteId, 'note_added', { note_id: created.id, mentions, tags }, author).catch(() => { });

        // Send @mention email notifications (async, don't block response)
        if (mentions && mentions.length > 0) {
            const site = await getJobSite(siteId);
            const allUsers = await getUsers();
            for (const mentionName of mentions) {
                const user = allUsers.find(u =>
                    u.display_name.toLowerCase() === mentionName.toLowerCase()
                );
                if (user && user.email) {
                    sendMentionNotification({
                        recipientEmail: user.email,
                        recipientName: user.display_name,
                        authorName: author,
                        siteName: site?.name || `Site #${siteId}`,
                        noteText: note,
                    }).catch(err => console.error('[Mention] Notification failed:', err.message));
                }
                // In-app notification
                if (user) {
                    insertNotification(
                        user.id,
                        'mention',
                        `${author} mentioned you`,
                        `"${note.length > 80 ? note.slice(0, 80) + '…' : note}" on ${site?.name || `Site #${siteId}`}`,
                        `/sites/${siteId}`
                    ).catch(err => console.error('[Notification] Insert failed:', err.message));
                }
            }
        }

        res.status(201).json({ success: true, note: created });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT edit a site note (author or admin only)
app.put('/api/job-sites/:id/notes/:noteId', async (req, res) => {
    try {
        const noteId = parseInt(req.params.noteId);
        const { note } = req.body;
        if (!note) return res.status(400).json({ success: false, error: 'Note text is required' });
        // Verify ownership: fetch note and check author
        const existing = await getSiteNote(noteId);
        if (!existing) return res.status(404).json({ success: false, error: 'Note not found' });
        const isAuthor = existing.author === req.user?.display_name;
        const isAdmin = req.user?.role === 'admin';
        if (!isAuthor && !isAdmin) return res.status(403).json({ success: false, error: 'Not authorized' });
        const updated = await updateSiteNote(noteId, note);
        insertAuditLog('site', parseInt(req.params.id), 'note_edited', { note_id: noteId }, req.user?.display_name).catch(() => { });
        res.json({ success: true, note: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE a site note (author or admin only)
app.delete('/api/job-sites/:id/notes/:noteId', async (req, res) => {
    try {
        const noteId = parseInt(req.params.noteId);
        const existing = await getSiteNote(noteId);
        if (!existing) return res.status(404).json({ success: false, error: 'Note not found' });
        const isAuthor = existing.author === req.user?.display_name;
        const isAdmin = req.user?.role === 'admin';
        if (!isAuthor && !isAdmin) return res.status(403).json({ success: false, error: 'Not authorized' });
        await deleteSiteNote(noteId);
        insertAuditLog('site', parseInt(req.params.id), 'note_deleted', { note_id: noteId }, req.user?.display_name).catch(() => { });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// PUT toggle pin on a note (admin/tech only)
app.put('/api/job-sites/:id/notes/:noteId/pin', async (req, res) => {
    try {
        const noteId = parseInt(req.params.noteId);
        const { pinned } = req.body;
        const updated = await togglePinNote(noteId, !!pinned);
        res.json({ success: true, note: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST mark note as read
app.post('/api/job-sites/:id/notes/:noteId/read', async (req, res) => {
    try {
        await markNoteRead(parseInt(req.params.noteId), req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Outbound SMS via Twilio
// ============================================================
app.post('/api/job-sites/:id/sms', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { message, to } = req.body;
        if (!message) return res.status(400).json({ success: false, error: 'Message is required' });

        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const fromNumber = process.env.TWILIO_PHONE_NUMBER;
        if (!accountSid || !authToken || !fromNumber) {
            return res.status(503).json({ success: false, error: 'Twilio is not configured (missing SID, token, or phone number)' });
        }

        const siteId = parseInt(req.params.id);
        const site = await getJobSite(siteId);
        if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

        // Determine recipient: explicit `to` param or primary CRM contact phone
        let recipient = to;
        if (!recipient) {
            const siteContacts = await getSiteContacts(siteId);
            const primary = siteContacts.find(c => c.is_primary) || siteContacts[0];
            recipient = primary?.phone;
        }
        if (!recipient) {
            return res.status(400).json({ success: false, error: 'No recipient phone number. Provide `to` or assign a contact with a phone number to this site.' });
        }

        // Send SMS via Twilio REST API (no SDK dependency)
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
        const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        const body = new URLSearchParams({ To: recipient, From: fromNumber, Body: message });

        const twilioRes = await fetch(twilioUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
        });

        const twilioData = await twilioRes.json();
        if (!twilioRes.ok) {
            console.error('[Twilio Outbound] Error:', twilioData);
            return res.status(502).json({ success: false, error: twilioData.message || 'Twilio send failed' });
        }

        // Log outbound SMS as a site note
        const author = req.user ? req.user.display_name : 'system';
        await insertSiteNote(siteId, `SMS sent to ${recipient}: ${message}`, author);

        // Audit log
        insertAuditLog('site', siteId, 'sms_sent', { to: recipient, sid: twilioData.sid }, author).catch(() => { });

        res.json({ success: true, sid: twilioData.sid, to: recipient });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Site-Contact Assignments API
// ============================================================
app.get('/api/job-sites/:id/contacts', async (req, res) => {
    try {
        const contacts = await getSiteContacts(parseInt(req.params.id));
        res.json({ success: true, contacts });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/job-sites/:id/contacts', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { contact_id, role } = req.body;
        if (!contact_id) return res.status(400).json({ success: false, error: 'contact_id is required' });
        const result = await assignContactToSite(parseInt(req.params.id), contact_id, role || 'on-site');
        res.status(201).json({ success: true, assignment: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/job-sites/:siteId/contacts/:contactId', requireRole('admin', 'technician'), async (req, res) => {
    try {
        await removeContactFromSite(parseInt(req.params.siteId), parseInt(req.params.contactId));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST manually assign a trailer to a job site
app.post('/api/job-sites/:id/assign', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { site_id } = req.body;
        if (!site_id) return res.status(400).json({ success: false, error: 'site_id required' });

        const result = await assignTrailerToJobSite(site_id, parseInt(req.params.id), true);
        if (!result) return res.status(404).json({ success: false, error: 'Trailer assignment not found' });
        res.json({ success: true, assignment: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST force reclustering
app.post('/api/job-sites/recluster', requireRole('admin'), async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: false, error: 'Database not connected' });
        }
        const threshold = parseInt(req.body?.threshold) || 200;
        const result = await runClustering(threshold);
        // Clear stale geofence alerts — assignments/coordinates may have changed
        geofenceAlerts.clear();
        checkGeofences().catch(err => console.error('  Post-recluster geofence check failed:', err.message));
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

}
