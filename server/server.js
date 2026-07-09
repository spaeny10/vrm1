import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
    initDb, insertSnapshot, getHistory, getLatestSnapshots,
    getRetentionDays, setRetentionDays, getSetting, setSetting, pruneOldData, getDbStats,
    insertPepwaveSnapshot, getPepwaveHistory, getPepwaveDailyUsage,
    upsertEmbedding, semanticSearch, getEmbeddingStats, getAllContentForEmbedding,
    getJobSites, getJobSite, getJobSiteByPhone, insertJobSite, updateJobSite, deleteJobSite,
    getSiteNotes, getSiteNote, insertSiteNote, updateSiteNote, deleteSiteNote, getAllSiteNotes, getReplies, getNotesByTrailer,
    togglePinNote, markNoteRead, getNoteReaders,
    insertAuditLog, getAuditLog,
    getCompanies, getCompany, insertCompany, updateCompany,
    getContacts, insertContact, updateContact, deleteContact,
    getContactById, getContactSiteIds, setContactPortalUserId,
    getSiteContacts, assignContactToSite, removeContactFromSite,
    insertNotification, getUserNotifications, getUnreadNotificationCount, markNotificationRead, markAllNotificationsRead,
    getTrailerAssignments, getTrailersByJobSite, upsertTrailerAssignment, linkIc2Device,
    assignTrailerToJobSite, getTrailersWithGps,
    getMaintenanceLogs, getMaintenanceLog, insertMaintenanceLog,
    updateMaintenanceLog, deleteMaintenanceLog, getMaintenanceStats, getMaintenanceCostsByJobSite,
    getUpcomingMaintenance,
    getComponents, insertComponent, updateComponent,
    computeDailyMetrics, getFleetAnalyticsSummary, getJobSiteRankings,
    getAnalyticsByJobSite, getAnalyticsByTrailer, getAnalyticsDateRange,
    upsertDailyEnergy, getAllDailyEnergy,
    insertAlertHistory, resolveAlert, getActiveAlerts, getAlertHistory,
    getBatteryHistory,
    createUser, getUserByUsername, getUserById, getUsers, updateUser, deleteUser,
    getUserByGoogleId, getUserByEmail, createGoogleUser,
    getAcknowledgedActions, acknowledgeAction as dbAcknowledgeAction, unacknowledgeAction as dbUnacknowledgeAction,
    getChecklistTemplates, insertChecklistTemplate, updateChecklistTemplate,
    getCompletedChecklists, insertCompletedChecklist,
    getIssueTemplates, insertIssueTemplate, updateIssueTemplate,
    getMaintenanceCalendar,
    getCustomerSiteAccess, upsertCustomerSiteAccess,
    updateTrailerGps, getGpsSuggestions, updateGpsSuggestionStatus, getPool,
    getTrailers, getTrailer, insertTrailer, updateTrailer,
    getRentals, getRental, insertRental, updateRental,
    insertRentalEvent, getRentalEvents,
    getBillingPastCalloff, getBillingAtHeadquarters, getUnbilledDeployedTrailers,
    getRateCards, getVolumeTiers, getCompanyRentalWindows,
} from './db.js';
import { computeCharges, computeRollback, buildTierCounter, parseDateUTC, TERM_DAYS } from './pricing.js';
import {
    generateQueryEmbedding, embedSiteSnapshots, embedPepwaveDevices,
    embedAlerts, embedMaintenanceLogs, embedJobSites,
    isConfigured as isEmbeddingsConfigured
} from './embeddings.js';
import { runClustering, haversineMeters } from './clustering.js';
import {
    isEmailConfigured, sendAlertEmail, sendAlertResolvedEmail,
    sendGeofenceEmail, sendDigestEmail, checkRateLimit, markNotified,
    sendMentionNotification
} from './email.js';
import cron from 'node-cron';
import {
    PORT, VRM_TOKEN, VRM_USER_ID, VRM_BASE,
    IC2_CLIENT_ID, IC2_CLIENT_SECRET, IC2_BASE, IC2_ORG_ID, IC2_GROUP_ID,
    anthropic, JWT_SECRET, JWT_EXPIRES_IN, GOOGLE_CLIENT_ID, ALLOWED_GOOGLE_DOMAIN,
    allowedOrigins, SITES_CACHE_TTL, WEATHER_CACHE_TTL, VRM_STALE_MS,
    TRAILER_SPECS, SOLAR_SCORE_DEFAULTS,
} from './config.js';
import {
    snapshotCache, pepwaveCache, ic2DeviceIdToSiteId, ic2DeviceIdToName,
    gpsCache, trailerJobSiteMap, socStartOfDay, consumptionAccumulator,
    dailyEnergy, weatherCache, offlineTimestamps, geofenceAlerts,
    solarScoreConfig,
    dbAvailable, setDbAvailable, pgvectorAvailable, setPgvectorAvailable,
    dbPool, setDbPool, sitesCache, sitesCacheTime, setSitesCache,
    lastIc2Poll, setLastIc2Poll, bandwidthLoggedOnce, setBandwidthLoggedOnce,
} from './state.js';
import { authMiddleware, requireRole, apiAuthGate, loginLimiter, aiLimiter } from './middleware/auth.js';
import { vrmFetch, extractDiagValue, extractVrmTimestamp } from './services/vrmClient.js';
import { getIc2Token, ic2Fetch, extractCellularInfo, extractWanInterfaces } from './services/ic2Client.js';
import { hasVrmData, todayStr, extractMpptState, mpptStateToString, getPepwaveForTrailer } from './lib/util.js';
import { fetchSolarIrradiance, computeAstronomicalPSH } from './services/weather.js';
import { loadSolarScoreConfig, computeTrailerIntelligence, computeHealthGrade, computeTechStatus, computeSocTrend } from './services/intelligence.js';
import { updateDailyEnergy, seedDailyEnergyFromDb } from './services/energy.js';
import { refreshTrailerJobSiteMap, computeAlerts, isRealDeficit, persistAlertHistory } from './services/alerts.js';
import { checkGeofences, detectGpsChanges } from './services/geofence.js';
import { computeYesterdayMetrics } from './services/analyticsJobs.js';
import { generateEmbeddingsAsync } from './services/embeddingsJob.js';
import {
    RATE_PERIOD_DAYS, RENTAL_TRANSITIONS, billingDays, computeAccrued, computeAccruedThisMonth,
    buildPricingContext, rentalRateCard, priceRental, computeMtdEngine,
} from './services/billing.js';
import { pollAllSites } from './services/vrmPoller.js';
import { resolveIc2DeviceToSiteId, pollIc2Devices } from './services/ic2Poller.js';
import { buildDigestData, scheduleDigest } from './services/digest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? allowedOrigins : true,
    credentials: true,
}));
app.use(express.json());

// --- In production, serve the built React frontend ---
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));

// Trust first proxy (Railway) so express-rate-limit reads X-Forwarded-For correctly
app.set('trust proxy', 1);

// Apply auth to all /api routes except login
app.use('/api', apiAuthGate);

// Health check (unauthenticated, for Railway/uptime monitors)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        db: dbAvailable ? 'connected' : 'disconnected',
        trailers_cached: snapshotCache.size,
    });
});


// --- Caches live in state.js (shared across modules) ---


/**
 * Extract MPPT charge state from snapshot, normalized to numeric value.
 * Returns: 0=Off, 1=Low power, 2=Fault, 3=Bulk, 4=Absorption, 5=Float, 6=Storage, 7=Equalize, 252=External
 */


// ============================================================
// Offline device duration tracking
// ============================================================


/**
 * Determines if a day's deficit represents a real energy problem or MPPT throttling.
 *
 * Thresholds (user-specified):
 * - SOC ≥88% (high battery)
 * - MPPT state: Float (5) or Storage (6)
 * - Deficit <1 kWh (1000 Wh)
 *
 * @returns {Object} { real: boolean, reason: string|null, details: string|null }
 */

/**
 * Convert MPPT charge state numeric code to human-readable string.
 */


// ============================================================
// IC2 device resolution helpers
// ============================================================

/**
 * Resolve an IC2 device to a site_id.
 * Priority: 1) stored ic2_device_id linkage, 2) name match to VRM, 3) synthetic -dev.id
 */

/**
 * Look up pepwave data for a trailer, trying name first then IC2 device ID.
 */


// ============================================================
// Auth & User Management Routes
// ============================================================

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        const user = await getUserByUsername(username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        await updateUser(user.id, { last_login: Date.now() });
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );
        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/me', async (req, res) => {
    try {
        const user = await getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/change-password', async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        if (!current_password || !new_password) {
            return res.status(400).json({ error: 'Current and new password required' });
        }
        if (new_password.length < 4) {
            return res.status(400).json({ error: 'Password must be at least 4 characters' });
        }
        const user = await getUserByUsername(req.user.username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const valid = await bcrypt.compare(current_password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        const hash = await bcrypt.hash(new_password, 10);
        await updateUser(req.user.id, { password_hash: hash });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update own profile (display name)
app.put('/api/auth/profile', async (req, res) => {
    try {
        const { display_name } = req.body;
        if (!display_name || !display_name.trim()) {
            return res.status(400).json({ error: 'Display name is required' });
        }
        await updateUser(req.user.id, { display_name: display_name.trim() });
        const updated = await getUserById(req.user.id);
        res.json({ success: true, user: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Google SSO authentication
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) {
            return res.status(400).json({ error: 'Google credential required' });
        }
        if (!GOOGLE_CLIENT_ID) {
            return res.status(500).json({ error: 'Google SSO not configured on server' });
        }

        // Verify the Google ID token
        const { OAuth2Client } = await import('google-auth-library');
        const client = new OAuth2Client(GOOGLE_CLIENT_ID);
        const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();

        const { sub: googleId, email, name, hd } = payload;

        // Restrict to allowed domain
        if (hd !== ALLOWED_GOOGLE_DOMAIN) {
            return res.status(403).json({ error: `Only @${ALLOWED_GOOGLE_DOMAIN} accounts are allowed` });
        }

        // Check if user already exists by Google ID
        let user = await getUserByGoogleId(googleId);

        if (!user) {
            // Check if there's an existing user with same email (link accounts)
            user = await getUserByEmail(email);
            if (user) {
                // Link Google ID to existing account
                await updateUser(user.id, { google_id: googleId, email });
                user = await getUserById(user.id);
            } else {
                // Auto-create new user with viewer role
                user = await createGoogleUser(googleId, email, name || email.split('@')[0], 'viewer');
            }
        }

        if (!user.active) {
            return res.status(403).json({ error: 'Account is deactivated' });
        }

        await updateUser(user.id, { last_login: Date.now() });

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        });
    } catch (err) {
        console.error('Google auth error:', err.message);
        res.status(401).json({ error: 'Google authentication failed' });
    }
});

// User management (admin only)

app.get('/api/users', requireRole('admin'), async (req, res) => {
    try {
        const users = await getUsers();
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
    try {
        const { username, password, display_name, role } = req.body;
        if (!username || !password || !display_name) {
            return res.status(400).json({ error: 'Username, password, and display name required' });
        }
        if (!['admin', 'technician', 'viewer'].includes(role || 'viewer')) {
            return res.status(400).json({ error: 'Invalid role' });
        }
        const hash = await bcrypt.hash(password, 10);
        const user = await createUser(username, hash, display_name, role || 'viewer');
        res.json({ success: true, user });
    } catch (err) {
        if (err.message?.includes('unique') || err.code === '23505') {
            return res.status(409).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:id', requireRole('admin'), async (req, res) => {
    try {
        const { display_name, role, active, digest_enabled } = req.body;
        const updates = {};
        if (display_name !== undefined) updates.display_name = display_name;
        if (role !== undefined) updates.role = role;
        if (active !== undefined) updates.active = active;
        if (digest_enabled !== undefined) updates.digest_enabled = digest_enabled;
        const user = await updateUser(parseInt(req.params.id), updates);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
    try {
        if (parseInt(req.params.id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot deactivate your own account' });
        }
        await deleteUser(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users/:id/reset-password', requireRole('admin'), async (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 4) {
            return res.status(400).json({ error: 'Password must be at least 4 characters' });
        }
        const hash = await bcrypt.hash(new_password, 10);
        const user = await updateUser(parseInt(req.params.id), { password_hash: hash });
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- API routes ---

app.get('/api/sites', async (req, res) => {
    try {
        if (!sitesCache || Date.now() - sitesCacheTime >= SITES_CACHE_TTL) {
            const data = await vrmFetch(`/users/${VRM_USER_ID}/installations`);
            setSitesCache(data);
        }
        // Augment with IC2-only devices (those without VRM)
        const vrmNames = new Set((sitesCache.records || []).map(r => r.name));
        const ic2Only = [];
        for (const [name, dev] of pepwaveCache.entries()) {
            if (!vrmNames.has(name)) {
                ic2Only.push({
                    idSite: -dev.id,
                    name: name,
                    identifier: name,
                    ic2_only: true,
                });
            }
        }
        const augmented = {
            ...sitesCache,
            records: [...(sitesCache.records || []), ...ic2Only],
        };
        res.json(augmented);
    } catch (err) {
        console.error('Error fetching sites:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sites/:id/diagnostics', async (req, res) => {
    try {
        const data = await vrmFetch(`/installations/${req.params.id}/diagnostics?count=200`);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sites/:id/alarms', async (req, res) => {
    try {
        const data = await vrmFetch(`/installations/${req.params.id}/alarms?count=50`);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sites/:id/system', async (req, res) => {
    try {
        const data = await vrmFetch(`/installations/${req.params.id}/system-overview`);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sites/:id/stats', async (req, res) => {
    try {
        const { start, end } = req.query;
        const data = await vrmFetch(
            `/installations/${req.params.id}/stats?start=${start}&end=${end}&type=live_feed&attributeCodes[]=bs&attributeCodes[]=bv&attributeCodes[]=Pdc&attributeCodes[]=total_solar_yield`
        );
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/history/:id', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: true, records: [] });
        }
        const { start, end } = req.query;
        const rows = await getHistory(
            parseInt(req.params.id),
            parseInt(start) || 0,
            parseInt(end) || Date.now()
        );
        res.json({ success: true, records: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Latest snapshots
app.get('/api/fleet/latest', async (req, res) => {
    try {
        if (dbAvailable) {
            const rows = await getLatestSnapshots();
            if (rows.length > 0) {
                return res.json({ success: true, records: rows });
            }
        }
        const records = Array.from(snapshotCache.values());
        res.json({ success: true, records });
    } catch (err) {
        const records = Array.from(snapshotCache.values());
        res.json({ success: true, records });
    }
});

// Fleet energy
app.get('/api/fleet/energy', (req, res) => {
    const result = [];
    for (const [siteId, days] of dailyEnergy.entries()) {
        const siteName = Object.values(days)[0]?.site_name || `Site ${siteId}`;
        const dailyData = Object.entries(days)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, info]) => ({
                date,
                yield_wh: info.yield_wh,
                consumed_wh: info.consumed_wh,
                consumption_source: info.consumption_source || null,
            }));
        result.push({ site_id: siteId, site_name: siteName, days: dailyData });
    }
    result.sort((a, b) => a.site_name.localeCompare(b.site_name, undefined, { numeric: true }));
    res.json({ success: true, records: result });
});

// Fleet alerts
app.get('/api/fleet/alerts', (req, res) => {
    const alerts = computeAlerts();
    res.json({ success: true, alerts });
});

// Alert history
app.get('/api/alerts/history', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const history = await getAlertHistory(days);
        res.json({ success: true, alerts: history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Fleet network: Pepwave device data
// ============================================================
app.get('/api/fleet/network', (req, res) => {
    const records = Array.from(pepwaveCache.values()).map(r => ({
        ...r,
        offline_since: offlineTimestamps.get(r.name) || null,
    }));
    records.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    res.json({
        success: true,
        records,
        last_poll: lastIc2Poll,
        device_count: records.length,
    });
});


// Debug: check bandwidth data source for a specific device
app.get('/api/debug/bandwidth', (req, res) => {
    const sample = Array.from(pepwaveCache.values()).slice(0, 3).map(r => ({
        name: r.name, id: r.id, usage_mb: r.usage_mb, tx_mb: r.tx_mb, rx_mb: r.rx_mb,
    }));
    res.json({ sample, cache_size: pepwaveCache.size });
});

app.get('/api/fleet/network/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const device = pepwaveCache.get(name);
    if (!device) {
        return res.status(404).json({ error: 'Device not found' });
    }
    res.json({ success: true, data: device });
});

// ============================================================
// Fleet combined: VRM snapshots + Pepwave data merged by name
// ============================================================
app.get('/api/fleet/combined', (req, res) => {
    // Build a pepwave lookup by device name
    const pepwaveMap = {};
    for (const [name, device] of pepwaveCache.entries()) {
        pepwaveMap[name] = {
            online: device.online,
            status: device.status,
            signal_bar: device.cellular?.signal_bar ?? null,
            rsrp: device.cellular?.signal?.rsrp ?? null,
            carrier: device.cellular?.carrier || null,
            technology: device.cellular?.technology || null,
            client_count: device.client_count || 0,
            usage_mb: device.usage_mb || 0,
            uptime: device.uptime || 0,
            model: device.model,
            wan_ip: device.wan_ip,
        };
    }
    res.json({ success: true, pepwave: pepwaveMap, last_poll: lastIc2Poll });
});

// Pepwave device history (time-series)
app.get('/api/fleet/network/:name/history', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: true, records: [] });
        }
        const name = decodeURIComponent(req.params.name);
        const { start, end } = req.query;
        const rows = await getPepwaveHistory(
            name,
            parseInt(start) || 0,
            parseInt(end) || Date.now()
        );
        res.json({ success: true, records: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Pepwave daily usage aggregation
app.get('/api/fleet/network/:name/daily', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: true, records: [] });
        }
        const name = decodeURIComponent(req.params.name);
        const days = parseInt(req.query.days) || 30;
        const rows = await getPepwaveDailyUsage(name, days);
        res.json({ success: true, records: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Settings
app.get('/api/settings', async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({
                retention_days: 90,
                db_size_bytes: 0,
                snapshot_count: snapshotCache.size,
                db_status: 'disconnected',
            });
        }
        const stats = await getDbStats();
        res.json({
            retention_days: await getRetentionDays(),
            db_size_bytes: stats.size,
            snapshot_count: stats.count,
            db_status: 'connected',
            solar_score_config: { ...solarScoreConfig },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/settings/solar-score', requireRole('admin'), async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: false, error: 'Database not connected' });
        }
        const validKeys = Object.keys(SOLAR_SCORE_DEFAULTS);
        const updates = {};
        for (const key of validKeys) {
            if (req.body[key] !== undefined) {
                const val = parseFloat(req.body[key]);
                if (isNaN(val) || val < 0 || val > 100) {
                    return res.status(400).json({ error: `Invalid value for ${key}: must be 0-100` });
                }
                updates[key] = val;
            }
        }
        for (const [key, val] of Object.entries(updates)) {
            await setSetting(`solar_${key}`, val);
            solarScoreConfig[key] = val;
        }
        res.json({ success: true, solar_score_config: { ...solarScoreConfig } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/settings', requireRole('admin'), async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: false, error: 'Database not connected' });
        }
        const { retention_days } = req.body;
        if (retention_days) {
            await setRetentionDays(parseInt(retention_days, 10));
        }
        res.json({ success: true, retention_days: await getRetentionDays() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/purge', requireRole('admin'), async (req, res) => {
    try {
        if (!dbAvailable) {
            return res.json({ success: false, error: 'Database not connected' });
        }
        await pruneOldData();
        const stats = await getDbStats();
        res.json({
            success: true,
            db_size_bytes: stats.size,
            snapshot_count: stats.count,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Fleet Deployment Summary
// ============================================================

app.get('/api/fleet/deployment', async (req, res) => {
    try {
        // Prefer explicit rental records (commercial truth) when they exist
        const openRentals = dbAvailable ? await getRentals({ open: true }) : [];
        if (openRentals.length > 0) {
            const trailers = await getTrailers();
            const billingSites = new Set(), standbySites = new Set(), pickupSites = new Set();
            let billingTrailers = 0, standbyTrailers = 0, pickupTrailers = 0;

            for (const r of openRentals) {
                // called_off keeps accruing until billing is explicitly stopped
                if (r.status === 'billing' || r.status === 'called_off') {
                    billingTrailers++;
                    if (r.job_site_id) billingSites.add(r.job_site_id);
                } else if (r.status === 'delivered') {
                    standbyTrailers++;
                    if (r.job_site_id) standbySites.add(r.job_site_id);
                } else if (r.status === 'awaiting_pickup') {
                    pickupTrailers++;
                    if (r.job_site_id) pickupSites.add(r.job_site_id);
                }
            }

            const availableTrailers = trailers.filter(t => t.status === 'available').length;

            return res.json({
                success: true,
                source: 'rentals',
                active_billing: { sites: billingSites.size, trailers: billingTrailers },
                standby: { sites: standbySites.size, trailers: standbyTrailers },
                available_at_hq: { trailers: availableTrailers },
                awaiting_pickup: { sites: pickupSites.size, trailers: pickupTrailers },
                total_deployed: { sites: billingSites.size + standbySites.size, trailers: billingTrailers + standbyTrailers },
            });
        }

        // Legacy fallback: infer from job site status
        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

        const assignmentsByJobSite = new Map();
        for (const a of assignments) {
            if (!assignmentsByJobSite.has(a.job_site_id)) {
                assignmentsByJobSite.set(a.job_site_id, []);
            }
            assignmentsByJobSite.get(a.job_site_id).push(a);
        }

        let activeBillingSites = 0, activeBillingTrailers = 0;
        let standbySites = 0, standbyTrailers = 0;
        let hqTrailers = 0;
        let awaitingPickupSites = 0, awaitingPickupTrailers = 0;

        for (const js of jobSites) {
            const trailerCount = (assignmentsByJobSite.get(js.id) || []).length;

            if (js.is_headquarters) {
                hqTrailers += trailerCount;
                continue;
            }

            if (js.status === 'active') {
                activeBillingSites++;
                activeBillingTrailers += trailerCount;
            } else if (js.status === 'standby') {
                standbySites++;
                standbyTrailers += trailerCount;
            } else if (js.status === 'completed') {
                // Completed but not yet picked up
                if (!js.pickup_date || new Date(js.pickup_date) >= new Date(new Date().toDateString())) {
                    awaitingPickupSites++;
                    awaitingPickupTrailers += trailerCount;
                }
            }
        }

        res.json({
            success: true,
            source: 'job_site_status',
            active_billing: { sites: activeBillingSites, trailers: activeBillingTrailers },
            standby: { sites: standbySites, trailers: standbyTrailers },
            available_at_hq: { trailers: hqTrailers },
            awaiting_pickup: { sites: awaitingPickupSites, trailers: awaitingPickupTrailers },
            total_deployed: { sites: activeBillingSites + standbySites, trailers: activeBillingTrailers + standbyTrailers },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Trailers (rental fleet assets)
// ============================================================

app.get('/api/trailers', async (req, res) => {
    try {
        const trailers = await getTrailers({ status: req.query.status });
        res.json({ success: true, trailers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trailers', requireRole('admin', 'technician'), async (req, res) => {
    try {
        if (!req.body.unit_number) return res.status(400).json({ success: false, error: 'unit_number is required' });
        const created = await insertTrailer(req.body);
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('trailer', created.id, 'trailer_created', { unit_number: created.unit_number }, actor).catch(() => { });
        res.status(201).json({ success: true, trailer: created });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, error: 'A trailer with that unit number or VRM site already exists' });
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/trailers/:id', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const updated = await updateTrailer(parseInt(req.params.id), req.body);
        if (!updated) return res.status(404).json({ success: false, error: 'Trailer not found' });
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('trailer', updated.id, 'trailer_updated', { fields: Object.keys(req.body) }, actor).catch(() => { });
        res.json({ success: true, trailer: updated });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, error: 'A trailer with that unit number or VRM site already exists' });
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Rentals & Billing
// ============================================================


// ---- Rate-card pricing context (FY2026 commercial structure) ----


app.get('/api/rentals', async (req, res) => {
    try {
        const rentals = await getRentals({
            status: req.query.status,
            trailerId: req.query.trailer_id ? parseInt(req.query.trailer_id) : undefined,
            jobSiteId: req.query.job_site_id ? parseInt(req.query.job_site_id) : undefined,
            companyId: req.query.company_id ? parseInt(req.query.company_id) : undefined,
            open: req.query.open === '1' || req.query.open === 'true',
        });
        const ctx = await buildPricingContext();
        res.json({ success: true, rentals: rentals.map(r => priceRental(r, ctx)) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/rentals/:id', async (req, res) => {
    try {
        const rental = await getRental(parseInt(req.params.id));
        if (!rental) return res.status(404).json({ success: false, error: 'Rental not found' });
        const events = await getRentalEvents(rental.id);
        const ctx = await buildPricingContext();
        res.json({ success: true, rental: priceRental(rental, ctx), events });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Rate card matrix + EA tiers (for UI display and reference)
app.get('/api/pricing/rate-cards', async (req, res) => {
    try {
        const [rateCards, tiers] = await Promise.all([getRateCards(req.query.product), getVolumeTiers()]);
        res.json({ success: true, rate_cards: rateCards, volume_tiers: tiers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/rentals', requireRole('admin', 'technician'), async (req, res) => {
    try {
        if (!req.body.trailer_id) return res.status(400).json({ success: false, error: 'trailer_id is required' });
        const trailer = await getTrailer(parseInt(req.body.trailer_id));
        if (!trailer) return res.status(404).json({ success: false, error: 'Trailer not found' });
        if (trailer.status === 'retired') return res.status(400).json({ success: false, error: 'Cannot rent a retired trailer' });

        const created = await insertRental(req.body);
        await updateTrailer(trailer.id, { status: 'reserved' });
        const actor = req.user ? req.user.display_name : 'system';
        await insertRentalEvent(created.id, 'reserved', created.reserved_at, actor, req.body.notes || null);
        insertAuditLog('rental', created.id, 'rental_created', { trailer: trailer.unit_number, job_site_id: created.job_site_id }, actor).catch(() => { });
        res.status(201).json({ success: true, rental: created });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, error: 'This trailer already has an open rental' });
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/rentals/:id', requireRole('admin', 'technician'), async (req, res) => {
    try {
        // Status changes must go through the lifecycle event endpoint
        const { status, ...updates } = req.body;
        const updated = await updateRental(parseInt(req.params.id), updates);
        if (!updated) return res.status(404).json({ success: false, error: 'Rental not found' });
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('rental', updated.id, 'rental_updated', { fields: Object.keys(updates) }, actor).catch(() => { });
        res.json({ success: true, rental: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


app.post('/api/rentals/:id/events', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { event_type, event_date, notes } = req.body;
        const transition = RENTAL_TRANSITIONS[event_type];
        if (!transition) {
            return res.status(400).json({ success: false, error: `Unknown event_type. Valid: ${Object.keys(RENTAL_TRANSITIONS).join(', ')}` });
        }

        const rental = await getRental(parseInt(req.params.id));
        if (!rental) return res.status(404).json({ success: false, error: 'Rental not found' });
        if (!transition.from.includes(rental.status)) {
            return res.status(409).json({ success: false, error: `Cannot ${event_type} a rental in '${rental.status}' status` });
        }

        // Billing can't stop before it started
        const date = event_date || new Date().toISOString().slice(0, 10);
        if (event_type === 'stop_billing' && rental.billing_start && new Date(date) < new Date(rental.billing_start)) {
            return res.status(400).json({ success: false, error: 'billing_stop cannot be before billing_start' });
        }

        const updates = { status: transition.toStatus };
        if (transition.dateField) updates[transition.dateField] = date;
        const updated = await updateRental(rental.id, updates);

        if (transition.trailerStatus) {
            await updateTrailer(rental.trailer_id, { status: transition.trailerStatus });
        }

        const actor = req.user ? req.user.display_name : 'system';
        const event = await insertRentalEvent(rental.id, event_type, date, actor, notes || null);
        insertAuditLog('rental', rental.id, `rental_${event_type}`, { trailer: rental.unit_number, date }, actor).catch(() => { });

        // Roll-Back clause: stopping billing before a 6-month/1-year commitment
        // is fulfilled retroactively re-prices the utilized period at the
        // shorter-term bracket. Only applies to rate-card pricing.
        let rollback = null;
        let merged = { ...rental, ...updated };
        if (event_type === 'stop_billing' && !rental.rate_amount && TERM_DAYS[rental.commitment_term] && rental.billing_start) {
            const ctx = await buildPricingContext();
            const cardsByTerm = ctx.cardsByProductTerm[rental.product_code || 'BV1305'] || {};
            rollback = computeRollback({
                billingStart: parseDateUTC(rental.billing_start),
                billingStop: parseDateUTC(date),
                term: rental.commitment_term,
                rateCardsByTerm: cardsByTerm,
                tiers: ctx.tiers,
                countAt: buildTierCounter(ctx.windows, rental.company_id),
            });
            if (rollback && rollback.adjustment > 0) {
                await updateRental(rental.id, { rollback_amount: rollback.adjustment });
                merged.rollback_amount = rollback.adjustment;
                await insertRentalEvent(
                    rental.id, 'rollback_adjustment', date, actor,
                    `Early termination of ${rental.commitment_term} commitment after ${rollback.utilized_days} days — re-priced at ${rollback.rollback_term} bracket: +$${rollback.adjustment.toFixed(2)}`
                );
                insertAuditLog('rental', rental.id, 'rental_rollback_adjustment', { trailer: rental.unit_number, ...rollback }, actor).catch(() => { });
            }
        }

        const ctx = await buildPricingContext();
        res.json({ success: true, rental: priceRental(merged, ctx), event, rollback });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Billing dashboard summary
app.get('/api/billing/summary', async (req, res) => {
    try {
        const openRentals = await getRentals({ open: true });
        const trailers = await getTrailers();
        const ctx = await buildPricingContext();

        const billing = openRentals.filter(r => r.status === 'billing' || r.status === 'called_off');
        let accruedMtd = 0, accruedTotal = 0, missingRates = 0;
        for (const r of billing) {
            const priced = priceRental(r, ctx);
            const mtd = priced.pricing_source === 'manual' ? computeAccruedThisMonth(r) : computeMtdEngine(r, ctx);
            if (priced.accrued_amount === null) missingRates++;
            accruedMtd += mtd || 0;
            accruedTotal += priced.total_due || 0;
        }

        res.json({
            success: true,
            summary: {
                trailers_total: trailers.filter(t => t.status !== 'retired').length,
                trailers_available: trailers.filter(t => t.status === 'available').length,
                rentals_open: openRentals.length,
                rentals_billing: billing.length,
                rentals_awaiting_pickup: openRentals.filter(r => r.status === 'awaiting_pickup').length,
                accrued_mtd: Math.round(accruedMtd * 100) / 100,
                accrued_total_open: Math.round(accruedTotal * 100) / 100,
                rentals_missing_rate: missingRates,
            },
            rentals: openRentals.map(r => priceRental(r, ctx)),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Revenue-leakage alerts
app.get('/api/billing/alerts', async (req, res) => {
    try {
        const [pastCalloff, atHq, unbilled] = await Promise.all([
            getBillingPastCalloff(),
            getBillingAtHeadquarters(),
            getUnbilledDeployedTrailers(),
        ]);

        const alerts = [
            ...pastCalloff.map(r => ({
                type: 'billing_past_calloff',
                severity: 'warning',
                rental_id: r.id,
                unit_number: r.unit_number,
                message: `${r.unit_number} is still billing but was called off ${new Date(r.calloff_at).toLocaleDateString()} — stop billing or clear the calloff date`,
            })),
            ...atHq.map(r => ({
                type: 'billing_at_hq',
                severity: 'critical',
                rental_id: r.id,
                unit_number: r.unit_number,
                message: `${r.unit_number} is physically at ${r.hq_name} but billing is still running — customer may be overbilled`,
            })),
            ...unbilled.map(t => ({
                type: 'unbilled_deployed',
                severity: 'critical',
                trailer_id: t.trailer_id,
                unit_number: t.unit_number,
                message: `${t.unit_number} is deployed at active site "${t.job_site_name}" with no open rental — revenue is leaking`,
            })),
        ];

        res.json({ success: true, alerts });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Job Sites API
// ============================================================

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

// GET mentionable users (lightweight, just id + display_name)
app.get('/api/users/mentionable', async (req, res) => {
    try {
        const users = await getUsers();
        const mentionable = users
            .filter(u => u.active !== false)
            .map(u => ({ id: u.id, display_name: u.display_name, role: u.role }));
        res.json({ success: true, users: mentionable });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET all communications (admin only) — cross-site notes with filters
app.get('/api/communications', requireRole('admin'), async (req, res) => {
    try {
        const { site_id, author, search, date_from, date_to, limit, offset } = req.query;
        const result = await getAllSiteNotes({
            siteId: site_id ? parseInt(site_id) : undefined,
            author: author || undefined,
            search: search || undefined,
            dateFrom: date_from ? parseInt(date_from) : undefined,
            dateTo: date_to ? parseInt(date_to) : undefined,
            limit: limit ? parseInt(limit) : 100,
            offset: offset ? parseInt(offset) : 0,
        });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// GPS Change Suggestions
// ============================================================

// GET pending GPS change suggestions
app.get('/api/gps-changes', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const suggestions = await getGpsSuggestions('pending');
        res.json({ suggestions });
    } catch (err) {
        console.error('Get GPS changes error:', err);
        res.status(500).json({ error: 'Failed to fetch GPS change suggestions' });
    }
});

// POST approve GPS change suggestion
app.post('/api/gps-changes/:id/approve', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { id } = req.params;
        const { create_new_site_name } = req.body;

        // Get suggestion
        const suggestionResult = await getPool().query('SELECT * FROM gps_change_suggestions WHERE id = $1', [id]);
        if (suggestionResult.rows.length === 0) {
            return res.status(404).json({ error: 'Suggestion not found' });
        }

        const suggestion = suggestionResult.rows[0];
        if (suggestion.status !== 'pending') {
            return res.status(400).json({ error: 'Suggestion already resolved' });
        }

        let targetJobSiteId = suggestion.suggested_job_site_id;

        // If creating new site, create it first
        if (suggestion.suggestion_type === 'create_new') {
            const siteName = create_new_site_name || `New Site ${new Date().toISOString().slice(0, 10)}`;
            const newSite = await insertJobSite({
                name: siteName,
                latitude: suggestion.new_latitude,
                longitude: suggestion.new_longitude,
                address: null,
            });
            targetJobSiteId = newSite.id;
        }

        // Update trailer assignment
        await upsertTrailerAssignment(
            suggestion.site_id,
            suggestion.site_name,
            suggestion.new_latitude,
            suggestion.new_longitude,
            targetJobSiteId
        );

        // Update GPS tracking
        await updateTrailerGps(suggestion.site_id, suggestion.new_latitude, suggestion.new_longitude);

        // Mark suggestion as approved
        await updateGpsSuggestionStatus(id, 'approved', req.user.id);

        // Clear geofence alert for this trailer since assignment changed
        geofenceAlerts.delete(suggestion.site_id);

        // Log to audit
        await insertAuditLog('gps_suggestion', id, 'approved', {
            site_name: suggestion.site_name,
            target_job_site_id: targetJobSiteId,
            distance_km: suggestion.distance_km
        }, req.user.display_name);

        res.json({ success: true, target_job_site_id: targetJobSiteId });
    } catch (err) {
        console.error('Approve GPS change error:', err);
        res.status(500).json({ error: 'Failed to approve GPS change' });
    }
});

// POST reject GPS change suggestion
app.post('/api/gps-changes/:id/reject', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { id } = req.params;

        const result = await updateGpsSuggestionStatus(id, 'rejected', req.user.id);

        if (!result) {
            return res.status(404).json({ error: 'Suggestion not found or already resolved' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Reject GPS change error:', err);
        res.status(500).json({ error: 'Failed to reject GPS change' });
    }
});

// ============================================================
// Notifications
// ============================================================
app.get('/api/notifications', async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const notifications = await getUserNotifications(userId);
        const unread = await getUnreadNotificationCount(userId);
        res.json({ success: true, notifications, unread_count: unread });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/notifications/:id/read', async (req, res) => {
    try {
        await markNotificationRead(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/notifications/read-all', async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        await markAllNotificationsRead(userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
// Audit Log API
// ============================================================
app.get('/api/audit-log', requireRole('admin'), async (req, res) => {
    try {
        const entityType = req.query.entity_type || null;
        const entityId = req.query.entity_id ? parseInt(req.query.entity_id) : null;
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const result = await getAuditLog({ entityType, entityId, limit, offset });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


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

// ============================================================
// Twilio Webhooks
// ============================================================

// Validate Twilio request signature
function validateTwilioSignature(req) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return true; // Skip validation if token not configured

    const signature = req.headers['x-twilio-signature'];
    if (!signature) return false;

    // Build the full URL Twilio used
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers.host;
    const url = `${protocol}://${host}${req.originalUrl}`;

    // Sort POST params and append to URL
    const params = req.body || {};
    const sortedKeys = Object.keys(params).sort();
    let data = url;
    for (const key of sortedKeys) {
        data += key + params[key];
    }

    const computed = crypto
        .createHmac('sha1', authToken)
        .update(Buffer.from(data, 'utf-8'))
        .digest('base64');

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(computed)
    );
}

app.post('/api/webhooks/twilio', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        // Validate Twilio signature
        if (!validateTwilioSignature(req)) {
            console.warn('[Twilio] Invalid signature — rejecting request');
            return res.status(403).send('Invalid signature');
        }

        const { From, Body } = req.body;
        if (!From || !Body) {
            return res.status(400).send('Missing From or Body');
        }

        // Find the job site associated with this phone number
        const site = await getJobSiteByPhone(From);
        if (site) {
            // Log the incoming SMS as a site note
            await insertSiteNote(site.id, `SMS received: ${Body}`, From);
            console.log(`[Twilio] Saved SMS from ${From} to job site ${site.name}`);
        } else {
            console.warn(`[Twilio] Received SMS from unknown number: ${From}`);
        }

        // Send a generic empty TwiML response so Twilio knows we received it
        res.set('Content-Type', 'text/xml');
        res.send('<Response></Response>');
    } catch (err) {
        console.error('Twilio webhook error:', err.message);
        res.status(500).send('Webhook parsing error');
    }
});

// GET map data (lightweight for markers)
app.get('/api/map/sites', async (req, res) => {
    try {
        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

        const assignmentsByJobSite = new Map();
        for (const a of assignments) {
            if (!assignmentsByJobSite.has(a.job_site_id)) {
                assignmentsByJobSite.set(a.job_site_id, []);
            }
            assignmentsByJobSite.get(a.job_site_id).push(a);
        }

        const markers = jobSites
            .filter(js => js.latitude != null && js.longitude != null)
            .map(js => {
                const trailers = assignmentsByJobSite.get(js.id) || [];
                let worstStatus = 'healthy';
                let trailersOnline = 0;
                let totalSoc = 0, socCount = 0;

                for (const t of trailers) {
                    const snap = snapshotCache.get(t.site_id);
                    const pw = pepwaveCache.get(t.site_name);
                    const isIc2Only = t.site_id < 0;
                    if (isIc2Only) {
                        if (pw?.online) trailersOnline++;
                    } else if (snap && hasVrmData(snap)) {
                        trailersOnline++;
                        if (snap.battery_soc != null) {
                            totalSoc += snap.battery_soc;
                            socCount++;
                            if (snap.battery_soc < 20) worstStatus = 'critical';
                            else if (snap.battery_soc < 50 && worstStatus !== 'critical') worstStatus = 'warning';
                        }
                    } else if (pw?.online) {
                        // No Cerbo/VRM data but Pepwave is online — not critical
                        trailersOnline++;
                    } else if (!snap) {
                        // No VRM snapshot AND no Pepwave connectivity — truly offline
                        if (worstStatus !== 'critical') worstStatus = 'warning';
                    }
                }

                // Check for geofence breaches on any trailer at this site
                const geofenceBreached = trailers.some(t => geofenceAlerts.has(t.site_id));

                // Attach cached weather data if available
                const cacheKey = `${js.latitude.toFixed(2)},${js.longitude.toFixed(2)}`;
                const weather = weatherCache.get(cacheKey);

                return {
                    id: js.id,
                    name: js.name,
                    address: js.address || null,
                    latitude: js.latitude,
                    longitude: js.longitude,
                    status: js.status,
                    is_headquarters: !!js.is_headquarters,
                    delivery_date: js.delivery_date || null,
                    active_date: js.active_date || null,
                    calloff_date: js.calloff_date || null,
                    pickup_date: js.pickup_date || null,
                    trailer_count: trailers.length,
                    trailers_online: trailersOnline,
                    avg_soc: socCount > 0 ? +(totalSoc / socCount).toFixed(1) : null,
                    worst_status: trailers.length === 0 ? 'unknown' : worstStatus,
                    geofence_radius_m: js.geofence_radius_m || 500,
                    geofence_breached: geofenceBreached,
                    weather: weather ? {
                        temperature: weather.temperature_current ?? null,
                        weather_code: weather.weather_code ?? null,
                        cloud_cover_pct: weather.cloud_cover_pct ?? null,
                        wind_speed_kmh: weather.wind_speed_kmh ?? null,
                        sunshine_hours: weather.sunshine_hours ?? null,
                        peak_sun_hours: weather.peak_sun_hours ?? null,
                    } : null,
                };
            });

        res.json({ success: true, markers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- GPS Verification ---

// Get all trailer GPS coordinates (DB + live IC2 cache)
app.get('/api/gps/trailers', async (req, res) => {
    try {
        const assignments = dbAvailable ? await getTrailerAssignments() : [];
        const trailers = assignments.map(a => {
            const live = gpsCache.get(a.site_id);
            const pepwave = getPepwaveForTrailer(a);
            return {
                site_id: a.site_id,
                site_name: a.site_name,
                ic2_device_id: a.ic2_device_id || null,
                job_site_id: a.job_site_id,
                manual_override: a.manual_override,
                db_latitude: a.latitude,
                db_longitude: a.longitude,
                live_latitude: live?.latitude || null,
                live_longitude: live?.longitude || null,
                ic2_latitude: pepwave?.latitude || null,
                ic2_longitude: pepwave?.longitude || null,
                ic2_online: pepwave?.online || false,
                gps_stale: live ? (Date.now() - live.updatedAt > 600000) : true, // >10 min = stale
            };
        });
        res.json({ success: true, trailers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Force refresh GPS from IC2 for all devices
app.post('/api/gps/refresh', requireRole('admin', 'technician'), async (req, res) => {
    try {
        if (!IC2_CLIENT_ID || !IC2_CLIENT_SECRET) {
            return res.status(400).json({ success: false, error: 'IC2 not configured' });
        }
        const vrmSites = sitesCache?.records || [];
        const result = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g/${IC2_GROUP_ID}/d?has_status=true`);
        const devices = result.data || [];
        const gpsDevices = devices.filter(d => d.gps_exist || d.gps_support);

        let updated = 0, failed = 0;
        for (let i = 0; i < gpsDevices.length; i += 5) {
            const batch = gpsDevices.slice(i, i + 5);
            const promises = batch.map(async (dev) => {
                try {
                    const locData = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g/${IC2_GROUP_ID}/d/${dev.id}/loc`);
                    const loc = (locData.data || [])[0];
                    if (loc && loc.la && loc.lo) {
                        const cached = pepwaveCache.get(dev.name);
                        if (cached) { cached.latitude = loc.la; cached.longitude = loc.lo; }

                        const { siteId, siteName } = resolveIc2DeviceToSiteId(dev, vrmSites);
                        gpsCache.set(siteId, { latitude: loc.la, longitude: loc.lo, updatedAt: Date.now() });

                        if (dbAvailable) {
                            await upsertTrailerAssignment(siteId, siteName, loc.la, loc.lo, null, dev.id);
                        }
                        updated++;
                    }
                } catch { failed++; }
            });
            await Promise.all(promises);
            if (i + 5 < gpsDevices.length) await new Promise(r => setTimeout(r, 500));
        }

        // Re-run clustering after GPS refresh
        if (dbAvailable && updated > 0) {
            try { await runClustering(); } catch (e) { /* non-critical */ }
        }

        // Clear stale geofence alerts — GPS positions have changed
        geofenceAlerts.clear();
        checkGeofences().catch(err => console.error('  Post-GPS-refresh geofence check failed:', err.message));

        res.json({ success: true, updated, failed, total_gps_devices: gpsDevices.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Get unlinked IC2 devices (not yet bound to any trailer assignment)
app.get('/api/gps/unlinked-devices', async (req, res) => {
    try {
        const assignments = dbAvailable ? await getTrailerAssignments() : [];
        const linkedDeviceIds = new Set(assignments.filter(a => a.ic2_device_id).map(a => a.ic2_device_id));

        const unlinked = Array.from(pepwaveCache.values())
            .filter(dev => dev.id && !linkedDeviceIds.has(dev.id))
            .map(dev => ({ id: dev.id, name: dev.name, sn: dev.sn, online: dev.online }));

        res.json({ success: true, devices: unlinked });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Manually link an IC2 device to a trailer assignment
app.post('/api/gps/link-device', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { site_id, ic2_device_id } = req.body;
        if (!site_id || !ic2_device_id) {
            return res.status(400).json({ success: false, error: 'site_id and ic2_device_id required' });
        }
        if (!dbAvailable) {
            return res.status(500).json({ success: false, error: 'Database not available' });
        }

        const assignment = await linkIc2Device(site_id, ic2_device_id);
        if (!assignment) {
            return res.status(404).json({ success: false, error: 'Trailer assignment not found' });
        }

        // Update in-memory map
        ic2DeviceIdToSiteId.set(ic2_device_id, site_id);

        res.json({ success: true, assignment });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Recurring Maintenance Helper
// ============================================================

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

// ============================================================
// Maintenance API
// ============================================================

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

const VALID_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'];
const VALID_VISIT_TYPES = ['inspection', 'repair', 'scheduled', 'emergency', 'installation', 'decommission'];
const VALID_RECURRENCE = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'];

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

// ============================================================
// Trailer Components API
// ============================================================

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

// ============================================================
// Analytics API
// ============================================================


app.get('/api/analytics/fleet-summary', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const daily = await getFleetAnalyticsSummary(days);
        const dateRange = await getAnalyticsDateRange();
        res.json({ success: true, daily, date_range: dateRange });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/analytics/rankings', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        const rankings = await getJobSiteRankings(days);
        res.json({ success: true, rankings });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/analytics/job-site/:id', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const data = await getAnalyticsByJobSite(parseInt(req.params.id), days);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/analytics/trailer/:id', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const data = await getAnalyticsByTrailer(parseInt(req.params.id), days);
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Backfill: compute metrics + expected yield for past N days
app.post('/api/analytics/backfill', requireRole('admin'), async (req, res) => {
    try {
        const days = parseInt(req.body?.days) || 30;
        const db = getPool();

        // Step 1: Backfill analytics_daily_metrics from snapshots
        let metricsRows = 0;
        for (let i = 1; i <= days; i++) {
            const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
            const count = await computeDailyMetrics(date);
            metricsRows += count;
        }
        console.log(`  Backfill: computed ${metricsRows} analytics_daily_metrics rows for ${days} days`);

        // Step 2: Backfill expected_yield_wh in daily_energy_summary using historical weather
        const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const endDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

        // Find rows missing expected_yield_wh
        const missing = await db.query(
            `SELECT des.site_id, des.date, ta.latitude, ta.longitude
             FROM daily_energy_summary des
             LEFT JOIN trailer_assignments ta ON ta.site_id = des.site_id
             WHERE des.date >= $1::date AND des.date <= $2::date
               AND des.expected_yield_wh IS NULL
               AND ta.latitude IS NOT NULL AND ta.longitude IS NOT NULL
             ORDER BY des.site_id, des.date`,
            [startDate, endDate]
        );

        // Group by GPS location (rounded to 0.1°) to minimize API calls
        const locationGroups = new Map();
        for (const row of missing.rows) {
            const key = `${Math.round(row.latitude * 10) / 10},${Math.round(row.longitude * 10) / 10}`;
            if (!locationGroups.has(key)) {
                locationGroups.set(key, { lat: row.latitude, lng: row.longitude, rows: [] });
            }
            locationGroups.get(key).rows.push(row);
        }

        let expectedUpdated = 0;
        const specs = TRAILER_SPECS;

        for (const [locKey, group] of locationGroups) {
            try {
                // Open-Meteo archive API for historical solar radiation
                const url = `https://archive-api.open-meteo.com/v1/archive`
                    + `?latitude=${group.lat}&longitude=${group.lng}`
                    + `&start_date=${startDate}&end_date=${endDate}`
                    + `&daily=shortwave_radiation_sum&timezone=auto`;
                const resp = await fetch(url);
                if (!resp.ok) {
                    console.warn(`  Backfill: Open-Meteo archive failed for ${locKey}: ${resp.status}`);
                    continue;
                }
                const json = await resp.json();
                const dates = json.daily?.time || [];
                const radiation = json.daily?.shortwave_radiation_sum || [];

                // Build date->PSH lookup
                const pshByDate = new Map();
                for (let i = 0; i < dates.length; i++) {
                    if (radiation[i] != null) {
                        pshByDate.set(dates[i], radiation[i] / 3.6); // MJ/m² to kWh/m² (PSH)
                    }
                }

                // Update each row's expected_yield_wh
                for (const row of group.rows) {
                    const dateStr = new Date(row.date).toISOString().slice(0, 10);
                    const psh = pshByDate.get(dateStr);
                    if (psh != null && psh > 0) {
                        const expectedWh = specs.solar.total_watts * psh * specs.solar.system_efficiency;
                        await db.query(
                            `UPDATE daily_energy_summary SET expected_yield_wh = $1 WHERE site_id = $2 AND date = $3::date`,
                            [Math.round(expectedWh), row.site_id, dateStr]
                        );
                        expectedUpdated++;
                    }
                }

                // Rate limit: 1 req/sec for Open-Meteo
                await new Promise(r => setTimeout(r, 1100));
            } catch (err) {
                console.warn(`  Backfill: error for location ${locKey}: ${err.message}`);
            }
        }
        console.log(`  Backfill: updated ${expectedUpdated} expected_yield_wh values across ${locationGroups.size} locations`);

        // Step 3: Reload in-memory dailyEnergy cache from updated DB
        const rows = await getAllDailyEnergy(days);
        for (const row of rows) {
            const siteId = row.site_id;
            const dateStr = new Date(row.date).toISOString().slice(0, 10);
            if (!dailyEnergy.has(siteId)) {
                dailyEnergy.set(siteId, {});
            }
            const siteData = dailyEnergy.get(siteId);
            siteData[dateStr] = {
                site_name: row.site_name || `Site ${siteId}`,
                yield_wh: row.yield_wh != null ? Number(row.yield_wh) : null,
                consumed_wh: row.consumed_wh != null ? Number(row.consumed_wh) : null,
                expected_yield_wh: row.expected_yield_wh != null ? Number(row.expected_yield_wh) : null,
                updated: Date.now(),
            };
        }
        console.log(`  Backfill: reloaded ${rows.length} dailyEnergy records into memory`);

        res.json({
            success: true,
            days_processed: days,
            metrics_rows: metricsRows,
            expected_yield_backfilled: expectedUpdated,
            locations_queried: locationGroups.size,
            cache_reloaded: rows.length,
        });
    } catch (err) {
        console.error('  Backfill error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Unified dashboard endpoint (single call for FleetOverview)
// ============================================================
app.get('/api/fleet/dashboard', (req, res) => {
    const snapshots = Array.from(snapshotCache.values());
    const vrmSnapshots = snapshots.filter(hasVrmData);
    const devices = Array.from(pepwaveCache.values());

    let totalSoc = 0, socCount = 0, totalSolar = 0;
    let onlineTrailers = 0, offlineTrailers = 0;

    for (const s of vrmSnapshots) {
        if (s.battery_soc != null) {
            totalSoc += s.battery_soc;
            socCount++;
        }
        totalSolar += s.solar_watts || 0;
        onlineTrailers++;
    }

    let netOnline = 0, netOffline = 0;
    for (const d of devices) {
        if (d.online) netOnline++;
        else netOffline++;
    }

    const alerts = computeAlerts();

    res.json({
        success: true,
        site_count: snapshots.length,
        device_count: devices.length,
        avg_soc: socCount > 0 ? totalSoc / socCount : null,
        total_solar_watts: totalSolar,
        trailers_online: onlineTrailers,
        trailers_offline: offlineTrailers,
        net_online: netOnline,
        net_offline: netOffline,
        alert_count: alerts.length,
        top_alerts: alerts.slice(0, 5),
        last_vrm_poll: sitesCacheTime,
        last_ic2_poll: lastIc2Poll,
    });
});

// ============================================================
// Battery health prediction
// ============================================================
app.get('/api/analytics/trailer/:id/battery-health', async (req, res) => {
    try {
        const siteId = parseInt(req.params.id);
        const days = parseInt(req.query.days) || 30;
        const dataPoints = await getBatteryHistory(siteId, days);

        if (dataPoints.length < 3) {
            return res.json({ success: true, trend: 'insufficient_data', dataPoints });
        }

        // Linear regression on max_soc over time (peak daily SOC after charging = true capacity)
        const n = dataPoints.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (let i = 0; i < n; i++) {
            const y = dataPoints[i].max_soc ?? dataPoints[i].avg_soc ?? 0;
            sumX += i;
            sumY += y;
            sumXY += i * y;
            sumXX += i * i;
        }
        const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
        const avgDailyChange = slope; // % per day

        let trend = 'stable';
        if (slope < -0.5) trend = 'declining';
        else if (slope > 0.5) trend = 'improving';

        let daysUntilCritical = null;
        if (trend === 'declining') {
            const currentSoc = dataPoints[n - 1].max_soc ?? dataPoints[n - 1].avg_soc ?? 50;
            if (currentSoc > 20) {
                daysUntilCritical = Math.round((currentSoc - 20) / Math.abs(slope));
            }
        }

        res.json({
            success: true,
            trend,
            avg_daily_change: Math.round(avgDailyChange * 100) / 100,
            days_until_critical: daysUntilCritical,
            data_points: dataPoints,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Intelligence API: Spec + location-aware metrics
// ============================================================
app.get('/api/intelligence/trailer/:id', async (req, res) => {
    try {
        const siteId = parseInt(req.params.id);
        const intel = await computeTrailerIntelligence(siteId);
        if (!intel) {
            return res.status(404).json({ success: false, error: 'Trailer not found or no data' });
        }
        res.json({ success: true, intelligence: intel });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/fleet/intelligence', async (req, res) => {
    try {
        const results = [];
        // Batch weather fetches by unique GPS locations first
        const uniqueLocations = new Map();
        for (const [siteId] of snapshotCache) {
            const gps = gpsCache.get(siteId);
            if (gps) {
                const key = `${Math.round(gps.latitude * 10) / 10},${Math.round(gps.longitude * 10) / 10}`;
                if (!uniqueLocations.has(key)) {
                    uniqueLocations.set(key, { lat: gps.latitude, lon: gps.longitude });
                }
            }
        }
        // Pre-fetch weather for all unique locations (in parallel, max 10)
        const locationEntries = Array.from(uniqueLocations.values()).slice(0, 10);
        await Promise.allSettled(locationEntries.map(loc => fetchSolarIrradiance(loc.lat, loc.lon)));

        // Now compute intelligence for VRM-connected trailers only (weather is cached)
        for (const [siteId, snap] of snapshotCache) {
            if (!hasVrmData(snap)) continue;
            const intel = await computeTrailerIntelligence(siteId);
            if (intel) results.push(intel);
        }

        // Fleet-wide aggregates
        const withScore = results.filter(r => r.solar.score !== null);
        const withAutonomy = results.filter(r => r.battery.days_of_autonomy !== null);
        const withPerformance = results.filter(r => r.solar.panel_performance_pct !== null);

        const underperforming = results.filter(r => r.solar.avg_7d_score !== null && r.solar.avg_7d_score < 50);
        const lowAutonomy = results.filter(r => r.battery.days_of_autonomy !== null && r.battery.days_of_autonomy < 1.5);

        res.json({
            success: true,
            fleet: {
                trailer_count: results.length,
                avg_solar_score: withScore.length > 0
                    ? Math.round(withScore.reduce((s, r) => s + r.solar.score, 0) / withScore.length * 10) / 10
                    : null,
                avg_panel_performance: withPerformance.length > 0
                    ? Math.round(withPerformance.reduce((s, r) => s + r.solar.panel_performance_pct, 0) / withPerformance.length * 10) / 10
                    : null,
                avg_days_autonomy: withAutonomy.length > 0
                    ? Math.round(withAutonomy.reduce((s, r) => s + r.battery.days_of_autonomy, 0) / withAutonomy.length * 10) / 10
                    : null,
                underperforming_count: underperforming.length,
                low_autonomy_count: lowAutonomy.length,
                specs: TRAILER_SPECS,
            },
            trailers: results,
            underperforming: underperforming.map(r => ({
                site_id: r.site_id, site_name: r.site_name, score_7d: r.solar.avg_7d_score,
            })),
            low_autonomy: lowAutonomy.map(r => ({
                site_id: r.site_id, site_name: r.site_name, days: r.battery.days_of_autonomy, soc: r.battery.soc_pct,
            })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// Agentic Analysis: Claude-powered trailer intelligence
// ============================================================
app.post('/api/analyze/trailer/:id', aiLimiter, async (req, res) => {
    if (!anthropic) {
        return res.status(501).json({ error: 'Claude API key not configured' });
    }

    const siteId = parseInt(req.params.id);
    const snapshot = snapshotCache.get(siteId);
    if (!snapshot) {
        return res.status(404).json({ error: 'Trailer not found or no data' });
    }

    try {
        const intel = await computeTrailerIntelligence(siteId);
        const alerts = computeAlerts().filter(a => a.site_id === siteId);
        const energyHistory = dailyEnergy.get(siteId) || {};

        // Find matching Pepwave device
        let pepwaveDevice = null;
        for (const [name, device] of pepwaveCache.entries()) {
            if (name === snapshot.site_name) { pepwaveDevice = device; break; }
        }

        // Get battery health trend from DB
        let batteryTrend = null;
        if (dbAvailable) {
            try {
                const dataPoints = await getBatteryHistory(siteId, 30);
                if (dataPoints.length >= 3) {
                    const n = dataPoints.length;
                    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
                    for (let i = 0; i < n; i++) {
                        const y = dataPoints[i].min_soc ?? dataPoints[i].avg_soc ?? 0;
                        sumX += i; sumY += y; sumXY += i * y; sumXX += i * i;
                    }
                    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
                    batteryTrend = {
                        direction: slope < -0.5 ? 'declining' : slope > 0.5 ? 'improving' : 'stable',
                        daily_change_pct: Math.round(slope * 100) / 100,
                        data_points: n,
                    };
                }
            } catch { }
        }

        // Helper to format nullable values for AI context
        const fmt = (val, unit = '') => val != null ? `${val}${unit}` : 'N/A';

        // Determine consumption data source for this trailer
        const todayEnergy = energyHistory[todayStr()] || {};
        const consumptionSource = todayEnergy.consumption_source || 'unavailable';

        // Build context for Claude
        const ctx = [
            `TRAILER: ${snapshot.site_name} (ID: ${siteId})`,
            `TIMESTAMP: ${new Date().toISOString()}`,
            '',
            '=== HARDWARE SPECIFICATIONS ===',
            `Solar: ${TRAILER_SPECS.solar.panels}x ${TRAILER_SPECS.solar.panel_watts}W panels = ${TRAILER_SPECS.solar.total_watts}W total capacity`,
            `Battery: ${TRAILER_SPECS.battery.count}x ${TRAILER_SPECS.battery.ah_per_battery}Ah ${TRAILER_SPECS.battery.voltage}V = ${TRAILER_SPECS.battery.total_wh}Wh (${(TRAILER_SPECS.battery.total_wh / 1000).toFixed(1)} kWh)`,
            `System efficiency factor: ${TRAILER_SPECS.solar.system_efficiency * 100}%`,
            '',
            '=== LOCATION & WEATHER ===',
            `GPS: ${intel.location.latitude ?? 'unknown'}, ${intel.location.longitude ?? 'unknown'}`,
            `Peak Sun Hours: ${intel.location.peak_sun_hours}h (source: ${intel.location.data_source})`,
            `Cloud Cover: ${intel.location.cloud_cover_pct !== null ? intel.location.cloud_cover_pct + '%' : 'unknown'}`,
            `Expected Daily Yield: ${fmt(intel.location.expected_daily_yield_wh, 'Wh')}`,
            '',
            '=== LIVE READINGS ===',
            `Battery SOC: ${fmt(snapshot.battery_soc, '%')}`,
            `Battery Voltage: ${fmt(snapshot.battery_voltage, 'V')}`,
            `Battery Current: ${fmt(snapshot.battery_current, 'A')}`,
            `Battery Temp: ${fmt(snapshot.battery_temp, '°C')}`,
            `Battery Power: ${fmt(snapshot.battery_power, 'W')}`,
            `Solar Power (now): ${fmt(snapshot.solar_watts, 'W')}`,
            `Solar Yield Today: ${fmt(snapshot.solar_yield_today, ' kWh')}`,
            `Solar Yield Yesterday: ${fmt(snapshot.solar_yield_yesterday, ' kWh')}`,
            `Charge State: ${fmt(snapshot.charge_state)}`,
            '',
            '=== DEVICE STATUS ===',
            `DC Load Power (now): ${fmt(snapshot.dc_load_watts, 'W')}`,
            `Load Current: ${fmt(snapshot.load_current, 'A')}`,
            `Load Output: ${fmt(snapshot.load_state)}`,
            `Inverter Mode: ${fmt(snapshot.inverter_mode)}`,
            `Alarm Reason: ${snapshot.alarm_reason != null ? snapshot.alarm_reason : 'None'}`,
            `Error Code: ${snapshot.error_code != null ? snapshot.error_code : 'None'}`,
            `MPPT State: ${fmt(snapshot.mppt_state)}`,
            `Lifetime Yield: ${fmt(snapshot.lifetime_yield_kwh, ' kWh')}`,
            `Time to Go (Victron estimate): ${snapshot.time_to_go_min != null ? `${Math.round(snapshot.time_to_go_min / 60 * 10) / 10} hours` : 'N/A'}`,
            `Firmware: ${fmt(snapshot.firmware_version)}`,
            '',
            '=== COMPUTED INTELLIGENCE ===',
            `Yesterday's Solar Score: ${fmt(intel.solar.score, '%')} (${intel.solar.score_label ?? 'N/A'}) — completed day, location+weather adjusted`,
            `${intel.solar.throttled ? '  ⚡ MPPT was throttled (battery full) — score adjusted for idle/float curtailment' : ''}`,
            `${intel.solar.raw_score !== null && intel.solar.raw_score !== intel.solar.score ? `  Raw score before adjustment: ${intel.solar.raw_score}%` : ''}`,
            `7-Day Avg Score: ${fmt(intel.solar.avg_7d_score, '%')} — use this alongside yesterday's score for trend analysis`,
            `Today's Live Score (partial day): ${fmt(intel.solar.today_live_score, '%')} — still accumulating, do NOT use for performance evaluation`,
            `Panel Performance (now): ${fmt(intel.solar.panel_performance_pct, '%')} of ${TRAILER_SPECS.solar.total_watts}W rated`,
            `Days of Autonomy: ${fmt(intel.battery.days_of_autonomy)}`,
            `Est. Charge Time to Full: ${intel.battery.charge_time_hours ? intel.battery.charge_time_hours + 'h' : 'N/A'}`,
            `Battery Temp Status: ${fmt(intel.battery.temp_status)}`,
            `Stored Energy: ${fmt(intel.battery.stored_wh, 'Wh')} of ${TRAILER_SPECS.battery.total_wh}Wh`,
            `Avg Daily Consumption: ${fmt(intel.energy.avg_daily_consumption_wh, 'Wh')}`,
            `Consumption Data Source: ${consumptionSource}`,
            `Today Balance: ${fmt(intel.energy.today_balance_wh, 'Wh')}`,
        ];

        if (batteryTrend) {
            ctx.push('', '=== BATTERY HEALTH TREND (30 days) ===');
            ctx.push(`Direction: ${batteryTrend.direction}`);
            ctx.push(`Daily SOC change: ${batteryTrend.daily_change_pct}%/day`);
        }

        if (alerts.length > 0) {
            ctx.push('', '=== ACTIVE ALERTS ===');
            for (const a of alerts) ctx.push(`Energy deficit streak: ${a.streak_days} days (${a.severity})`);
        }

        const energyDays = Object.entries(energyHistory).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14);
        if (energyDays.length > 0) {
            ctx.push('', '=== DAILY ENERGY HISTORY (recent) ===');
            for (const [date, info] of energyDays) {
                ctx.push(`${date}: yield=${info.yield_wh !== null ? Math.round(info.yield_wh) : '?'}Wh, consumed=${info.consumed_wh !== null ? Math.round(info.consumed_wh) : '?'}Wh${info.consumption_source ? ' (' + info.consumption_source + ')' : ''}`);
            }
        }

        if (pepwaveDevice) {
            ctx.push('', '=== NETWORK STATUS ===');
            ctx.push(`Status: ${pepwaveDevice.online ? 'Online' : 'Offline'}`);
            ctx.push(`Signal: ${pepwaveDevice.cellular?.signal_bar ?? '?'}/5 bars`);
            ctx.push(`RSRP: ${pepwaveDevice.cellular?.signal?.rsrp ?? '?'} dBm`);
        }

        const systemPrompt = `You are an expert solar energy systems analyst for a fleet of construction site trailers.
Each trailer has ${TRAILER_SPECS.solar.panels}x ${TRAILER_SPECS.solar.panel_watts}W solar panels (${TRAILER_SPECS.solar.total_watts}W total) and ${TRAILER_SPECS.battery.count}x ${TRAILER_SPECS.battery.ah_per_battery}Ah ${TRAILER_SPECS.battery.voltage}V batteries (${(TRAILER_SPECS.battery.total_wh / 1000).toFixed(1)} kWh total storage).

Analyze the trailer data and provide:
1. STATUS SUMMARY (1-2 sentences: overall health assessment)
2. KEY FINDINGS (3-5 bullet points of the most important observations)
3. RECOMMENDATIONS (2-4 specific, actionable recommendations)
4. RISK ASSESSMENT (low/medium/high with brief explanation)

Consider:
- Evaluate solar performance using YESTERDAY'S SCORE (completed day) and the 7-DAY AVERAGE — do NOT use today's live score as it's a partial day still accumulating
- If the MPPT was throttled (idle/float due to full battery), note that reduced yield is expected behavior, not a problem
- Is the battery being drawn down faster than it charges?
- Are there signs of panel degradation or underperformance based on yesterday and the 7-day trend?
- How many days can this trailer run without sunlight?
- Any temperature or voltage concerns?
- Are there active alarms or error codes that need attention?
- What is the inverter mode and is the load output functioning?
- How reliable is the consumption data? (Check the "Consumption Data Source" — CE diagnostic is most accurate, DC power accumulation and SOC delta are estimates)
- If consumption data shows N/A, note that autonomy calculations are unavailable and recommend investigating load metering
- How does lifetime yield compare to expected cumulative production for the trailer's age?

Be specific with numbers. Reference the hardware specs. Keep under 400 words.
Respond in plain text with the section headers above.`;

        const msg = await anthropic.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 1200,
            messages: [{ role: 'user', content: ctx.join('\n') }],
            system: systemPrompt,
        });

        res.json({
            success: true,
            site_id: siteId,
            site_name: snapshot.site_name,
            analysis: msg.content[0].text,
            intelligence: intel,
            generated_at: new Date().toISOString(),
        });
    } catch (err) {
        console.error(`Analyze trailer ${siteId} error:`, err.message);
        res.status(500).json({ error: `Analysis failed: ${err.message}` });
    }
});


// ============================================================
// Geofence Checking
// ============================================================


// ============================================================
// GPS Change Detection
// ============================================================

/**
 * Detects significant GPS changes (>1km) and creates suggestions for reassignment.
 * Runs during IC2 polling cycle after GPS cache is updated.
 * Respects manual_override flag.
 */


// ============================================================
// Natural Language Query (Claude-powered)
// ============================================================
const FLEET_SCHEMA = `
You are a fleet data assistant for a solar-powered trailer monitoring system.
The system tracks ~110 trailers across ~53 construction job sites. HQ is in Kansas.
"Site" = construction job site. "Trailer" = individual VRM solar installation.

Database tables:

1. site_snapshots — VRM power data (one row per trailer per 5-min poll)
   Columns: id SERIAL, site_id INTEGER, site_name TEXT, timestamp BIGINT (ms),
   battery_soc REAL (0-100%), battery_voltage REAL (V), battery_current REAL (A),
   battery_temp REAL (°C), battery_power REAL (W), solar_watts REAL (W),
   solar_yield_today REAL (kWh), solar_yield_yesterday REAL (kWh), charge_state TEXT,
   consumed_ah REAL (consumed amp-hours from CE diagnostic, most accurate consumption),
   dc_load_watts REAL (DC load power in watts), load_current REAL (load amps),
   load_state TEXT (on/off), inverter_mode TEXT, mppt_state TEXT,
   alarm_reason TEXT, error_code TEXT, lifetime_yield_kwh REAL (cumulative solar kWh),
   time_to_go_min REAL (Victron TTG estimate in minutes)

2. pepwave_snapshots — Pepwave network data (one row per device per 5-min poll)
   Columns: id SERIAL, device_name TEXT, timestamp BIGINT (ms),
   online BOOLEAN, signal_bar INTEGER (0-5), rsrp REAL (dBm, good > -90, fair > -105, poor < -105),
   rsrq REAL (dB), rssi REAL (dBm), sinr REAL (dB, higher=better),
   carrier TEXT, technology TEXT (LTE/5G/etc), usage_mb REAL (cumulative MB),
   tx_mb REAL, rx_mb REAL, client_count INTEGER, uptime INTEGER (seconds), wan_ip TEXT

3. job_sites — Construction locations (one row per physical location)
   Columns: id SERIAL, name TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
   address TEXT, status TEXT ('active'|'standby'|'completed'), notes TEXT,
   uid TEXT, customer_name TEXT, primary_contact_name TEXT, primary_contact_phone TEXT,
   primary_contact_email TEXT, secondary_contact_name TEXT, secondary_contact_phone TEXT, secondary_contact_email TEXT,
   created_at BIGINT (ms), updated_at BIGINT (ms)

4. trailer_assignments — Links trailers to job sites
   Columns: id SERIAL, site_id INTEGER (VRM idSite, UNIQUE), site_name TEXT,
   job_site_id INTEGER REFERENCES job_sites(id), latitude DOUBLE PRECISION,
   longitude DOUBLE PRECISION, manual_override BOOLEAN, assigned_at BIGINT (ms)

5. maintenance_logs — Service/repair tracking
   Columns: id SERIAL, job_site_id INTEGER REFERENCES job_sites(id), site_id INTEGER (trailer, nullable),
   visit_type TEXT ('inspection'|'repair'|'scheduled'|'emergency'|'installation'|'decommission'),
   status TEXT ('scheduled'|'in_progress'|'completed'|'cancelled'),
   title TEXT, description TEXT, technician TEXT,
   scheduled_date BIGINT (ms), completed_date BIGINT (ms),
   labor_hours REAL, labor_cost_cents INTEGER, parts_cost_cents INTEGER,
   parts_used JSONB, created_at BIGINT (ms), updated_at BIGINT (ms)

6. analytics_daily_metrics — Pre-computed daily aggregates per trailer
   Columns: id SERIAL, date DATE, site_id INTEGER, avg_soc REAL, min_soc REAL, max_soc REAL,
   solar_yield_kwh REAL, avg_voltage REAL, avg_signal_bar REAL, data_usage_mb REAL,
   uptime_percent REAL, created_at BIGINT (ms). UNIQUE(site_id, date)

7. daily_energy_summary — Daily solar yield and consumption per trailer
   Columns: site_id INTEGER, date DATE, site_name TEXT, yield_wh NUMERIC (solar Wh),
   consumed_wh NUMERIC (consumption Wh), soc_start_of_day REAL, expected_yield_wh NUMERIC,
   consumption_source TEXT ('CE diagnostic'|'DC power accumulation'|'SOC delta estimate'),
   battery_soc_eod REAL (end-of-day battery SOC %), mppt_state_eod INTEGER (0-7: 0=Off, 3=Bulk, 4=Absorption, 5=Float, 6=Storage),
   updated_at BIGINT (ms). PRIMARY KEY(site_id, date)

8. site_notes — Communications and log of interactions per job site
   Columns: id SERIAL, job_site_id INTEGER REFERENCES job_sites(id),
   note TEXT, author TEXT, created_at BIGINT (ms)

   Energy Deficit Context:
   - A "deficit" occurs when consumed_wh > yield_wh on a given date
   - "Idle-throttled deficit": Small deficit (<1 kWh) with high EOD SOC (≥88%) and MPPT in Float/Storage (5/6)
     → Not a problem—just MPPT intentionally throttling excess solar when batteries are full
   - "Real deficit": Deficit not meeting throttle criteria—indicates potential energy shortage
   - Alerts only trigger on 2+ consecutive REAL deficit days (throttled days excluded)

IMPORTANT:
- site_snapshots.site_name matches pepwave_snapshots.device_name (they share trailer names)
- trailer_assignments.site_id matches site_snapshots.site_id
- trailer_assignments.site_name matches pepwave_snapshots.device_name
- To find trailers at a job site: JOIN trailer_assignments ta ON ta.job_site_id = job_sites.id
- Timestamps are epoch milliseconds. Use to_timestamp(timestamp/1000) for date ops.
- Costs in maintenance_logs are in cents (divide by 100 for dollars).
- Always LIMIT results to 50 rows max.
- Only generate SELECT queries. Never INSERT, UPDATE, DELETE, DROP, ALTER, or any DDL/DML.
- For "latest" queries, use DISTINCT ON or subqueries with MAX(timestamp).
- For daily aggregations, group by DATE(to_timestamp(timestamp/1000)).
- PostgreSQL REAL columns: cast to numeric for round(): round(column::numeric, 2)
- For geographic queries (e.g. "trailers in Colorado"), use job_sites.address which contains city/state info. Match on state name: WHERE js.address ILIKE '%Colorado%'. Do NOT match on job site name alone — names like "Big View HQ" don't indicate state.
- job_sites.name may include city and state (e.g. "Aurora, Colorado") OR be a custom name (e.g. "Big View HQ"). Always use the address field for state/location filtering.

Trailer hardware specs: ${TRAILER_SPECS.solar.panels}x ${TRAILER_SPECS.solar.panel_watts}W solar panels (${TRAILER_SPECS.solar.total_watts}W total), ${TRAILER_SPECS.battery.count}x ${TRAILER_SPECS.battery.ah_per_battery}Ah ${TRAILER_SPECS.battery.voltage}V batteries (${TRAILER_SPECS.battery.total_wh}Wh / ${(TRAILER_SPECS.battery.total_wh / 1000).toFixed(1)} kWh total storage).

Intelligence vocabulary (available in live context below):
- "solar score" → actual yield vs location+weather-adjusted expected yield (0-100+%)
- "solar efficiency" → same as solar score
- "days of autonomy" → stored Wh / avg daily consumption Wh
- "underperforming trailers" → those with 7-day avg solar score below 50%
- "panel performance" → instantaneous solar watts / rated ${TRAILER_SPECS.solar.total_watts}W capacity

Examples:
- "trailers at Downtown site" → JOIN trailer_assignments + job_sites WHERE js.name ILIKE '%downtown%'
- "how many trailers does X have" → JOIN trailer_assignments ta ON ta.job_site_id = js.id WHERE js.customer_name ILIKE '%X%'
- "read notes for site X" → JOIN site_notes sn ON sn.job_site_id = js.id WHERE js.name ILIKE '%X%'
- "which sites have most maintenance costs" → SUM(labor_cost_cents + parts_cost_cents) from maintenance_logs GROUP BY job_site_id
- "low battery trailers" → DISTINCT ON site_snapshots for latest where battery_soc < 30
- "site rankings by SOC" → analytics_daily_metrics AVG(avg_soc) GROUP BY site_id, JOIN job_sites
- "data usage this week" → aggregate pepwave_snapshots usage_mb grouped by device_name
- "underperforming trailers" → use intelligence metrics from live context
- "what's the solar score for trailer X" → use intelligence metrics from live context
`;

app.post('/api/query', aiLimiter, async (req, res) => {
    if (!anthropic) {
        return res.status(501).json({ error: 'Claude API key not configured' });
    }

    const { question } = req.body;
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
        return res.status(400).json({ error: 'Question is required' });
    }

    try {
        // Build real-time context from in-memory caches
        const deviceSummary = [];
        for (const [name, device] of pepwaveCache.entries()) {
            deviceSummary.push(`${name}: ${device.online ? 'online' : 'offline'}, signal=${device.cellular?.signal_bar ?? '?'}/5, rsrp=${device.cellular?.signal?.rsrp ?? '?'}dBm, clients=${device.client_count}, usage=${device.usage_mb}MB`);
        }
        const snapshotSummary = [];
        for (const [siteId, snap] of snapshotCache.entries()) {
            if (!hasVrmData(snap)) continue;
            snapshotSummary.push(`${snap.site_name || 'Site ' + siteId}: SOC=${snap.battery_soc}%, ${snap.battery_voltage}V, solar=${snap.solar_watts}W, charge=${snap.charge_state}, dcLoad=${snap.dc_load_watts ?? '?'}W, inverter=${snap.inverter_mode ?? '?'}, mppt=${snap.mppt_state ?? '?'}`);
        }

        // Build intelligence summary from computed metrics
        const intelSummary = [];
        for (const [siteId, snap] of snapshotCache) {
            if (!hasVrmData(snap)) continue;
            try {
                const intel = await computeTrailerIntelligence(siteId);
                if (intel) {
                    intelSummary.push(`${intel.site_name}: score=${intel.solar.score ?? '?'}%(${intel.solar.score_label ?? '?'}), autonomy=${intel.battery.days_of_autonomy ?? '?'}d, panel=${intel.solar.panel_performance_pct ?? '?'}%, PSH=${intel.location.peak_sun_hours}h`);
                }
            } catch { }
        }

        // Build maintenance context from DB
        let maintContext = '';
        if (dbAvailable) {
            try {
                const stats = await getMaintenanceStats();
                const upcoming = await getUpcomingMaintenance(14);
                maintContext = `\n\nMaintenance: ${stats.open_count || 0} open, ${stats.overdue_count || 0} overdue, ${stats.upcoming_week || 0} due this week`;
                if (upcoming.length > 0) {
                    maintContext += '\nUpcoming maintenance:\n' + upcoming.slice(0, 15).map(m => {
                        const d = m.scheduled_date ? new Date(Number(m.scheduled_date)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'no date';
                        return `- ${m.title} at ${m.job_site_name || 'unassigned'}, due ${d}, ${m.status}`;
                    }).join('\n');
                }
            } catch { }
        }

        const liveContext = `\nCurrent live data (${new Date().toISOString()}):\n` +
            `Pepwave devices (${deviceSummary.length} total):\n${deviceSummary.join('\n')}\n\n` +
            `VRM sites (${snapshotSummary.length} total):\n${snapshotSummary.join('\n')}` +
            (intelSummary.length > 0 ? `\n\nIntelligence metrics (specs: ${TRAILER_SPECS.solar.total_watts}W solar, ${TRAILER_SPECS.battery.total_wh}Wh battery per trailer):\n${intelSummary.join('\n')}` : '') +
            maintContext;

        const systemPrompt = FLEET_SCHEMA + liveContext + `\n\nRespond in this JSON format:\n{\n  "answer": "<human-readable answer to the question>",\n  "sql": "<optional SQL query if database lookup would help, or null>",\n  "data": null\n}\n\nIf you can answer from the live context alone, set sql to null and answer directly.\nIf a SQL query would give better/more complete data, include it. The system will execute it and ask you to refine the answer.\nAlways respond with valid JSON only, no markdown fences.`;

        const msg = await anthropic.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 1500,
            messages: [{ role: 'user', content: question }],
            system: systemPrompt,
        });

        let parsed;
        try {
            let text = msg.content[0].text;
            // Strip markdown code blocks if present
            const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (codeBlockMatch) {
                text = codeBlockMatch[1];
            }
            parsed = JSON.parse(text);
        } catch {
            // If Claude didn't return valid JSON, wrap the text as an answer
            parsed = { answer: msg.content[0].text, sql: null, data: null };
        }

        // If Claude generated a SQL query and DB is available, execute it
        if (parsed.sql && dbAvailable) {
            const sqlLower = parsed.sql.toLowerCase().trim();
            // Safety: only allow SELECT (including CTEs starting with WITH)
            if (!sqlLower.startsWith('select') && !sqlLower.startsWith('with')) {
                parsed.answer += '\n⚠️ Query was blocked for safety (non-SELECT detected).';
                parsed.sql = null;
            } else if (dbPool) {
                try {
                    const result = await dbPool.query(parsed.sql);
                    parsed.data = result.rows.slice(0, 50);

                    // Ask Claude to refine the answer with the actual data
                    const refinement = await anthropic.messages.create({
                        model: 'claude-sonnet-4-5-20250929',
                        max_tokens: 1000,
                        messages: [{
                            role: 'user',
                            content: `Original question: "${question}"\n\nSQL query returned ${result.rows.length} rows:\n${JSON.stringify(result.rows.slice(0, 20), null, 2)}\n\nProvide a clear, concise answer summarizing these results. Format as plain text, use bullet points if listing items. Keep it brief.`
                        }],
                        system: 'You are a fleet data assistant. Provide clear, concise answers about trailer fleet data. Use bullet points for lists. Include numbers and specifics. Keep answers under 200 words.',
                    });
                    parsed.answer = refinement.content[0].text;
                } catch (dbErr) {
                    parsed.answer += `\n⚠️ SQL execution failed: ${dbErr.message}`;
                    parsed.data = null;
                }
            }
        }

        res.json({
            success: true,
            question,
            answer: parsed.answer,
            sql: parsed.sql,
            data: parsed.data,
        });
    } catch (err) {
        console.error('Query error:', err.message);
        res.status(500).json({ error: `Query failed: ${err.message}` });
    }
});

// ============================================================
// Semantic Search Endpoint
// ============================================================
app.post('/api/search/semantic', async (req, res) => {
    if (!isEmbeddingsConfigured()) {
        return res.status(501).json({ error: 'Voyage API key not configured' });
    }

    if (!dbAvailable || !pgvectorAvailable) {
        return res.status(503).json({ error: 'Semantic search not available (pgvector required)' });
    }

    const { query, contentTypes, limit } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ error: 'Query is required' });
    }

    try {
        // Generate embedding for the search query
        const queryEmbedding = await generateQueryEmbedding(query);

        // Perform vector similarity search
        const results = await semanticSearch(
            queryEmbedding,
            contentTypes || null,
            limit || 20
        );

        // Use Claude to synthesize results into a natural answer
        let answer = '';
        if (anthropic && results.length > 0) {
            try {
                const resultsContext = results.slice(0, 10).map((r, i) =>
                    `${i + 1}. [${r.content_type}] ${r.content_text} (similarity: ${(r.similarity * 100).toFixed(1)}%)`
                ).join('\n');

                const msg = await anthropic.messages.create({
                    model: 'claude-sonnet-4-5-20250929',
                    max_tokens: 800,
                    messages: [{
                        role: 'user',
                        content: `User query: "${query}"\n\nMost relevant fleet data:\n${resultsContext}\n\nProvide a clear, concise answer based on these search results. Use bullet points if listing items. Keep it under 150 words.`
                    }],
                    system: 'You are a fleet data assistant. Provide clear answers about trailer fleet data based on semantic search results.',
                });
                answer = msg.content[0].text;
            } catch (claudeErr) {
                console.error('Claude synthesis failed:', claudeErr.message);
                // Fall back to raw results
                answer = `Found ${results.length} relevant results for "${query}".`;
            }
        } else {
            answer = results.length > 0
                ? `Found ${results.length} relevant results for "${query}".`
                : `No results found for "${query}".`;
        }

        res.json({
            success: true,
            query,
            answer,
            results: results.map(r => ({
                type: r.content_type,
                id: r.content_id,
                text: r.content_text,
                similarity: r.similarity,
                metadata: r.metadata,
            })),
            count: results.length,
        });
    } catch (err) {
        console.error('Semantic search error:', err.message);
        res.status(500).json({ error: `Search failed: ${err.message}` });
    }
});

// ============================================================
// Embeddings Management Endpoints
// ============================================================

// Get embedding stats
app.get('/api/embeddings/stats', async (req, res) => {
    try {
        if (!dbAvailable || !pgvectorAvailable) {
            return res.json({ success: true, stats: [] });
        }
        const stats = await getEmbeddingStats();
        res.json({ success: true, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate embeddings for all current data
app.post('/api/embeddings/generate', requireRole('admin'), async (req, res) => {
    if (!isEmbeddingsConfigured()) {
        return res.status(501).json({ error: 'Voyage API key not configured' });
    }

    if (!dbAvailable || !pgvectorAvailable) {
        return res.status(503).json({ error: 'Semantic search not available (pgvector required)' });
    }

    try {
        const data = await getAllContentForEmbedding();
        let siteCount = 0;
        let deviceCount = 0;

        // Embed sites
        if (data.sites.length > 0) {
            const siteEmbeddings = await embedSiteSnapshots(data.sites);
            for (const emb of siteEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
            siteCount = data.sites.length;
        }

        // Embed devices
        if (data.devices.length > 0) {
            const deviceEmbeddings = await embedPepwaveDevices(data.devices);
            for (const emb of deviceEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
            deviceCount = data.devices.length;
        }

        // Embed current alerts
        const alerts = computeAlerts();
        if (alerts.length > 0) {
            const alertEmbeddings = await embedAlerts(alerts);
            for (const emb of alertEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
        }

        // Embed maintenance logs
        let maintenanceCount = 0;
        if (data.maintenance && data.maintenance.length > 0) {
            const maintEmbeddings = await embedMaintenanceLogs(data.maintenance);
            for (const emb of maintEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
            maintenanceCount = data.maintenance.length;
        }

        // Embed job sites
        let jobSiteCount = 0;
        if (data.jobSites && data.jobSites.length > 0) {
            const jsEmbeddings = await embedJobSites(data.jobSites);
            for (const emb of jsEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
            jobSiteCount = data.jobSites.length;
        }

        res.json({
            success: true,
            sites_embedded: siteCount,
            devices_embedded: deviceCount,
            alerts_embedded: alerts.length,
            maintenance_embedded: maintenanceCount,
            job_sites_embedded: jobSiteCount,
        });
    } catch (err) {
        console.error('Embedding generation error:', err.message);
        res.status(500).json({ error: `Failed to generate embeddings: ${err.message}` });
    }
});

// ============================================================
// Action Queue (Priority-ranked unified alerts)
// ============================================================


app.get('/api/action-queue', async (req, res) => {
    try {
        const actions = [];
        const now = Date.now();

        // Source 1: Energy deficit alerts
        const alerts = computeAlerts();
        for (const alert of alerts) {
            const priority = alert.severity === 'critical' ? 1 : alert.severity === 'warning' ? 3 : 5;
            actions.push({
                key: `alert:${alert.site_id}`,
                priority,
                category: 'energy',
                title: `Energy Deficit — ${alert.streak_days} day streak`,
                subtitle: alert.site_name,
                site_id: alert.site_id,
                site_name: alert.site_name,
                severity: alert.severity,
                details: {
                    streak_days: alert.streak_days,
                    deficit_days: alert.deficit_days,
                    hasThrottledDays: alert.deficit_days.some(d => d.throttled),  // NEW
                },
                created_at: now,
            });
        }

        // Source 2: Intelligence flags (VRM-connected trailers only)
        for (const [siteId, snapshot] of snapshotCache) {
            if (!hasVrmData(snapshot)) continue;
            // Battery temp critical
            if (snapshot.battery_temp !== null && snapshot.battery_temp > 45) {
                actions.push({
                    key: `intel:temp:${siteId}`,
                    priority: 2,
                    category: 'intelligence',
                    title: `Battery Temp Critical — ${snapshot.battery_temp}°C`,
                    subtitle: snapshot.site_name,
                    site_id: siteId,
                    site_name: snapshot.site_name,
                    severity: 'critical',
                    details: { temp: snapshot.battery_temp },
                    created_at: now,
                });
            }

            // Low SOC (proxy for autonomy)
            if (snapshot.battery_soc !== null && snapshot.battery_soc < 15) {
                actions.push({
                    key: `intel:soc:${siteId}`,
                    priority: 2,
                    category: 'intelligence',
                    title: `Critical Battery — ${snapshot.battery_soc}% SOC`,
                    subtitle: snapshot.site_name,
                    site_id: siteId,
                    site_name: snapshot.site_name,
                    severity: 'critical',
                    details: { soc: snapshot.battery_soc },
                    created_at: now,
                });
            } else if (snapshot.battery_soc !== null && snapshot.battery_soc < 30) {
                actions.push({
                    key: `intel:soc:${siteId}`,
                    priority: 4,
                    category: 'intelligence',
                    title: `Low Battery — ${snapshot.battery_soc}% SOC`,
                    subtitle: snapshot.site_name,
                    site_id: siteId,
                    site_name: snapshot.site_name,
                    severity: 'warning',
                    details: { soc: snapshot.battery_soc },
                    created_at: now,
                });
            }
        }

        // Source 3: Maintenance overdue/upcoming
        if (dbAvailable) {
            try {
                const upcoming = await getUpcomingMaintenance(30);
                for (const item of upcoming) {
                    if (item.status === 'cancelled' || item.status === 'completed') continue;
                    const scheduled = item.scheduled_date;
                    if (!scheduled) continue;
                    const daysUntil = (scheduled - now) / 86400000;
                    let priority, severity;
                    if (daysUntil < 0) { priority = 2; severity = 'critical'; }
                    else if (daysUntil <= 3) { priority = 4; severity = 'warning'; }
                    else if (daysUntil <= 7) { priority = 6; severity = 'info'; }
                    else continue;
                    actions.push({
                        key: `maint:${item.id}`,
                        priority,
                        category: 'maintenance',
                        title: daysUntil < 0 ? `Overdue: ${item.title}` : `Due in ${Math.ceil(daysUntil)}d: ${item.title}`,
                        subtitle: item.job_site_name || item.site_name || 'Unassigned',
                        site_id: item.site_id,
                        site_name: item.site_name,
                        severity,
                        details: { maintenance_id: item.id, scheduled_date: scheduled, visit_type: item.visit_type },
                        created_at: item.created_at || now,
                    });
                }
            } catch { }
        }

        // Source: Predictive SOC depletion (VRM-connected trailers only)
        for (const [siteId, snapshot] of snapshotCache) {
            if (!hasVrmData(snapshot)) continue;
            const siteEnergy = dailyEnergy.get(siteId) || {};
            const today = todayStr();
            const pastDays = Object.entries(siteEnergy)
                .filter(([d]) => d < today)
                .sort(([a], [b]) => b.localeCompare(a))
                .slice(0, 7);
            const consumptionValues = pastDays.map(([, i]) => i.consumed_wh).filter(v => v !== null && v > 0);
            let avgConsumption = consumptionValues.length > 0
                ? consumptionValues.reduce((s, v) => s + v, 0) / consumptionValues.length
                : null;
            if (avgConsumption === null) {
                const todayData = siteEnergy[today];
                if (todayData?.consumed_wh > 0) avgConsumption = todayData.consumed_wh;
            }
            if (avgConsumption && avgConsumption > 0 && snapshot.battery_soc !== null) {
                const usableWh = Math.max(0, (snapshot.battery_soc - TRAILER_SPECS.battery.min_soc_threshold) * TRAILER_SPECS.battery.total_wh / 100);
                const daysToCritical = Math.round((usableWh / avgConsumption) * 10) / 10;
                if (daysToCritical <= 3) {
                    actions.push({
                        key: `predictive:soc:${siteId}`,
                        priority: daysToCritical <= 1 ? 1 : 2,
                        category: 'battery',
                        title: `SOC critical in ~${daysToCritical} days`,
                        subtitle: snapshot.site_name,
                        site_id: siteId,
                        details: `Current SOC: ${snapshot.battery_soc}%, avg consumption: ${Math.round(avgConsumption)}Wh/day`,
                    });
                }
            }
        }

        // Source: Geofence breaches and suggestions
        for (const [siteId, gf] of geofenceAlerts) {
            if (gf.unassigned_near_site) {
                actions.push({
                    key: `geofence:suggest:${siteId}`,
                    priority: 2,
                    category: 'network',
                    title: `Unassigned Trailer Near Site`,
                    subtitle: `${gf.site_name}`,
                    site_id: siteId,
                    details: `Trailer is ${gf.distance_m}m from ${gf.suggested_site.name}. Consider assigning it.`,
                });
            } else {
                let detailsMsg = `Trailer is ${gf.distance_m}m from assigned job site (radius: 500m).`;
                if (gf.suggested_site) {
                    detailsMsg += ` Suggestion: Assign to ${gf.suggested_site.name} (${gf.suggested_site.distance_m}m away).`;
                }
                actions.push({
                    key: `geofence:${siteId}`,
                    priority: 2,
                    category: 'network',
                    title: `Geofence breach: ${gf.distance_m}m from site`,
                    subtitle: `${gf.site_name} — ${gf.job_site_name}`,
                    site_id: siteId,
                    details: detailsMsg,
                });
            }
        }

        // Get acknowledged actions
        const acks = dbAvailable ? await getAcknowledgedActions() : [];
        const ackMap = new Map(acks.map(a => [a.action_key, a]));

        // Sort by priority, mark acknowledged
        actions.sort((a, b) => a.priority - b.priority);
        for (const action of actions) {
            const ack = ackMap.get(action.key);
            action.acknowledged = !!ack;
            if (ack) {
                action.acknowledged_by = ack.acknowledged_by_name;
                action.acknowledged_at = ack.acknowledged_at;
            }
        }

        const summary = {
            total: actions.length,
            critical: actions.filter(a => a.severity === 'critical').length,
            warning: actions.filter(a => a.severity === 'warning').length,
            info: actions.filter(a => !['critical', 'warning'].includes(a.severity)).length,
            acknowledged: actions.filter(a => a.acknowledged).length,
        };

        res.json({ success: true, actions, summary });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/action-queue/:key/acknowledge', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const ack = await dbAcknowledgeAction(decodeURIComponent(req.params.key), req.user.id, req.body.notes);
        res.json({ success: true, ack });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/action-queue/:key/acknowledge', requireRole('admin', 'technician'), async (req, res) => {
    try {
        await dbUnacknowledgeAction(decodeURIComponent(req.params.key));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Health Grades (attached to fleet combined)
// ============================================================

app.get('/api/fleet/health-grades', (req, res) => {
    const grades = {};
    for (const [siteId, snap] of snapshotCache) {
        if (!hasVrmData(snap)) continue;
        grades[siteId] = computeHealthGrade(siteId);
    }
    res.json({ success: true, grades });
});

app.get('/api/fleet/tech-status', (req, res) => {
    // Build deficit streak map once (reuse computeAlerts)
    const alertsMap = {};
    for (const alert of computeAlerts()) {
        alertsMap[alert.site_id] = alert.streak_days;
    }

    const statuses = {};
    // VRM-connected trailers
    for (const [siteId] of snapshotCache) {
        statuses[siteId] = computeTechStatus(siteId, alertsMap);
    }
    // IC2-only trailers (pepwave-only, no VRM snapshot)
    // Use negative device ID to match /api/sites key format
    for (const [name, dev] of pepwaveCache) {
        let covered = false;
        for (const [, snap] of snapshotCache) {
            if (snap.site_name === name) { covered = true; break; }
        }
        if (!covered) {
            statuses[-dev.id] = {
                status: dev.online ? 'good' : 'attention',
                reason: dev.online ? 'Network-only, Pepwave online' : 'Pepwave offline',
            };
        }
    }

    const summary = { good: 0, watch: 0, attention: 0 };
    for (const s of Object.values(statuses)) {
        if (s) summary[s.status]++;
    }

    res.json({ success: true, statuses, summary });
});

// ============================================================
// Checklist & Issue Template Routes
// ============================================================

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

// ============================================================
// Reports
// ============================================================

app.get('/api/reports/trailer/:id', async (req, res) => {
    try {
        const siteId = parseInt(req.params.id);
        const snapshot = snapshotCache.get(siteId);
        const intel = await computeTrailerIntelligence(siteId);
        const healthGrade = computeHealthGrade(siteId);
        const energyData = dailyEnergy.get(siteId) || {};
        const alertsList = computeAlerts().filter(a => a.site_id === siteId);

        let maintenance = [];
        let upcoming = [];
        let batteryHistory = [];
        if (dbAvailable) {
            try { maintenance = await getMaintenanceLogs({ site_id: siteId, limit: 20 }); } catch { }
            try { upcoming = (await getUpcomingMaintenance(30)).filter(m => m.site_id === siteId); } catch { }
            try { batteryHistory = await getBatteryHistory(siteId, 30); } catch { }
        }

        const energyHistory = Object.entries(energyData)
            .sort(([a], [b]) => b.localeCompare(a))
            .slice(0, 14)
            .map(([date, data]) => ({ date, ...data }));

        res.json({
            success: true,
            report: {
                generated_at: new Date().toISOString(),
                type: 'trailer',
                trailer: { site_id: siteId, site_name: snapshot?.site_name || `Site ${siteId}` },
                current_status: snapshot || null,
                health_grade: healthGrade,
                intelligence: intel,
                alerts: alertsList,
                maintenance: { recent: maintenance, upcoming },
                battery_history: batteryHistory,
                energy_history: energyHistory,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/reports/site/:id', async (req, res) => {
    try {
        const jobSiteId = parseInt(req.params.id);
        const jobSite = await getJobSite(jobSiteId);
        if (!jobSite) return res.status(404).json({ error: 'Job site not found' });

        const trailers = await getTrailersByJobSite(jobSiteId);
        const trailerSummaries = [];
        for (const t of trailers) {
            const snapshot = snapshotCache.get(t.site_id);
            const fresh = hasVrmData(snapshot);
            const grade = fresh ? computeHealthGrade(t.site_id) : null;
            trailerSummaries.push({
                site_id: t.site_id,
                site_name: t.site_name,
                health_grade: grade,
                battery_soc: fresh ? snapshot?.battery_soc : null,
                solar_watts: fresh ? snapshot?.solar_watts : null,
                yield_today: fresh ? snapshot?.solar_yield_today : null,
            });
        }

        let maintenance = [];
        if (dbAvailable) {
            try { maintenance = await getMaintenanceLogs({ job_site_id: jobSiteId, limit: 20 }); } catch { }
        }

        res.json({
            success: true,
            report: {
                generated_at: new Date().toISOString(),
                type: 'site',
                job_site: jobSite,
                trailers: trailerSummaries,
                maintenance: { recent: maintenance },
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/reports/fleet', async (req, res) => {
    try {
        const trailers = [];
        for (const [siteId, snapshot] of snapshotCache) {
            if (!hasVrmData(snapshot)) continue; // skip connectivity-only trailers
            const intel = await computeTrailerIntelligence(siteId);
            trailers.push({
                site_id: siteId,
                site_name: snapshot.site_name,
                health_grade: computeHealthGrade(siteId),
                battery_soc: snapshot.battery_soc,
                battery_voltage: snapshot.battery_voltage,
                solar_watts: snapshot.solar_watts,
                yield_today: snapshot.solar_yield_today,
                charge_state: snapshot.charge_state,
                intelligence: intel,
            });
        }

        const alerts = computeAlerts();
        let stats = null;
        let energyTrends = [];
        if (dbAvailable) {
            try { stats = await getMaintenanceStats(); } catch { }
            try { energyTrends = await getAllDailyEnergy(14); } catch { }
        }

        // Aggregate KPIs
        const onlineTrailers = trailers.filter(t => t.battery_soc != null);
        const avgSoc = onlineTrailers.length > 0
            ? onlineTrailers.reduce((s, t) => s + t.battery_soc, 0) / onlineTrailers.length : 0;
        const totalYieldToday = trailers.reduce((s, t) => s + (t.yield_today || 0), 0);
        const gradeDistribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
        for (const t of trailers) {
            const g = t.health_grade?.grade;
            if (g && gradeDistribution[g] !== undefined) gradeDistribution[g]++;
        }

        // Group energy trends by date for fleet totals
        const energyByDate = {};
        for (const e of energyTrends) {
            const d = e.date;
            if (!energyByDate[d]) energyByDate[d] = { date: d, yield_wh: 0, consumed_wh: 0 };
            energyByDate[d].yield_wh += parseFloat(e.yield_wh) || 0;
            energyByDate[d].consumed_wh += parseFloat(e.consumed_wh) || 0;
        }

        res.json({
            success: true,
            report: {
                generated_at: new Date().toISOString(),
                type: 'fleet',
                kpis: {
                    total_trailers: trailers.length,
                    online: onlineTrailers.length,
                    avg_soc: Math.round(avgSoc * 10) / 10,
                    total_yield_today_kwh: Math.round(totalYieldToday) / 1000,
                    active_alerts: alerts.length,
                },
                grade_distribution: gradeDistribution,
                trailers,
                alerts,
                energy_trends: Object.values(energyByDate).sort((a, b) => a.date.localeCompare(b.date)),
                maintenance_stats: stats,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Customer Portal ---
app.get('/api/portal/sites', async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'customer') {
            return res.status(403).json({ error: 'Customer access only' });
        }
        const access = await getCustomerSiteAccess(req.user.id);
        const siteIds = access.map(a => a.job_site_id);
        if (siteIds.length === 0) return res.json({ sites: [] });

        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

        // Build a map of site_id -> job_site_id from trailer_assignments
        const trailerToJobSite = new Map();
        for (const a of assignments) {
            if (a.job_site_id != null) {
                trailerToJobSite.set(a.site_id, a.job_site_id);
            }
        }

        const sites = jobSites
            .filter(js => siteIds.includes(js.id))
            .map(js => {
                const trailers = [];
                // Find VRM-connected trailers assigned to this job site
                for (const [siteId, snap] of snapshotCache) {
                    if (trailerToJobSite.get(siteId) === js.id && hasVrmData(snap)) {
                        trailers.push({
                            site_id: siteId,
                            site_name: snap.site_name,
                            battery_soc: snap.battery_soc,
                            solar_watts: snap.solar_watts,
                            solar_yield_today: snap.solar_yield_today,
                        });
                    }
                }
                const onlineTrailers = trailers.filter(t => t.battery_soc != null);
                const avgSoc = onlineTrailers.length > 0
                    ? Math.round(onlineTrailers.reduce((s, t) => s + t.battery_soc, 0) / onlineTrailers.length)
                    : null;
                return {
                    id: js.id,
                    name: js.name,
                    status: js.status,
                    address: js.address,
                    trailer_count: trailers.length,
                    trailers_online: onlineTrailers.length,
                    avg_soc: avgSoc,
                    trailers,
                    worst_status: trailers.some(t => t.battery_soc != null && t.battery_soc < 20) ? 'critical'
                        : trailers.some(t => t.battery_soc != null && t.battery_soc < 50) ? 'warning' : 'ok',
                };
            });
        res.json({ sites });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/portal/site/:id', async (req, res) => {
    try {
        if (!req.user || req.user.role !== 'customer') {
            return res.status(403).json({ error: 'Customer access only' });
        }
        const siteId = parseInt(req.params.id);
        const access = await getCustomerSiteAccess(req.user.id);
        if (!access.some(a => a.job_site_id === siteId)) {
            return res.status(403).json({ error: 'No access to this site' });
        }
        const js = await getJobSite(siteId);
        if (!js) return res.status(404).json({ error: 'Site not found' });

        const siteAssignments = await getTrailersByJobSite(siteId);
        const trailers = siteAssignments
            .filter(a => hasVrmData(snapshotCache.get(a.site_id)))
            .map(a => {
                const snap = snapshotCache.get(a.site_id);
                return {
                    site_id: a.site_id,
                    site_name: a.site_name,
                    battery_soc: snap?.battery_soc ?? null,
                    solar_watts: snap?.solar_watts ?? null,
                    solar_yield_today: snap?.solar_yield_today ?? null,
                };
            });
        const onlineTrailers = trailers.filter(t => t.battery_soc != null);
        const avgSoc = onlineTrailers.length > 0
            ? Math.round(onlineTrailers.reduce((s, t) => s + t.battery_soc, 0) / onlineTrailers.length)
            : null;

        // Source contact info from CRM instead of legacy job_sites columns
        const siteContacts = await getSiteContacts(siteId);
        const primaryContact = siteContacts.find(c => c.is_primary) || siteContacts[0];

        res.json({
            site: {
                ...js,
                primary_contact_name: primaryContact?.name || null,
                primary_contact_phone: primaryContact?.phone || null,
                trailer_count: trailers.length,
                trailers_online: onlineTrailers.length,
                avg_soc: avgSoc,
                trailers,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: manage customer site access
app.get('/api/customers/:userId/sites', requireRole('admin'), async (req, res) => {
    try {
        const access = await getCustomerSiteAccess(parseInt(req.params.userId));
        res.json({ sites: access.map(a => a.job_site_id) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/customers/:userId/sites', requireRole('admin'), async (req, res) => {
    try {
        const { site_ids } = req.body;
        if (!Array.isArray(site_ids)) return res.status(400).json({ error: 'site_ids must be an array' });
        await upsertCustomerSiteAccess(parseInt(req.params.userId), site_ids);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Digest Preview ---
app.get('/api/reports/digest-preview', requireRole('admin'), async (req, res) => {
    try {
        const data = await buildDigestData();
        res.json({ success: true, digest: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check SendGrid configuration status
app.get('/api/email-config-status', requireRole('admin'), (req, res) => {
    const configured = isEmailConfigured();
    const recipients = (process.env.ALERT_EMAIL_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean);
    const fromEmail = process.env.ALERT_FROM_EMAIL || 'noreply@bigview.ai';
    const hasApiKey = Boolean(process.env.SENDGRID_API_KEY);
    const apiKeyPrefix = hasApiKey ? process.env.SENDGRID_API_KEY.substring(0, 10) + '...' : null;

    res.json({
        success: true,
        configured,
        config: {
            hasApiKey,
            apiKeyPrefix,
            fromEmail,
            recipients,
            recipientCount: recipients.length
        }
    });
});

// Send test email to verify SendGrid configuration
app.post('/api/test-email', requireRole('admin'), async (req, res) => {
    try {
        if (!isEmailConfigured()) {
            return res.status(400).json({
                success: false,
                error: 'SendGrid not configured. Set SENDGRID_API_KEY, ALERT_FROM_EMAIL, and ALERT_EMAIL_RECIPIENTS in environment variables.'
            });
        }

        const { type = 'alert' } = req.body;

        if (type === 'alert') {
            // Send a test energy deficit alert
            const testAlert = {
                site_id: 999999,
                site_name: 'Test Trailer (SendGrid Test)',
                streak_days: 3,
                severity: 'warning',
                deficit_days: [
                    { date: '2026-03-03', yield_wh: 1500, consumed_wh: 3200, deficit_wh: 1700 },
                    { date: '2026-03-04', yield_wh: 1800, consumed_wh: 3500, deficit_wh: 1700 },
                    { date: '2026-03-05', yield_wh: 1200, consumed_wh: 2800, deficit_wh: 1600 },
                ]
            };
            await sendAlertEmail(testAlert);
        } else if (type === 'digest') {
            // Send test daily digest
            const data = await buildDigestData();
            const recipients = (process.env.ALERT_EMAIL_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean);
            if (recipients.length === 0) {
                return res.status(400).json({ success: false, error: 'No ALERT_EMAIL_RECIPIENTS configured' });
            }
            await sendDigestEmail(recipients, data);
        } else if (type === 'geofence') {
            // Send test geofence alert
            const testGeofence = {
                site_name: 'Test Trailer (SendGrid Test)',
                job_site_name: 'Test Job Site, Colorado',
                distance_m: 750,
                geofence_radius_m: 500,
            };
            await sendGeofenceEmail(testGeofence);
        } else {
            return res.status(400).json({ success: false, error: 'Invalid type. Use: alert, digest, or geofence' });
        }

        res.json({
            success: true,
            message: `Test ${type} email sent successfully`,
            recipients: (process.env.ALERT_EMAIL_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean)
        });
    } catch (err) {
        console.error('Test email error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});


// --- SPA fallback ---
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(distPath, 'index.html'));
    }
});

// Global error handler — sanitize errors in production
app.use((err, req, res, _next) => {
    console.error('Unhandled route error:', err.stack || err.message);
    const status = err.status || 500;
    res.status(status).json({
        error: process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : err.message,
    });
});

// --- Start ---
async function start() {
    try {
        setDbPool(await initDb());
        setDbAvailable(true);
        console.log('PostgreSQL database connected');
        // Check if pgvector / fleet_embeddings table exists
        try {
            await dbPool.query(`SELECT 1 FROM fleet_embeddings LIMIT 0`);
            setPgvectorAvailable(true);
        } catch {
            setPgvectorAvailable(false);
        }
    } catch (err) {
        setDbAvailable(false);
        console.warn('PostgreSQL not available — using in-memory cache only');
        console.warn('Set DATABASE_URL to enable persistent history');
        console.error('Database connection error:', err.message);
    }

    // Load configurable settings
    if (dbAvailable) {
        await loadSolarScoreConfig();
    }

    // Seed daily energy from DB before polling starts
    if (dbAvailable) {
        await seedDailyEnergyFromDb();

        // Seed default admin user if no users exist
        try {
            const users = await getUsers();
            if (users.length === 0) {
                const hash = await bcrypt.hash('admin123', 10);
                await createUser('admin', hash, 'Administrator', 'admin');
                console.log('  ✓ Default admin user created (username: admin, password: admin123)');
            }
        } catch (seedErr) {
            console.warn('  ⚠ Could not seed admin user:', seedErr.message);
        }

        // Load IC2 device linkages into memory
        try {
            const assignments = await getTrailerAssignments();
            for (const a of assignments) {
                if (a.ic2_device_id != null) {
                    ic2DeviceIdToSiteId.set(a.ic2_device_id, a.site_id);
                }
            }
            console.log(`  ✓ Loaded ${ic2DeviceIdToSiteId.size} IC2 device linkages`);
        } catch (linkErr) {
            console.warn('  ⚠ Could not load IC2 linkages:', linkErr.message);
        }
    }

    // Schedule email digest
    scheduleDigest();

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });

    // Initial VRM poll after 3 seconds
    setTimeout(pollAllSites, 3000);
    setInterval(pollAllSites, 5 * 60 * 1000);

    // Initial IC2 poll after 5 seconds (stagger from VRM)
    if (IC2_CLIENT_ID && IC2_CLIENT_SECRET) {
        setTimeout(pollIc2Devices, 5000);
        setInterval(pollIc2Devices, 5 * 60 * 1000);
        console.log('InControl2 polling enabled');
    } else {
        console.warn('IC2_CLIENT_ID / IC2_CLIENT_SECRET not set — Pepwave polling disabled');
    }
}

// Graceful shutdown and crash handlers
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
});
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    process.exit(0);
});
process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down...');
    process.exit(0);
});

start().catch(console.error);
