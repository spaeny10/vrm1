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
import { registerAuthRoutes } from './routes/auth.js';
import { registerUsersRoutes } from './routes/users.js';
import { registerSitesRoutes } from './routes/sites.js';
import { registerFleetRoutes } from './routes/fleet.js';
import { registerNetworkRoutes } from './routes/network.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerRentalsRoutes } from './routes/rentals.js';
import { registerJobsitesRoutes } from './routes/jobsites.js';
import { registerCrmRoutes } from './routes/crm.js';
import { registerCommsRoutes } from './routes/comms.js';
import { registerGpsRoutes } from './routes/gps.js';
import { registerMaintenanceRoutes } from './routes/maintenance.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerActionsRoutes } from './routes/actions.js';
import { registerReportsRoutes } from './routes/reports.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerDigestRoutesRoutes } from './routes/digestRoutes.js';

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

// --- Route modules (order preserved from the original monolith) ---
registerAuthRoutes(app);
registerUsersRoutes(app);
registerSitesRoutes(app);
registerFleetRoutes(app);
registerNetworkRoutes(app);
registerSettingsRoutes(app);
registerRentalsRoutes(app);
registerJobsitesRoutes(app);
registerCrmRoutes(app);
registerCommsRoutes(app);
registerGpsRoutes(app);
registerMaintenanceRoutes(app);
registerAnalyticsRoutes(app);
registerAiRoutes(app);
registerActionsRoutes(app);
registerReportsRoutes(app);
registerPortalRoutes(app);
registerDigestRoutesRoutes(app);


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


// User management (admin only)


// --- API routes ---


// ============================================================
// Fleet Deployment Summary
// ============================================================


// ============================================================
// Trailers (rental fleet assets)
// ============================================================


// ============================================================
// Rentals & Billing
// ============================================================


// ---- Rate-card pricing context (FY2026 commercial structure) ----


// ============================================================
// Job Sites API
// ============================================================


// ============================================================
// GPS Change Suggestions
// ============================================================


// ============================================================
// Twilio Webhooks
// ============================================================


// --- GPS Verification ---


// ============================================================
// Recurring Maintenance Helper
// ============================================================


// ============================================================
// Maintenance API
// ============================================================




// ============================================================
// Trailer Components API
// ============================================================


// ============================================================
// Analytics API
// ============================================================


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
// Embeddings Management Endpoints
// ============================================================


// ============================================================
// Action Queue (Priority-ranked unified alerts)
// ============================================================


// ============================================================
// Health Grades (attached to fleet combined)
// ============================================================


// ============================================================
// Checklist & Issue Template Routes
// ============================================================


// ============================================================
// Reports
// ============================================================


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
                // must_change_password: force rotation of the well-known seed password
                await createUser('admin', hash, 'Administrator', 'admin', true);
                console.log('  ✓ Default admin user created (username: admin, password: admin123 — must be changed on first login)');
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
