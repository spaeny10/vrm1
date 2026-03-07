import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import {
    initDb, insertSnapshot, getHistory, getLatestSnapshots,
    getRetentionDays, setRetentionDays, getSetting, setSetting, pruneOldData, getDbStats,
    insertPepwaveSnapshot, getPepwaveHistory, getPepwaveDailyUsage,
    upsertEmbedding, semanticSearch, getEmbeddingStats, getAllContentForEmbedding,
    getJobSites, getJobSite, insertJobSite, updateJobSite,
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
} from './db.js';
import {
    generateQueryEmbedding, embedSiteSnapshots, embedPepwaveDevices,
    embedAlerts, embedMaintenanceLogs, embedJobSites,
    isConfigured as isEmbeddingsConfigured
} from './embeddings.js';
import { runClustering, haversineMeters } from './clustering.js';
import {
    isEmailConfigured, sendAlertEmail, sendAlertResolvedEmail,
    sendGeofenceEmail, sendDigestEmail, checkRateLimit, markNotified
} from './email.js';
import cron from 'node-cron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const VRM_TOKEN = process.env.VRM_API_TOKEN;
const VRM_USER_ID = process.env.VRM_USER_ID;
const VRM_BASE = 'https://vrmapi.victronenergy.com/v2';

// InControl2 credentials
const IC2_CLIENT_ID = process.env.IC2_CLIENT_ID;
const IC2_CLIENT_SECRET = process.env.IC2_CLIENT_SECRET;
const IC2_BASE = 'https://api.ic.peplink.com';
const IC2_ORG_ID = 'VdYVxn';
const IC2_GROUP_ID = 1;

// Claude API for natural language queries
const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;

// JWT Authentication
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is required in production');
    process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'vrm-fleet-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '24h';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_GOOGLE_DOMAIN = 'jetstreamsys.com';

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:3000'];
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? allowedOrigins : true,
    credentials: true,
}));
app.use(express.json());

// --- In production, serve the built React frontend ---
const distPath = path.join(__dirname, '..', 'dist');
app.use(express.static(distPath));

// Rate limiters
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'Too many login attempts, try again in 15 minutes' } });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Too many AI requests, try again in a minute' } });

// Apply auth to all /api routes except login
app.use('/api', (req, res, next) => {
    if (req.path === '/auth/login' || req.path === '/auth/google' || req.path === '/health') return next();
    authMiddleware(req, res, next);
});

// Health check (unauthenticated, for Railway/uptime monitors)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        db: dbAvailable ? 'connected' : 'disconnected',
        trailers_cached: snapshotCache.size,
    });
});

// --- VRM API helper ---
const vrmHeaders = { 'x-authorization': `Token ${VRM_TOKEN}` };

async function vrmFetch(endpoint) {
    const res = await fetch(`${VRM_BASE}${endpoint}`, { headers: vrmHeaders });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`VRM API ${res.status}: ${text}`);
    }
    return res.json();
}

// ============================================================
// InControl2 OAuth2 Token Management
// ============================================================
let ic2Token = null;
let ic2TokenExpiry = 0;
let ic2RefreshToken = null;

async function getIc2Token() {
    // Return cached token if still valid (with 5 min buffer)
    if (ic2Token && Date.now() < ic2TokenExpiry - 300000) {
        return ic2Token;
    }

    // Try refresh first
    if (ic2RefreshToken) {
        try {
            const res = await fetch(`${IC2_BASE}/api/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `client_id=${IC2_CLIENT_ID}&client_secret=${IC2_CLIENT_SECRET}&grant_type=refresh_token&refresh_token=${ic2RefreshToken}`,
            });
            if (res.ok) {
                const data = await res.json();
                ic2Token = data.access_token;
                ic2RefreshToken = data.refresh_token;
                ic2TokenExpiry = Date.now() + data.expires_in * 1000;
                console.log(`  IC2 token refreshed (expires in ${(data.expires_in / 3600).toFixed(0)}h)`);
                return ic2Token;
            }
        } catch (e) { /* fall through to full auth */ }
    }

    // Full client_credentials auth
    const res = await fetch(`${IC2_BASE}/api/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `client_id=${IC2_CLIENT_ID}&client_secret=${IC2_CLIENT_SECRET}&grant_type=client_credentials`,
    });
    if (!res.ok) {
        throw new Error(`IC2 auth failed: ${res.status}`);
    }
    const data = await res.json();
    ic2Token = data.access_token;
    ic2RefreshToken = data.refresh_token;
    ic2TokenExpiry = Date.now() + data.expires_in * 1000;
    console.log(`  IC2 token obtained (expires in ${(data.expires_in / 3600).toFixed(0)}h)`);
    return ic2Token;
}

async function ic2Fetch(endpoint, retryOn401 = true) {
    const token = await getIc2Token();
    const res = await fetch(`${IC2_BASE}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const text = await res.text();
        // On 401, invalidate token and retry once
        if (res.status === 401 && retryOn401) {
            console.log('  IC2 token invalid, refreshing...');
            ic2Token = null;
            ic2TokenExpiry = 0;
            return ic2Fetch(endpoint, false); // Retry without further recursion
        }
        throw new Error(`IC2 API ${res.status}: ${text}`);
    }
    return res.json();
}

// --- Caches ---
let sitesCache = null;
let sitesCacheTime = 0;
const SITES_CACHE_TTL = 5 * 60 * 1000;

// In-memory snapshot cache: siteId -> latest snapshot data
const snapshotCache = new Map();
let dbAvailable = false;
let pgvectorAvailable = false;

// Pepwave device cache: deviceName -> device data
const pepwaveCache = new Map();
const ic2DeviceIdToSiteId = new Map();  // ic2DeviceId -> siteId (persistent linkage)
const ic2DeviceIdToName = new Map();    // ic2DeviceId -> deviceName (for pepwave lookups)
let lastIc2Poll = 0;
let dbPool = null;
let bandwidthLoggedOnce = false;

// GPS cache: siteId -> { latitude, longitude, updatedAt }
const gpsCache = new Map();
let initialClusteringDone = false;

// SOC-at-start-of-day cache: siteId -> { date, soc }
// Used to estimate daily consumption when CE diagnostic is unavailable
const socStartOfDay = new Map();

// Consumption accumulator: siteId -> { date, wh, lastTimestamp }
// Integrates DC load power over time when CE diagnostic unavailable
const consumptionAccumulator = new Map();

// ============================================================
// Helper: does this trailer have actual VRM/Victron data?
// Trailers with only Peplink (no Victron) show 0%/null for everything and should be
// excluded from energy/solar/battery KPIs.
function hasVrmData(snapshot) {
    if (!snapshot) return false;
    return snapshot.battery_voltage != null || snapshot.solar_watts != null
        || (snapshot.battery_soc != null && snapshot.battery_soc > 0);
}

// Trailer Hardware Specifications
// ============================================================
const TRAILER_SPECS = {
    solar: { panels: 3, panel_watts: 435, total_watts: 1305, system_efficiency: 0.70 },
    battery: { chemistry: 'LiFePO4', count: 2, config: 'parallel', ah_per_battery: 230, voltage: 25.6, total_ah: 460, total_wh: 11776, min_soc_threshold: 20, usable_wh: 9421 },
};

// ============================================================
// Solar Score Configuration (configurable from Settings page)
// ============================================================
const SOLAR_SCORE_DEFAULTS = {
    throttle_soc_threshold: 95,    // SOC % above which throttling is detected
    throttle_floor_soc: 98,        // SOC % above which minimum score floor applies
    throttle_floor_score: 80,      // Minimum score when floor condition met
    throttle_panel_min_pct: 10,    // Panel output % threshold to confirm system health
    score_excellent: 80,           // Score threshold for "Excellent"
    score_good: 60,                // Score threshold for "Good"
    score_fair: 40,                // Score threshold for "Fair"
};
let solarScoreConfig = { ...SOLAR_SCORE_DEFAULTS };

async function loadSolarScoreConfig() {
    if (!dbAvailable) return;
    try {
        for (const key of Object.keys(SOLAR_SCORE_DEFAULTS)) {
            const val = await getSetting(`solar_${key}`, null);
            if (val !== null) solarScoreConfig[key] = parseFloat(val);
        }
        console.log('Solar score config loaded:', solarScoreConfig);
    } catch (err) {
        console.log('Solar score config: using defaults', err.message);
    }
}

// ============================================================
// Weather / Solar Irradiance Cache (Open-Meteo, free, no API key)
// Key: "lat,lon" (rounded to 0.1°), Value: { data, fetchedAt }
// ============================================================
const weatherCache = new Map();
const WEATHER_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchSolarIrradiance(latitude, longitude) {
    const cacheKey = `${Math.round(latitude * 10) / 10},${Math.round(longitude * 10) / 10}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < WEATHER_CACHE_TTL) {
        return cached.data;
    }

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}`
            + `&daily=shortwave_radiation_sum,sunshine_duration,temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code`
            + `&current=cloud_cover,temperature_2m,weather_code,wind_speed_10m`
            + `&timezone=auto&forecast_days=3`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
        const json = await res.json();

        const radiationMJ = json.daily?.shortwave_radiation_sum?.[0] ?? null;
        const sunshineSec = json.daily?.sunshine_duration?.[0] ?? null;
        const cloudCover = json.current?.cloud_cover ?? null;

        const data = {
            peak_sun_hours: radiationMJ !== null ? Math.round((radiationMJ / 3.6) * 100) / 100 : null,
            sunshine_hours: sunshineSec !== null ? Math.round((sunshineSec / 3600) * 10) / 10 : null,
            cloud_cover_pct: cloudCover,
            data_source: 'open-meteo',
            temperature_current: json.current?.temperature_2m ?? null,
            weather_code: json.current?.weather_code ?? null,
            wind_speed_kmh: json.current?.wind_speed_10m ?? null,
            precipitation_mm: json.daily?.precipitation_sum?.[0] ?? null,
            forecast_3d: json.daily ? {
                dates: json.daily.time,
                weather_codes: json.daily.weather_code,
                temp_max: json.daily.temperature_2m_max,
                temp_min: json.daily.temperature_2m_min,
                radiation: json.daily.shortwave_radiation_sum,
                precipitation: json.daily.precipitation_sum,
            } : null,
        };

        weatherCache.set(cacheKey, { data, fetchedAt: Date.now() });
        return data;
    } catch (err) {
        // Fallback to astronomical calculation
        const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
        const fallback = {
            peak_sun_hours: computeAstronomicalPSH(latitude, dayOfYear),
            sunshine_hours: null,
            cloud_cover_pct: null,
            data_source: 'astronomical',
        };
        weatherCache.set(cacheKey, { data: fallback, fetchedAt: Date.now() - WEATHER_CACHE_TTL + 600000 }); // retry in 10 min
        return fallback;
    }
}

function computeAstronomicalPSH(latitude, dayOfYear) {
    const toRad = (deg) => deg * Math.PI / 180;
    const toDeg = (rad) => rad * 180 / Math.PI;
    // Solar declination angle
    const declination = 23.45 * Math.sin(toRad(360 / 365 * (284 + dayOfYear)));
    const latRad = toRad(latitude);
    const declRad = toRad(declination);
    // Sunset hour angle
    const cosOmega = -Math.tan(latRad) * Math.tan(declRad);
    if (cosOmega > 1) return 0;   // polar night
    if (cosOmega < -1) return 12; // midnight sun
    const omega = toDeg(Math.acos(cosOmega));
    // Day length in hours
    const dayLength = 2 * omega / 15;
    // Clear-sky PSH estimate (atmospheric attenuation ~60%)
    return Math.round(dayLength * 0.60 * 100) / 100;
}

// ============================================================
// Trailer Intelligence Computation (spec + location aware)
// ============================================================
async function computeTrailerIntelligence(siteId) {
    const snapshot = snapshotCache.get(siteId);
    if (!snapshot) return null;

    const specs = TRAILER_SPECS;

    // --- Location & Weather ---
    const gps = gpsCache.get(siteId);
    let weather = null;
    if (gps) {
        try { weather = await fetchSolarIrradiance(gps.latitude, gps.longitude); } catch {}
    }
    const peakSunHours = weather?.peak_sun_hours ?? 5; // fallback to 5h US average

    // --- Location-adjusted expected yield ---
    const expectedDailyYieldWh = specs.solar.total_watts * peakSunHours * specs.solar.system_efficiency;

    // --- Solar Score (yesterday's completed day, not today's moving target) ---
    const actualYieldTodayWh = snapshot.solar_yield_today !== null ? snapshot.solar_yield_today * 1000 : null;
    const todayLiveScore = (actualYieldTodayWh !== null && expectedDailyYieldWh > 0)
        ? Math.round((actualYieldTodayWh / expectedDailyYieldWh) * 1000) / 10
        : null;

    // --- Panel performance (instantaneous) ---
    const panelPerformance = snapshot.solar_watts !== null
        ? Math.round((snapshot.solar_watts / specs.solar.total_watts) * 1000) / 10
        : null;

    // --- Historical data from dailyEnergy ---
    const siteEnergy = dailyEnergy.get(siteId) || {};
    const today = todayStr();
    const pastDays = Object.entries(siteEnergy)
        .filter(([d]) => d < today)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 7);

    let avgDailyConsumptionWh = null;
    if (pastDays.length > 0) {
        const consumptionValues = pastDays.map(([, i]) => i.consumed_wh).filter(v => v !== null && v > 0);
        if (consumptionValues.length > 0) {
            avgDailyConsumptionWh = Math.round(consumptionValues.reduce((s, v) => s + v, 0) / consumptionValues.length);
        }
    }
    // Fallback: use today's estimated consumption if no historical data yet
    if (avgDailyConsumptionWh === null) {
        const todayData = siteEnergy[today];
        if (todayData?.consumed_wh !== null && todayData?.consumed_wh > 0) {
            avgDailyConsumptionWh = Math.round(todayData.consumed_wh);
        }
    }

    let avgDailyYieldWh = null;
    if (pastDays.length > 0) {
        const yieldValues = pastDays.map(([, i]) => i.yield_wh).filter(v => v !== null && v > 0);
        if (yieldValues.length > 0) {
            avgDailyYieldWh = Math.round(yieldValues.reduce((s, v) => s + v, 0) / yieldValues.length);
        }
    }

    // --- 7-day average score: per-day scores using each day's stored expected yield ---
    let avg7dScore = null;
    if (pastDays.length > 0) {
        const dayScores = pastDays
            .filter(([, d]) => d.yield_wh != null && d.yield_wh > 0)
            .map(([, d]) => {
                const exp = d.expected_yield_wh || expectedDailyYieldWh;
                return exp > 0 ? (d.yield_wh / exp) * 100 : null;
            })
            .filter(v => v !== null);
        if (dayScores.length > 0) {
            avg7dScore = Math.round(dayScores.reduce((s, v) => s + v, 0) / dayScores.length * 10) / 10;
        }
    }

    // --- Yesterday's score (primary — uses yesterday's stored expected yield) ---
    const yesterdayEntry = pastDays.length > 0 ? pastDays[0] : null; // pastDays sorted newest-first
    const yesterdayYieldWh = yesterdayEntry ? yesterdayEntry[1].yield_wh : null;
    const yesterdayExpectedWh = yesterdayEntry?.[1]?.expected_yield_wh || expectedDailyYieldWh;
    const solarScore = (yesterdayYieldWh !== null && yesterdayExpectedWh > 0)
        ? Math.round((yesterdayYieldWh / yesterdayExpectedWh) * 1000) / 10
        : todayLiveScore; // fallback to today's live score if no yesterday data

    // --- Throttle-aware solar score adjustment ---
    // Victron MPPT charge states: 0=Off, 1=Low power, 2=Fault, 3=Bulk, 4=Absorption,
    // 5=Float, 6=Storage, 7=Equalize, 252=External control
    // When in Float/Storage/Idle, the MPPT throttles production — yield is artificially low.
    const cfg = solarScoreConfig;
    const chargeState = snapshot.charge_state;
    const csNum = typeof chargeState === 'string' ? parseInt(chargeState, 10) : chargeState;
    const isThrottled = (typeof csNum === 'number' && !isNaN(csNum) && (csNum === 5 || csNum === 6))
        || (typeof chargeState === 'string' && /float|idle|storage|external/i.test(chargeState));
    const isHighSoc = snapshot.battery_soc !== null && snapshot.battery_soc >= cfg.throttle_soc_threshold;

    let adjustedSolarScore = solarScore;
    let scoreAdjustmentReason = null;

    if (isThrottled && isHighSoc && solarScore !== null && solarScore < cfg.score_excellent) {
        // Use best estimate: raw score, 7-day average, or panel-health indicator
        const panelHealthScore = (panelPerformance !== null && panelPerformance > cfg.throttle_panel_min_pct)
            ? cfg.score_excellent : 0;
        const bestEstimate = Math.max(solarScore, avg7dScore ?? 0, panelHealthScore);

        if (bestEstimate > solarScore) {
            adjustedSolarScore = Math.min(Math.round(bestEstimate * 10) / 10, 100);
            scoreAdjustmentReason = 'throttled_full_battery';
        }

        // Floor: if SOC >= floor threshold and still below floor score
        if (snapshot.battery_soc >= cfg.throttle_floor_soc && adjustedSolarScore < cfg.throttle_floor_score) {
            adjustedSolarScore = cfg.throttle_floor_score;
            scoreAdjustmentReason = 'full_battery_floor';
        }
    }

    // --- Days of autonomy ---
    const currentStoredWh = snapshot.battery_soc !== null ? Math.round(specs.battery.total_wh * snapshot.battery_soc / 100) : null;
    const daysOfAutonomy = (currentStoredWh !== null && avgDailyConsumptionWh !== null && avgDailyConsumptionWh > 0)
        ? Math.round((currentStoredWh / avgDailyConsumptionWh) * 10) / 10
        : null;

    // --- Predictive: days until SOC hits critical threshold ---
    const criticalSocPct = specs.battery.min_soc_threshold; // 20%
    const usableAboveCriticalWh = snapshot.battery_soc !== null && avgDailyConsumptionWh !== null && avgDailyConsumptionWh > 0
        ? Math.max(0, (snapshot.battery_soc - criticalSocPct) * specs.battery.total_wh / 100)
        : null;
    const predictedDaysToCritical = usableAboveCriticalWh !== null && avgDailyConsumptionWh > 0
        ? Math.round((usableAboveCriticalWh / avgDailyConsumptionWh) * 10) / 10
        : null;

    // --- Charge time estimate ---
    const remainingToFullWh = snapshot.battery_soc !== null ? Math.round(specs.battery.total_wh * (1 - snapshot.battery_soc / 100)) : null;
    const currentSolarW = snapshot.solar_watts || 0;
    const chargeTimeHours = (remainingToFullWh !== null && currentSolarW > 50)
        ? Math.round((remainingToFullWh / currentSolarW) * 10) / 10
        : null;

    // --- Battery temp status ---
    const bt = snapshot.battery_temp;
    const batteryTempStatus = bt !== null
        ? (bt > 45 ? 'critical' : bt > 35 ? 'warning' : bt < 5 ? 'cold' : 'normal')
        : null;

    // --- Energy balance today ---
    const todayEnergy = siteEnergy[today] || {};
    const todayYieldWh = todayEnergy.yield_wh ?? actualYieldTodayWh;
    const todayConsumedWh = todayEnergy.consumed_wh ?? null;
    const energyBalanceWh = (todayYieldWh !== null && todayConsumedWh !== null) ? Math.round(todayYieldWh - todayConsumedWh) : null;

    return {
        site_id: siteId,
        site_name: snapshot.site_name,
        timestamp: Date.now(),
        specs: {
            solar_capacity_w: specs.solar.total_watts,
            battery_capacity_wh: specs.battery.total_wh,
            usable_capacity_wh: specs.battery.usable_wh,
        },
        location: {
            latitude: gps?.latitude ?? null,
            longitude: gps?.longitude ?? null,
            peak_sun_hours: peakSunHours,
            cloud_cover_pct: weather?.cloud_cover_pct ?? null,
            sunshine_hours: weather?.sunshine_hours ?? null,
            data_source: weather?.data_source ?? 'default',
            expected_daily_yield_wh: Math.round(expectedDailyYieldWh),
        },
        solar: {
            score: adjustedSolarScore,
            raw_score: solarScore,
            score_label: adjustedSolarScore !== null
                ? (adjustedSolarScore >= cfg.score_excellent ? 'Excellent'
                    : adjustedSolarScore >= cfg.score_good ? 'Good'
                    : adjustedSolarScore >= cfg.score_fair ? 'Fair' : 'Poor')
                : null,
            throttled: isThrottled,
            score_adjustment_reason: scoreAdjustmentReason,
            today_live_score: todayLiveScore,
            panel_performance_pct: panelPerformance,
            current_watts: snapshot.solar_watts,
            yield_today_wh: actualYieldTodayWh !== null ? Math.round(actualYieldTodayWh) : null,
            yield_yesterday_wh: yesterdayYieldWh !== null ? Math.round(yesterdayYieldWh) : null,
            expected_yesterday_wh: Math.round(yesterdayExpectedWh),
            avg_7d_yield_wh: avgDailyYieldWh,
            avg_7d_score: avg7dScore,
        },
        battery: {
            soc_pct: snapshot.battery_soc,
            stored_wh: currentStoredWh,
            remaining_to_full_wh: remainingToFullWh,
            days_of_autonomy: daysOfAutonomy,
            charge_time_hours: chargeTimeHours,
            temp_status: batteryTempStatus,
            temp_celsius: snapshot.battery_temp,
        },
        energy: {
            today_yield_wh: todayYieldWh !== null ? Math.round(todayYieldWh) : null,
            today_consumed_wh: todayConsumedWh !== null ? Math.round(todayConsumedWh) : null,
            today_balance_wh: energyBalanceWh,
            avg_daily_consumption_wh: avgDailyConsumptionWh,
        },
        predictive: {
            days_to_critical: predictedDaysToCritical,
            critical_soc_pct: criticalSocPct,
            warning_threshold_days: 3,
            status: predictedDaysToCritical !== null
                ? (predictedDaysToCritical <= 1 ? 'critical' : predictedDaysToCritical <= 3 ? 'warning' : 'ok')
                : null,
        },
    };
}

// ============================================================
// Daily energy tracker: siteId -> { [dateStr]: { yield_wh, consumed_wh, site_name } }
// Keeps up to 14 days of data in memory
// ============================================================
const dailyEnergy = new Map();

function todayStr() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function updateDailyEnergy(siteId, siteName, yieldToday, consumedAh, voltage, batterySoc, dcLoadW = null, loadCurrent = null, expectedYieldWh = null) {
    const date = todayStr();
    const now = Date.now();
    if (!dailyEnergy.has(siteId)) {
        dailyEnergy.set(siteId, {});
    }
    const siteData = dailyEnergy.get(siteId);

    const yieldWh = yieldToday !== null ? yieldToday * 1000 : null;
    let consumedWh = null;
    let consumptionSource = null;

    // Tier 1: CE diagnostic (consumed Ah × voltage) — most accurate
    // CE resets to 0 when the battery synchronizes at 100% SOC, so CE=0
    // is unreliable — skip to lower tiers for a better estimate
    if (consumedAh !== null && consumedAh !== 0 && voltage !== null) {
        consumedWh = Math.abs(consumedAh) * voltage;
        consumptionSource = 'CE diagnostic';
    }

    // Tier 2: Accumulate DC load power over time (Riemann sum)
    if (consumedWh === null) {
        // Determine instantaneous DC load watts from available sources
        let consumptionW = dcLoadW;
        if (consumptionW === null && loadCurrent !== null && voltage !== null) {
            consumptionW = Math.abs(loadCurrent) * voltage;
        }

        const acc = consumptionAccumulator.get(siteId);
        if (acc && acc.date === date && consumptionW !== null) {
            const elapsedHours = (now - acc.lastTimestamp) / 3600000;
            // Guard against unreasonable gaps (>10 min means server was probably down)
            if (elapsedHours > 0 && elapsedHours < 0.17) {
                acc.wh += consumptionW * elapsedHours;
            }
            acc.lastTimestamp = now;
            if (acc.wh > 0) {
                consumedWh = Math.round(acc.wh);
                consumptionSource = 'DC power accumulation';
            }
        } else {
            // Start new accumulator for this day
            consumptionAccumulator.set(siteId, { date, wh: 0, lastTimestamp: now });
        }
    }

    // Tier 3: SOC delta estimation
    // Energy balance: yield = battery_charge_change + consumption
    // So: consumption = yield - battery_charge_change
    // battery_charge_change = (currentSOC - startSOC) * battery_capacity / 100
    // Positive change = battery gained energy, negative = battery lost energy
    if (consumedWh === null && yieldWh !== null && batterySoc !== null) {
        const socEntry = socStartOfDay.get(siteId);
        if (socEntry && socEntry.date === date && socEntry.soc !== null) {
            const batteryChargeChangeWh = (batterySoc - socEntry.soc) * TRAILER_SPECS.battery.total_wh / 100;
            const estimated = yieldWh - batteryChargeChangeWh;
            if (estimated >= 0) {
                consumedWh = Math.round(estimated);
                consumptionSource = 'SOC delta estimate';
            }
        }
    }

    // Track start-of-day SOC (first reading each day)
    const socEntry = socStartOfDay.get(siteId);
    if (!socEntry || socEntry.date !== date) {
        if (batterySoc !== null) {
            socStartOfDay.set(siteId, { date, soc: batterySoc });
        }
    }

    siteData[date] = {
        site_name: siteName,
        yield_wh: yieldWh,
        consumed_wh: consumedWh,
        consumption_source: consumptionSource,
        expected_yield_wh: expectedYieldWh ?? siteData[date]?.expected_yield_wh ?? null,
        updated: now,
    };

    // Persist to DB with SOC start-of-day (async, don't block)
    if (dbAvailable) {
        const socVal = socStartOfDay.get(siteId);
        const socForDb = (socVal && socVal.date === date) ? socVal.soc : null;
        upsertDailyEnergy(siteId, date, siteName, yieldWh, consumedWh, socForDb, siteData[date].expected_yield_wh, consumptionSource).catch(() => {});
    }

    // Prune entries older than 14 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (const d of Object.keys(siteData)) {
        if (d < cutoffStr) delete siteData[d];
    }
}

// Seed dailyEnergy and socStartOfDay from DB on startup so data survives restarts
async function seedDailyEnergyFromDb() {
    try {
        const rows = await getAllDailyEnergy(14);
        let socSeeded = 0;
        for (const row of rows) {
            const siteId = row.site_id;
            const dateStr = new Date(row.date).toISOString().slice(0, 10);
            if (!dailyEnergy.has(siteId)) {
                dailyEnergy.set(siteId, {});
            }
            const siteData = dailyEnergy.get(siteId);
            // Only fill if not already populated by live polling
            if (!siteData[dateStr]) {
                siteData[dateStr] = {
                    site_name: row.site_name || `Site ${siteId}`,
                    yield_wh: row.yield_wh != null ? Number(row.yield_wh) : null,
                    consumed_wh: row.consumed_wh != null ? Number(row.consumed_wh) : null,
                    expected_yield_wh: row.expected_yield_wh != null ? Number(row.expected_yield_wh) : null,
                    updated: Date.now(),
                };
            }

            // Seed socStartOfDay with the most recent day's SOC for each site
            if (row.soc_start_of_day != null) {
                const existing = socStartOfDay.get(siteId);
                if (!existing || existing.date <= dateStr) {
                    socStartOfDay.set(siteId, { date: dateStr, soc: Number(row.soc_start_of_day) });
                    socSeeded++;
                }
            }
        }
        console.log(`  ✓ Seeded dailyEnergy from DB: ${rows.length} records for ${dailyEnergy.size} sites`);
        console.log(`  ✓ Seeded SOC start-of-day from DB: ${socSeeded} sites`);
    } catch (err) {
        console.warn('  ⚠ Failed to seed dailyEnergy from DB:', err.message);
    }
}

// ============================================================
// Offline device duration tracking
// ============================================================
const offlineTimestamps = new Map(); // deviceName -> firstOfflineTime

// ============================================================
// Alert logic: yield < consumed for 2+ consecutive days
// ============================================================
function computeAlerts() {
    const alerts = [];
    const today = todayStr();

    for (const [siteId, days] of dailyEnergy.entries()) {
        const dates = Object.keys(days)
            .filter(d => d < today)
            .sort()
            .reverse();

        let streak = 0;
        const siteName = Object.values(days)[0]?.site_name || `Site ${siteId}`;

        for (const date of dates) {
            const { yield_wh, consumed_wh } = days[date];
            if (yield_wh !== null && consumed_wh !== null && yield_wh < consumed_wh) {
                streak++;
            } else {
                break;
            }
        }

        if (streak >= 2) {
            const deficitDays = dates.slice(0, streak).map(d => ({
                date: d,
                yield_wh: days[d].yield_wh,
                consumed_wh: days[d].consumed_wh,
                deficit_wh: days[d].consumed_wh - days[d].yield_wh,
            }));

            alerts.push({
                site_id: siteId,
                site_name: siteName,
                streak_days: streak,
                deficit_days: deficitDays,
                severity: streak >= 5 ? 'critical' : streak >= 3 ? 'warning' : 'caution',
            });
        }
    }

    alerts.sort((a, b) => b.streak_days - a.streak_days);
    return alerts;
}

// ============================================================
// Alert history persistence
// ============================================================
async function persistAlertHistory(currentAlerts) {
    try {
        const activeDbAlerts = await getActiveAlerts();
        const activeSiteIds = new Set(currentAlerts.map(a => a.site_id));
        const dbSiteIds = new Set(activeDbAlerts.map(a => a.site_id));

        // Insert new alerts
        for (const alert of currentAlerts) {
            if (!dbSiteIds.has(alert.site_id)) {
                const totalDeficit = alert.deficit_days?.reduce((s, d) => s + (d.deficit_wh || 0), 0) || 0;
                await insertAlertHistory(alert.site_id, alert.site_name, alert.severity, alert.streak_days, totalDeficit);
                // Send email notification (rate-limited, fire-and-forget)
                if (isEmailConfigured() && !checkRateLimit(alert.site_id)) {
                    markNotified(alert.site_id);
                    sendAlertEmail(alert).catch(err => console.error('  Alert email error:', err.message));
                }
            }
        }

        // Resolve alerts that are no longer active
        for (const dbAlert of activeDbAlerts) {
            if (!activeSiteIds.has(dbAlert.site_id)) {
                await resolveAlert(dbAlert.site_id);
                // Send resolution email (fire-and-forget)
                if (isEmailConfigured()) {
                    sendAlertResolvedEmail(dbAlert).catch(err => console.error('  Resolution email error:', err.message));
                }
            }
        }
    } catch (err) {
        console.error('  persistAlertHistory error:', err.message);
    }
}

// ============================================================
// IC2 device resolution helpers
// ============================================================

/**
 * Resolve an IC2 device to a site_id.
 * Priority: 1) stored ic2_device_id linkage, 2) name match to VRM, 3) synthetic -dev.id
 */
function resolveIc2DeviceToSiteId(dev, vrmSites) {
    // Priority 1: stored linkage
    if (ic2DeviceIdToSiteId.has(dev.id)) {
        const siteId = ic2DeviceIdToSiteId.get(dev.id);
        const vrmSite = vrmSites.find(s => s.idSite === siteId);
        return { siteId, siteName: vrmSite?.name || dev.name };
    }
    // Priority 2: name match to VRM
    const vrmSite = vrmSites.find(s => s.name === dev.name);
    if (vrmSite) {
        ic2DeviceIdToSiteId.set(dev.id, vrmSite.idSite);
        return { siteId: vrmSite.idSite, siteName: vrmSite.name };
    }
    // Priority 3: IC2-only device
    const syntheticId = -dev.id;
    ic2DeviceIdToSiteId.set(dev.id, syntheticId);
    return { siteId: syntheticId, siteName: dev.name };
}

/**
 * Look up pepwave data for a trailer, trying name first then IC2 device ID.
 */
function getPepwaveForTrailer(trailer) {
    let pw = pepwaveCache.get(trailer.site_name);
    if (pw) return pw;
    if (trailer.ic2_device_id) {
        const name = ic2DeviceIdToName.get(trailer.ic2_device_id);
        if (name) pw = pepwaveCache.get(name);
    }
    return pw || null;
}

// ============================================================
// IC2 data extraction helpers
// ============================================================
function extractCellularInfo(device) {
    const ifaces = device.interfaces || [];
    const cell = ifaces.find(i => i.type === 'gobi' || i.virtualType === 'cellular');
    if (!cell) return null;

    return {
        status: cell.status || 'Unknown',
        carrier: cell.carrier_name || 'Unknown',
        ip: cell.ip || null,
        technology: cell.gobi_data_tech || cell.data_technology || cell.s2g3glte || 'Unknown',
        band: cell.gobi_band_class_name || null,
        signal_bar: cell.signal_bar ?? null,
        signal: cell.cellular_signals || null,
        apn: cell.apn || null,
        imei: cell.imei || null,
        sims: (cell.sims || []).map(s => ({
            id: s.id,
            detected: s.simCardDetected,
            active: s.active,
            carrier: s.mtn || null,
            iccid: s.iccid || null,
            imsi: s.imsi || null,
            apn: s.apn || null,
        })),
    };
}

function extractWanInterfaces(device) {
    const ifaces = device.interfaces || [];
    return ifaces.map(i => ({
        id: i.id,
        name: i.name,
        type: i.virtualType || i.type,
        status: i.status,
        status_led: i.status_led,
        ip: i.ip || null,
        message: i.message || '',
    }));
}

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
            sitesCache = data;
            sitesCacheTime = Date.now();
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
// Job Sites API
// ============================================================

// GET all job sites with aggregated live metrics
app.get('/api/job-sites', async (req, res) => {
    try {
        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

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
                    return {
                        site_id: t.site_id,
                        site_name: t.site_name,
                        battery_soc: snap?.battery_soc ?? null,
                        solar_watts: snap?.solar_watts ?? null,
                        solar_yield_today: snap?.solar_yield_today ?? null,
                        charge_state: snap?.charge_state ?? null,
                        online: isIc2Only ? (pw?.online ?? false) : (hasVrmData(snap) || pw?.online || false),
                        ic2_only: isIc2Only,
                        network_online: pw?.online ?? false,
                        dc_load_watts: snap?.dc_load_watts ?? null,
                        alarm_reason: snap?.alarm_reason ?? null,
                        error_code: snap?.error_code ?? null,
                        inverter_mode: snap?.inverter_mode ?? null,
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
            return {
                ...t,
                snapshot: snap || null,
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
        const updated = await updateJobSite(parseInt(req.params.id), req.body);
        if (!updated) return res.status(404).json({ success: false, error: 'Job site not found' });
        res.json({ success: true, job_site: updated });
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
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
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

// Lazy daily metrics computation — call after VRM poll
let lastMetricsDate = null;
async function computeYesterdayMetrics() {
    if (!dbAvailable) return;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (lastMetricsDate === yesterday) return; // already computed today
    try {
        const count = await computeDailyMetrics(yesterday);
        if (count > 0) {
            lastMetricsDate = yesterday;
            console.log(`  ✓ Analytics: computed ${count} daily metrics for ${yesterday}`);
        }
    } catch (err) {
        console.error('  Analytics computation error:', err.message);
    }
}

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

// Backfill: compute metrics for past N days
app.post('/api/analytics/backfill', requireRole('admin'), async (req, res) => {
    try {
        const days = parseInt(req.body?.days) || 7;
        let totalRows = 0;
        for (let i = 1; i <= days; i++) {
            const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
            const count = await computeDailyMetrics(date);
            totalRows += count;
        }
        res.json({ success: true, days_processed: days, rows_computed: totalRows });
    } catch (err) {
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

        // Linear regression on min_soc over time
        const n = dataPoints.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (let i = 0; i < n; i++) {
            const y = dataPoints[i].min_soc ?? dataPoints[i].avg_soc ?? 0;
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
            const currentSoc = dataPoints[n - 1].min_soc ?? dataPoints[n - 1].avg_soc ?? 50;
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
            } catch {}
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

// --- Helper: extract values from diagnostics records ---
function extractDiagValue(records, code) {
    const match = records.find(r => r.code === code && r.Device !== 'Gateway');
    if (!match) return null;
    const val = match.rawValue;
    if (val === undefined || val === null || val === '') return null;
    const num = Number(val);
    return isNaN(num) ? val : num;
}

// --- Background polling: VRM ---
let isPolling = false;

async function pollAllSites() {
    if (isPolling) return;
    isPolling = true;
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] Polling VRM sites...`);

    try {
        if (!sitesCache) {
            const data = await vrmFetch(`/users/${VRM_USER_ID}/installations`);
            sitesCache = data;
            sitesCacheTime = Date.now();
        }

        const sites = sitesCache.records || [];
        let successCount = 0;
        let errorCount = 0;

        for (let i = 0; i < sites.length; i += 3) {
            const batch = sites.slice(i, i + 3);
            const promises = batch.map(async (site) => {
                try {
                    const diagRes = await vrmFetch(
                        `/installations/${site.idSite}/diagnostics?count=200`
                    );
                    const records = diagRes?.records || [];

                    const yieldToday = extractDiagValue(records, 'YT');
                    const yieldYesterday = extractDiagValue(records, 'YY');
                    const consumedAh = extractDiagValue(records, 'CE');
                    const batteryVoltage = extractDiagValue(records, 'V') ?? extractDiagValue(records, 'bv');

                    // Extended diagnostics for richer AI analysis
                    let dcLoadW = extractDiagValue(records, 'Pc');  // DC load power (watts)
                    const loadCurrent = extractDiagValue(records, 'IL');
                    const loadState = extractDiagValue(records, 'LOAD');
                    const lifetimeYieldKwh = extractDiagValue(records, 'H19');
                    const alarmReason = extractDiagValue(records, 'AR');
                    const errorCode = extractDiagValue(records, 'ERR');
                    const inverterMode = extractDiagValue(records, 'MODE');
                    const mpptState = extractDiagValue(records, 'MPPT');
                    const firmwareVersion = extractDiagValue(records, 'FW');
                    const timeToGoMin = extractDiagValue(records, 'TTG');

                    // GPS: only use IC2 Peplink as authoritative source.
                    // VRM coordinates are often stale/default. Only seed gpsCache
                    // from VRM if IC2 hasn't provided coordinates yet.
                    if (!gpsCache.has(site.idSite)) {
                        const latitude = extractDiagValue(records, 'lt') ?? site.latitude ?? null;
                        const longitude = extractDiagValue(records, 'lg') ?? site.longitude ?? null;
                        if (latitude != null && longitude != null) {
                            gpsCache.set(site.idSite, { latitude, longitude, updatedAt: Date.now() });
                        }
                    }

                    // Battery power: P (from BMV) or derive from V × I
                    const solarW = extractDiagValue(records, 'ScW') ?? extractDiagValue(records, 'Pdc');
                    let battPower = extractDiagValue(records, 'P');
                    if (battPower === null && batteryVoltage !== null) {
                        const battCurrent = extractDiagValue(records, 'I') ?? extractDiagValue(records, 'bc');
                        if (battCurrent !== null) battPower = Math.round(batteryVoltage * battCurrent);
                    }

                    // Derive DC load if Pc not available: load = solar - battery_power
                    if (dcLoadW === null) {
                        if (solarW !== null && battPower !== null) {
                            dcLoadW = Math.round(Math.max(0, solarW - battPower));
                        } else if (loadCurrent !== null && batteryVoltage !== null) {
                            dcLoadW = Math.round(Math.abs(loadCurrent) * batteryVoltage);
                        }
                    }

                    const snapshot = {
                        site_id: site.idSite,
                        site_name: site.name,
                        timestamp: Date.now(),
                        battery_soc: extractDiagValue(records, 'SOC') ?? extractDiagValue(records, 'bs'),
                        battery_voltage: batteryVoltage,
                        battery_current: extractDiagValue(records, 'I') ?? extractDiagValue(records, 'bc'),
                        battery_temp: extractDiagValue(records, 'BT') ?? extractDiagValue(records, 'bT'),
                        battery_power: battPower,
                        solar_watts: extractDiagValue(records, 'ScW') ?? extractDiagValue(records, 'Pdc'),
                        solar_yield_today: yieldToday,
                        solar_yield_yesterday: yieldYesterday,
                        charge_state: extractDiagValue(records, 'ScS'),
                        consumed_ah: consumedAh,
                        // Extended diagnostics
                        dc_load_watts: dcLoadW,
                        load_current: loadCurrent,
                        load_state: loadState,
                        lifetime_yield_kwh: lifetimeYieldKwh,
                        alarm_reason: alarmReason,
                        error_code: errorCode,
                        inverter_mode: inverterMode,
                        mppt_state: mpptState,
                        firmware_version: firmwareVersion,
                        time_to_go_min: timeToGoMin,
                    };

                    snapshotCache.set(site.idSite, snapshot);

                    // Compute today's expected yield (weather-based) and store with daily energy
                    let expectedYieldWh = null;
                    const gpsForYield = gpsCache.get(site.idSite);
                    if (gpsForYield) {
                        try {
                            const wx = await fetchSolarIrradiance(gpsForYield.latitude, gpsForYield.longitude);
                            const psh = wx?.peak_sun_hours ?? 5;
                            expectedYieldWh = Math.round(TRAILER_SPECS.solar.total_watts * psh * TRAILER_SPECS.solar.system_efficiency);
                        } catch {}
                    }

                    updateDailyEnergy(site.idSite, site.name, yieldToday, consumedAh, batteryVoltage, snapshot.battery_soc, dcLoadW, loadCurrent, expectedYieldWh);

                    if (yieldYesterday !== null) {
                        const yesterday = new Date();
                        yesterday.setDate(yesterday.getDate() - 1);
                        const yestStr = yesterday.toISOString().slice(0, 10);
                        if (!dailyEnergy.has(site.idSite)) dailyEnergy.set(site.idSite, {});
                        const siteData = dailyEnergy.get(site.idSite);
                        if (!siteData[yestStr]) {
                            siteData[yestStr] = {
                                site_name: site.name,
                                yield_wh: yieldYesterday * 1000,
                                consumed_wh: null,
                                expected_yield_wh: expectedYieldWh, // approximate — today's weather as proxy
                                updated: Date.now(),
                            };
                        }
                    }

                    if (dbAvailable) {
                        try {
                            await insertSnapshot({
                                ...snapshot,
                                raw_battery: {
                                    alarm_reason: alarmReason,
                                    error_code: errorCode,
                                    load_current: loadCurrent,
                                    load_state: loadState,
                                    dc_load_watts: dcLoadW,
                                    inverter_mode: inverterMode,
                                },
                                raw_solar: {
                                    mppt_state: mpptState,
                                    lifetime_yield_kwh: lifetimeYieldKwh,
                                    firmware_version: firmwareVersion,
                                },
                            });
                        } catch (dbErr) { /* in memory */ }
                        // Persist trailer assignment (GPS comes from IC2, pass null to preserve existing)
                        try {
                            await upsertTrailerAssignment(site.idSite, site.name, null, null);
                        } catch (dbErr) { /* non-critical */ }
                    }

                    successCount++;
                } catch (err) {
                    errorCount++;
                    console.error(`  Error polling site ${site.name}: ${err.message}`);
                }
            });
            await Promise.all(promises);
            if (i + 3 < sites.length) {
                await new Promise(r => setTimeout(r, 1200));
            }
        }

        if (dbAvailable) {
            try { await pruneOldData(); } catch (e) { /* ignore */ }
        }

        const currentAlerts = computeAlerts();
        const alertCount = currentAlerts.length;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  VRM poll complete: ${successCount} ok, ${errorCount} errors in ${elapsed}s (cache: ${snapshotCache.size} sites, energy alerts: ${alertCount})`);

        // Persist alert history to DB (async, don't block)
        if (dbAvailable) {
            persistAlertHistory(currentAlerts).catch(err =>
                console.error('  Alert history persistence failed:', err.message)
            );
        }

        // Auto-generate embeddings for new data (async, don't block)
        if (dbAvailable && pgvectorAvailable && isEmbeddingsConfigured() && snapshotCache.size > 0) {
            generateEmbeddingsAsync().catch(err =>
                console.error('  Background embedding generation failed:', err.message)
            );
        }

        // Run GPS clustering on first poll (async, don't block)
        if (dbAvailable && !initialClusteringDone && gpsCache.size > 0) {
            initialClusteringDone = true;
            runClustering().catch(err =>
                console.error('  Initial clustering failed:', err.message)
            );
        }

        // Lazy analytics: compute yesterday's daily metrics
        computeYesterdayMetrics();
    } catch (err) {
        console.error('  VRM poll error:', err.message);
    } finally {
        isPolling = false;
    }
}

// --- Background polling: InControl2 ---
let isPollingIc2 = false;

async function pollIc2Devices() {
    if (isPollingIc2 || !IC2_CLIENT_ID || !IC2_CLIENT_SECRET) return;
    isPollingIc2 = true;
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] Polling InControl2 devices...`);

    try {
        // Fetch devices from BIGView group only (group 1 has full status data including usage)
        const result = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g/${IC2_GROUP_ID}/d?has_status=true`);
        const devices = result.data || [];

        let onlineCount = 0;
        let offlineCount = 0;

        // Fetch bandwidth data from dedicated endpoint
        let bandwidthMap = {};
        try {
            const today = new Date().toISOString().slice(0, 10); // yyyy-MM-dd
            // Try group-scoped bandwidth endpoint first, fallback to org-scoped
            let bwResult;
            try {
                bwResult = await ic2Fetch(
                    `/rest/o/${IC2_ORG_ID}/g/${IC2_GROUP_ID}/bandwidth_per_device?type=daily&report_date=${today}`
                );
            } catch {
                bwResult = await ic2Fetch(
                    `/rest/o/${IC2_ORG_ID}/bandwidth_per_device?type=daily&report_date=${today}`
                );
            }
            const bwData = bwResult.data || bwResult.response || bwResult;

            // Debug: log raw structure on first successful fetch
            if (!bandwidthLoggedOnce) {
                bandwidthLoggedOnce = true;
                if (Array.isArray(bwData) && bwData.length > 0) {
                    console.log(`  IC2 bandwidth sample (array[0]):`, JSON.stringify(bwData[0]).slice(0, 500));
                } else if (typeof bwData === 'object') {
                    const keys = Object.keys(bwData).slice(0, 5);
                    console.log(`  IC2 bandwidth keys:`, keys, 'sample:', JSON.stringify(bwData[keys[0]]).slice(0, 300));
                }
            }

            // Build lookup: deviceId -> { upload, download, total }
            if (Array.isArray(bwData)) {
                for (const entry of bwData) {
                    const devId = entry.id || entry.device_id || entry.sn;
                    const devName = entry.name || entry.device_name;
                    const upload = entry.upload || entry.tx || entry.upload_bytes || entry.ul || 0;
                    const download = entry.download || entry.rx || entry.download_bytes || entry.dl || 0;
                    const total = entry.total || entry.usage || upload + download || 0;
                    const bwEntry = { upload_bytes: upload, download_bytes: download, total_bytes: total };
                    if (devId) bandwidthMap[devId] = bwEntry;
                    if (devName) bandwidthMap[devName] = bwEntry;
                }
            } else if (typeof bwData === 'object') {
                for (const [key, val] of Object.entries(bwData)) {
                    if (val && typeof val === 'object') {
                        bandwidthMap[key] = {
                            upload_bytes: val.upload || val.tx || val.ul || 0,
                            download_bytes: val.download || val.rx || val.dl || 0,
                            total_bytes: val.total || val.usage || 0,
                        };
                    }
                }
            }
            if (Object.keys(bandwidthMap).length > 0) {
                console.log(`  IC2 bandwidth: fetched usage for ${Object.keys(bandwidthMap).length} devices`);
            }
        } catch (bwErr) {
            console.log(`  IC2 bandwidth fetch failed: ${bwErr.message}`);
        }

        // Always load latest non-zero usage from DB as fallback
        let dbUsageFallback = {};
        if (dbAvailable) {
            try {
                const pool = (await import('./db.js')).getPool();
                const fbResult = await pool.query(`
                    SELECT DISTINCT ON (device_name) device_name, usage_mb, tx_mb, rx_mb
                    FROM pepwave_snapshots
                    WHERE usage_mb > 0
                    ORDER BY device_name, timestamp DESC
                `);
                for (const row of fbResult.rows) {
                    dbUsageFallback[row.device_name] = {
                        usage_mb: parseFloat(row.usage_mb) || 0,
                        tx_mb: parseFloat(row.tx_mb) || 0,
                        rx_mb: parseFloat(row.rx_mb) || 0,
                    };
                }
            } catch { /* ignore */ }
        }

        const bwMapSize = Object.keys(bandwidthMap).length;
        const dbFbSize = Object.keys(dbUsageFallback).length;
        console.log(`  IC2 bandwidth: API=${bwMapSize} devices, DB fallback=${dbFbSize} devices`);

        for (const dev of devices) {
            const cellular = extractCellularInfo(dev);
            const wanInterfaces = extractWanInterfaces(dev);

            // Get bandwidth: dedicated endpoint → device fields → DB fallback → 0
            const bw = bandwidthMap[dev.id] || bandwidthMap[dev.name] || {};
            const dbFb = dbUsageFallback[dev.name] || {};
            let usageMb = bw.total_bytes ? bw.total_bytes / (1024 * 1024) : (dev.usage || 0);
            let txMb = bw.upload_bytes ? bw.upload_bytes / (1024 * 1024) : (dev.tx || 0);
            let rxMb = bw.download_bytes ? bw.download_bytes / (1024 * 1024) : (dev.rx || 0);
            // If still 0 after API, use DB fallback
            if (!usageMb && dbFb.usage_mb) usageMb = dbFb.usage_mb;
            if (!txMb && dbFb.tx_mb) txMb = dbFb.tx_mb;
            if (!rxMb && dbFb.rx_mb) rxMb = dbFb.rx_mb;

            const record = {
                id: dev.id,
                name: dev.name,
                sn: dev.sn,
                status: dev.status,
                online: dev.status === 'online',
                model: dev.product_name || dev.model || 'Unknown',
                firmware: dev.fw_ver || 'Unknown',
                client_count: dev.client_count || 0,
                uptime: dev.uptime || 0,
                usage_mb: usageMb,
                tx_mb: txMb,
                rx_mb: rxMb,
                wan_ip: dev.wtp_ip || cellular?.ip || null,
                last_online: dev.last_online || null,
                tags: dev.tags || [],
                gps_support: dev.gps_support || false,
                gps_exist: dev.gps_exist || false,
                latitude: dev.latitude || null,
                longitude: dev.longitude || null,
                address: dev.address || null,
                cellular,
                wan_interfaces: wanInterfaces,
                timestamp: Date.now(),
            };

            pepwaveCache.set(dev.name, record);
            ic2DeviceIdToName.set(dev.id, dev.name);

            // Track offline duration
            if (record.online) {
                offlineTimestamps.delete(dev.name);
            } else if (!offlineTimestamps.has(dev.name)) {
                offlineTimestamps.set(dev.name, Date.now());
            }

            // Persist to PostgreSQL for historical tracking
            if (dbAvailable) {
                try {
                    await insertPepwaveSnapshot({
                        device_name: dev.name,
                        timestamp: record.timestamp,
                        online: record.online,
                        signal_bar: cellular?.signal_bar ?? null,
                        rsrp: cellular?.signal?.rsrp ?? null,
                        rsrq: cellular?.signal?.rsrq ?? null,
                        rssi: cellular?.signal?.rssi ?? null,
                        sinr: cellular?.signal?.sinr ?? null,
                        carrier: cellular?.carrier || null,
                        technology: cellular?.technology || null,
                        usage_mb: record.usage_mb,
                        tx_mb: record.tx_mb,
                        rx_mb: record.rx_mb,
                        client_count: record.client_count,
                        uptime: record.uptime,
                        wan_ip: record.wan_ip,
                    });
                } catch (dbErr) { /* continue - in-memory still works */ }
            }

            if (dev.status === 'online') onlineCount++;
            else offlineCount++;
        }

        // Fetch GPS locations from per-device /loc endpoint for devices with gps_exist
        if (sitesCache) {
            const vrmSites = sitesCache.records || [];
            const gpsDevices = devices.filter(d => d.gps_exist || d.gps_support);
            let gpsMatched = 0;

            // Batch in groups of 5 to avoid rate limits
            for (let i = 0; i < gpsDevices.length; i += 5) {
                const batch = gpsDevices.slice(i, i + 5);
                const locPromises = batch.map(async (dev) => {
                    try {
                        const locData = await ic2Fetch(`/rest/o/${IC2_ORG_ID}/g/${IC2_GROUP_ID}/d/${dev.id}/loc`);
                        const loc = (locData.data || [])[0];
                        if (loc && loc.la && loc.lo) {
                            // Update pepwaveCache with GPS
                            const cached = pepwaveCache.get(dev.name);
                            if (cached) {
                                cached.latitude = loc.la;
                                cached.longitude = loc.lo;
                            }
                            // Resolve using stored IC2 device ID linkage, fall back to name match
                            const { siteId, siteName } = resolveIc2DeviceToSiteId(dev, vrmSites);
                            gpsCache.set(siteId, { latitude: loc.la, longitude: loc.lo, updatedAt: Date.now() });
                            if (siteId > 0) gpsMatched++;
                            if (dbAvailable) {
                                try {
                                    await upsertTrailerAssignment(siteId, siteName, loc.la, loc.lo, null, dev.id);
                                } catch (e) { /* non-critical */ }
                            }
                        }
                    } catch (e) { /* skip device on error */ }
                });
                await Promise.all(locPromises);
                if (i + 5 < gpsDevices.length) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            if (gpsMatched > 0) {
                console.log(`  IC2 GPS: fetched locations for ${gpsMatched} VRM-matched devices`);
            }
        }

        // Ensure IC2-only devices without GPS also get trailer_assignments
        if (dbAvailable && sitesCache) {
            const vrmSites = sitesCache.records || [];
            for (const dev of devices) {
                const { siteId } = resolveIc2DeviceToSiteId(dev, vrmSites);
                if (siteId < 0 && !gpsCache.has(siteId)) {
                    try {
                        await upsertTrailerAssignment(siteId, dev.name, null, null, null, dev.id);
                    } catch (e) { /* non-critical */ }
                }
            }
        }

        // Run clustering if we have GPS data and haven't clustered yet
        if (dbAvailable && !initialClusteringDone && gpsCache.size > 0) {
            initialClusteringDone = true;
            runClustering().catch(err =>
                console.error('  IC2-triggered clustering failed:', err.message)
            );
        }

        // Check geofences after GPS update (async, don't block)
        if (gpsCache.size > 0) {
            checkGeofences().catch(err => console.error('  Geofence check failed:', err.message));
        }

        lastIc2Poll = Date.now();
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  IC2 poll complete: ${devices.length} devices (${onlineCount} online, ${offlineCount} offline) in ${elapsed}s`);
    } catch (err) {
        console.error('  IC2 poll error:', err.message);
    } finally {
        isPollingIc2 = false;
    }
}

// ============================================================
// Geofence Checking
// ============================================================
const geofenceAlerts = new Map(); // siteId -> { breached, distance_m, lastAlertedAt, site_name, job_site_name }

async function checkGeofences() {
    if (!dbAvailable) return;
    try {
        const jobSites = await getJobSites();
        const assignments = await getTrailerAssignments();

        for (const assignment of assignments) {
            if (!assignment.job_site_id) continue;
            const gps = gpsCache.get(assignment.site_id);
            if (!gps) continue;

            const jobSite = jobSites.find(js => js.id === assignment.job_site_id);
            if (!jobSite || !jobSite.latitude || !jobSite.longitude) continue;

            const distance = haversineMeters(gps.latitude, gps.longitude, jobSite.latitude, jobSite.longitude);
            const radius = jobSite.geofence_radius_m || 500;

            if (distance > radius) {
                const existing = geofenceAlerts.get(assignment.site_id);
                const cooldown = 24 * 60 * 60 * 1000;
                if (!existing || Date.now() - existing.lastAlertedAt > cooldown) {
                    geofenceAlerts.set(assignment.site_id, {
                        breached: true,
                        distance_m: Math.round(distance),
                        lastAlertedAt: Date.now(),
                        site_name: assignment.site_name,
                        job_site_name: jobSite.name,
                    });
                    if (isEmailConfigured()) {
                        sendGeofenceEmail({
                            site_name: assignment.site_name,
                            job_site_name: jobSite.name,
                            distance_m: Math.round(distance),
                            geofence_radius_m: radius,
                        }).catch(err => console.error('  Geofence email error:', err.message));
                    }
                }
            } else {
                geofenceAlerts.delete(assignment.site_id);
            }
        }
    } catch (err) {
        console.error('  Geofence check error:', err.message);
    }
}

// ============================================================
// Background Embedding Generation
// ============================================================
async function generateEmbeddingsAsync() {
    if (!isEmbeddingsConfigured() || !dbAvailable || !pgvectorAvailable) return;

    try {
        // Get current sites from snapshot cache
        const sites = Array.from(snapshotCache.values()).filter(s => s.site_name);
        if (sites.length > 0) {
            const siteEmbeddings = await embedSiteSnapshots(sites);
            for (const emb of siteEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
        }

        // Get current devices from pepwave cache
        const devices = Array.from(pepwaveCache.values()).filter(d => d.name);
        if (devices.length > 0) {
            const deviceEmbeddings = await embedPepwaveDevices(devices);
            for (const emb of deviceEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
        }

        // Embed current alerts
        const alerts = computeAlerts();
        if (alerts.length > 0) {
            const alertEmbeddings = await embedAlerts(alerts);
            for (const emb of alertEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
        }

        // Embed maintenance logs from DB
        let maintCount = 0;
        if (dbAvailable) {
            try {
                const logs = await getMaintenanceLogs({ limit: 200 });
                if (logs.length > 0) {
                    const maintEmbeddings = await embedMaintenanceLogs(logs);
                    for (const emb of maintEmbeddings) {
                        await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
                    }
                    maintCount = logs.length;
                }
            } catch (e) { console.error('  Maintenance embedding error:', e.message); }
        }

        // Embed job sites from DB
        let jsCount = 0;
        if (dbAvailable) {
            try {
                const jobSites = await getJobSites();
                if (jobSites.length > 0) {
                    const jsEmbeddings = await embedJobSites(jobSites);
                    for (const emb of jsEmbeddings) {
                        await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
                    }
                    jsCount = jobSites.length;
                }
            } catch (e) { console.error('  Job site embedding error:', e.message); }
        }

        console.log(`  Background embeddings updated: ${sites.length} sites, ${devices.length} devices, ${alerts.length} alerts, ${maintCount} maintenance, ${jsCount} job sites`);
    } catch (err) {
        console.error('  Background embedding error:', err.message);
    }
}

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
   updated_at BIGINT (ms). PRIMARY KEY(site_id, date)

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
            } catch {}
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
            } catch {}
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

function computeHealthGrade(siteId) {
    const snapshot = snapshotCache.get(siteId);
    if (!snapshot) return null;

    let totalScore = 0;
    let weights = 0;

    // Solar score 7d avg (25%)
    const siteEnergy = dailyEnergy.get(siteId) || {};
    const today = todayStr();
    const pastDays = Object.entries(siteEnergy)
        .filter(([d]) => d < today)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 7);
    if (pastDays.length > 0) {
        const yieldValues = pastDays.map(([, i]) => i.yield_wh).filter(v => v !== null && v > 0);
        if (yieldValues.length > 0) {
            const avgYield = yieldValues.reduce((s, v) => s + v, 0) / yieldValues.length;
            const psh = 5; // default for grade calc
            const expected = TRAILER_SPECS.solar.total_watts * psh * TRAILER_SPECS.solar.system_efficiency;
            const solarPct = Math.min(100, (avgYield / expected) * 100);
            totalScore += solarPct * 0.25;
            weights += 0.25;
        }
    }

    // Battery SOC as health proxy (20%)
    if (snapshot.battery_soc !== null) {
        totalScore += Math.min(100, snapshot.battery_soc) * 0.20;
        weights += 0.20;
    }

    // Autonomy proxy (20%) — use SOC as approximation
    if (snapshot.battery_soc !== null) {
        const autonomyScore = snapshot.battery_soc >= 60 ? 100 : snapshot.battery_soc >= 30 ? 60 : snapshot.battery_soc >= 15 ? 30 : 10;
        totalScore += autonomyScore * 0.20;
        weights += 0.20;
    }

    // Network status (15%)
    const pepName = snapshot.site_name;
    let networkScore = 50; // default if no data
    for (const [, dev] of pepwaveCache) {
        if (dev.name && pepName && dev.name.includes(pepName.replace('AG-', ''))) {
            networkScore = dev.online ? (dev.signal_bar >= 3 ? 100 : dev.signal_bar >= 1 ? 60 : 30) : 0;
            break;
        }
    }
    totalScore += networkScore * 0.15;
    weights += 0.15;

    // Maintenance recency (20%) — more recent = better
    totalScore += 70 * 0.20; // default to 70 (no maintenance tracking in cache)
    weights += 0.20;

    const score = weights > 0 ? Math.round(totalScore / weights) : null;
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
    const color = score >= 90 ? '#27ae60' : score >= 75 ? '#16a085' : score >= 60 ? '#d4a017' : score >= 40 ? '#f39c12' : '#c0392b';

    return { grade, score, color };
}

// ============================================================
// Tech Status — Actionable 3-state status for field techs
// ============================================================
function computeTechStatus(siteId, alertsMap) {
    const snapshot = snapshotCache.get(siteId);
    const pw = pepwaveCache.get(snapshot?.site_name);

    // No VRM data — check if pepwave is online
    if (!snapshot || !hasVrmData(snapshot)) {
        if (pw?.online) return { status: 'good', reason: 'Network-only trailer, Pepwave online' };
        return { status: 'attention', reason: 'Trailer offline — no VRM or network data' };
    }

    const soc = snapshot.battery_soc;
    const reasons = [];

    // --- NEEDS ATTENTION triggers ---

    // Active alarm or error from VRM
    if (snapshot.alarm_reason) {
        reasons.push(`Alarm: ${snapshot.alarm_reason}`);
    }
    if (snapshot.error_code) {
        reasons.push(`Error: ${snapshot.error_code}`);
    }

    // Critical SOC
    if (soc !== null && soc < 20) {
        reasons.push(`Critical SOC: ${soc.toFixed(0)}%`);
    }

    // Energy deficit streak >= 5 days
    const deficitStreak = alertsMap?.[siteId] ?? 0;
    if (deficitStreak >= 5) {
        reasons.push(`Energy deficit: ${deficitStreak} day streak`);
    }

    // SOC declining and projected critical within 3 days
    const socTrend = computeSocTrend(siteId);
    if (socTrend && socTrend.declining && socTrend.daysUntilCritical !== null && socTrend.daysUntilCritical <= 3) {
        reasons.push(`SOC declining ${Math.abs(socTrend.slopePerDay).toFixed(1)}%/day — critical in ~${socTrend.daysUntilCritical}d`);
    }

    if (reasons.length > 0) return { status: 'attention', reason: reasons.join('; ') };

    // --- WATCH triggers ---
    const watchReasons = [];

    // Low SOC (20-40%)
    if (soc !== null && soc >= 20 && soc < 40) {
        watchReasons.push(`Low SOC: ${soc.toFixed(0)}%`);
    }

    // SOC declining > 2%/day (but not yet critical-imminent)
    if (socTrend && socTrend.declining && socTrend.slopePerDay < -2) {
        watchReasons.push(`SOC declining ${Math.abs(socTrend.slopePerDay).toFixed(1)}%/day`);
    }

    // Energy deficit 2-4 days
    if (deficitStreak >= 2 && deficitStreak < 5) {
        watchReasons.push(`Energy deficit: ${deficitStreak} day streak`);
    }

    if (watchReasons.length > 0) return { status: 'watch', reason: watchReasons.join('; ') };

    return { status: 'good', reason: null };
}

// Fast SOC trend from in-memory dailyEnergy (no DB query)
function computeSocTrend(siteId) {
    const siteEnergy = dailyEnergy.get(siteId);
    if (!siteEnergy) return null;

    const today = todayStr();
    const recentDays = Object.entries(siteEnergy)
        .filter(([d]) => d <= today)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-4); // last 4 days for trend

    if (recentDays.length < 2) return null;

    // Use socStartOfDay for each day + current SOC for today
    const points = [];
    for (const [dateStr] of recentDays) {
        // Check socStartOfDay for this site's historical start-of-day SOC
        const sEntry = socStartOfDay.get(siteId);
        if (sEntry && sEntry.date === dateStr) {
            points.push(sEntry.soc);
        }
    }

    // If we don't have enough start-of-day points, use current snapshot
    const snapshot = snapshotCache.get(siteId);
    if (snapshot?.battery_soc !== null && points.length > 0) {
        points.push(snapshot.battery_soc);
    }

    if (points.length < 2) return null;

    // Simple slope: (last - first) / days
    const slopePerDay = (points[points.length - 1] - points[0]) / (points.length - 1);
    const currentSoc = points[points.length - 1];
    const declining = slopePerDay < -0.5;

    let daysUntilCritical = null;
    if (declining && currentSoc > 20) {
        daysUntilCritical = Math.round((currentSoc - 20) / Math.abs(slopePerDay));
    }

    return { slopePerDay, declining, daysUntilCritical };
}

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
                details: { streak_days: alert.streak_days, deficit_days: alert.deficit_days },
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
            } catch {}
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

        // Source: Geofence breaches
        for (const [siteId, gf] of geofenceAlerts) {
            actions.push({
                key: `geofence:${siteId}`,
                priority: 2,
                category: 'network',
                title: `Geofence breach: ${gf.distance_m}m from site`,
                subtitle: `${gf.site_name} — ${gf.job_site_name}`,
                site_id: siteId,
                details: `Trailer is ${gf.distance_m}m from assigned job site (radius: 500m)`,
            });
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
            try { maintenance = await getMaintenanceLogs({ site_id: siteId, limit: 20 }); } catch {}
            try { upcoming = (await getUpcomingMaintenance(30)).filter(m => m.site_id === siteId); } catch {}
            try { batteryHistory = await getBatteryHistory(siteId, 30); } catch {}
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
            const grade = computeHealthGrade(t.site_id);
            trailerSummaries.push({
                site_id: t.site_id,
                site_name: t.site_name,
                health_grade: grade,
                battery_soc: snapshot?.battery_soc,
                solar_watts: snapshot?.solar_watts,
                yield_today: snapshot?.solar_yield_today,
            });
        }

        let maintenance = [];
        if (dbAvailable) {
            try { maintenance = await getMaintenanceLogs({ job_site_id: jobSiteId, limit: 20 }); } catch {}
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
            try { stats = await getMaintenanceStats(); } catch {}
            try { energyTrends = await getAllDailyEnergy(14); } catch {}
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

        res.json({
            site: {
                ...js,
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

// --- Digest ---
async function buildDigestData() {
    const trailers = [];
    for (const [siteId, snapshot] of snapshotCache) {
        if (!hasVrmData(snapshot)) continue; // skip connectivity-only trailers
        trailers.push({
            site_id: siteId,
            site_name: snapshot.site_name,
            battery_soc: snapshot.battery_soc,
            solar_watts: snapshot.solar_watts,
            solar_yield_today: snapshot.solar_yield_today,
        });
    }
    const onlineTrailers = trailers.filter(t => t.battery_soc != null);
    const avgSoc = onlineTrailers.length > 0
        ? onlineTrailers.reduce((s, t) => s + t.battery_soc, 0) / onlineTrailers.length : 0;
    const totalYieldKwh = trailers.reduce((s, t) => s + (t.solar_yield_today || 0), 0) / 1000;
    const lowSoc = onlineTrailers.filter(t => t.battery_soc < 50).sort((a, b) => a.battery_soc - b.battery_soc);
    const alerts = computeAlerts();

    // Predictive warnings
    const predictive = [];
    for (const [siteId, snap] of snapshotCache) {
        if (!hasVrmData(snap)) continue;
        const intel = await computeTrailerIntelligence(siteId);
        if (intel?.predictive?.days_to_critical != null && intel.predictive.days_to_critical <= 3) {
            predictive.push({
                site_name: snap.site_name,
                days_to_critical: intel.predictive.days_to_critical,
                battery_soc: snap.battery_soc,
            });
        }
    }

    // Overdue maintenance
    const overdue = [];
    // Will be filled if db data is available from the scheduled job

    return {
        fleet_size: trailers.length,
        avg_soc: avgSoc,
        total_yield_kwh: totalYieldKwh,
        trailers_below_50_soc: lowSoc.slice(0, 10),
        active_alerts: alerts,
        overdue_maintenance: overdue,
        predictive_warnings: predictive,
    };
}

function scheduleDigest() {
    const enabled = process.env.DIGEST_ENABLED === 'true';
    if (!enabled) {
        console.log('  Digest scheduling disabled (set DIGEST_ENABLED=true)');
        return;
    }
    const time = process.env.DIGEST_TIME || '06:00';
    const [hour, minute] = time.split(':').map(Number);
    const tz = process.env.DIGEST_TIMEZONE || 'America/Denver';
    const recipients = (process.env.DIGEST_RECIPIENTS || '')
        .split(',').map(e => e.trim()).filter(Boolean);

    if (recipients.length === 0) {
        console.log('  Digest scheduling skipped: no DIGEST_RECIPIENTS configured');
        return;
    }

    const cronExpr = `${minute} ${hour} * * *`;
    cron.schedule(cronExpr, async () => {
        console.log('  Running scheduled digest...');
        try {
            const data = await buildDigestData();
            // Fetch overdue maintenance if DB available
            if (dbAvailable) {
                try {
                    const upcoming = await getUpcomingMaintenance(0);
                    data.overdue_maintenance = upcoming
                        .filter(m => m.scheduled_date < Date.now())
                        .map(m => ({
                            title: m.title,
                            job_site_name: m.job_site_name || 'Unknown',
                            scheduled_date: new Date(m.scheduled_date).toISOString().slice(0, 10),
                        }));
                } catch {}
            }

            // Merge env var recipients with subscribed users
            const allRecipients = [...recipients];
            if (dbAvailable) {
                try {
                    const result = await db.query(`
                        SELECT email FROM users
                        WHERE digest_enabled = true
                        AND email IS NOT NULL
                        AND active = true
                    `);
                    const subscribedEmails = result.rows.map(r => r.email).filter(Boolean);
                    allRecipients.push(...subscribedEmails);
                } catch (err) {
                    console.error('  Failed to fetch subscribed users:', err.message);
                }
            }

            // Deduplicate recipients
            const uniqueRecipients = [...new Set(allRecipients)];

            if (uniqueRecipients.length > 0) {
                await sendDigestEmail(uniqueRecipients, data);
                console.log(`  Digest sent to ${uniqueRecipients.length} recipient(s) (${recipients.length} env, ${uniqueRecipients.length - recipients.length} subscribed)`);
            }
        } catch (err) {
            console.error('  Digest error:', err.message);
        }
    }, { timezone: tz });

    console.log(`  ✓ Digest scheduled at ${time} ${tz} → ${recipients.join(', ')}`);
}

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
        dbPool = await initDb();
        dbAvailable = true;
        console.log('PostgreSQL database connected');
        // Check if pgvector / fleet_embeddings table exists
        try {
            await dbPool.query(`SELECT 1 FROM fleet_embeddings LIMIT 0`);
            pgvectorAvailable = true;
        } catch {
            pgvectorAvailable = false;
        }
    } catch (err) {
        dbAvailable = false;
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
