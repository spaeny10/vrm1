// ============================================================
// Central configuration: environment variables and constants.
// dotenv is imported here (idempotently) so config is safe to
// import from any module regardless of load order.
// ============================================================
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

export const PORT = process.env.PORT || 3001;
export const VRM_TOKEN = process.env.VRM_API_TOKEN;
export const VRM_USER_ID = process.env.VRM_USER_ID;
export const VRM_BASE = 'https://vrmapi.victronenergy.com/v2';

// InControl2 credentials
export const IC2_CLIENT_ID = process.env.IC2_CLIENT_ID;
export const IC2_CLIENT_SECRET = process.env.IC2_CLIENT_SECRET;
export const IC2_BASE = 'https://api.ic.peplink.com';
export const IC2_ORG_ID = 'VdYVxn';
export const IC2_GROUP_ID = 1;

// Claude API for natural language queries
export const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;

// JWT Authentication
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is required in production');
    process.exit(1);
}
export const JWT_SECRET = process.env.JWT_SECRET || 'vrm-fleet-dev-secret-change-in-production';
export const JWT_EXPIRES_IN = '24h';
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const ALLOWED_GOOGLE_DOMAIN = 'jetstreamsys.com';

export const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:3000'];

// Cache TTLs / staleness thresholds
export const SITES_CACHE_TTL = 5 * 60 * 1000;
export const WEATHER_CACHE_TTL = 60 * 60 * 1000; // 1 hour
export const VRM_STALE_MS = 30 * 60 * 1000;

// ============================================================
// Trailer Hardware Specifications
// ============================================================
export const TRAILER_SPECS = {
    solar: { panels: 3, panel_watts: 435, total_watts: 1305, system_efficiency: 0.70 },
    battery: { chemistry: 'LiFePO4', count: 2, config: 'parallel', ah_per_battery: 230, voltage: 25.6, total_ah: 460, total_wh: 11776, min_soc_threshold: 20, usable_wh: 9421 },
};

// ============================================================
// Solar Score Configuration defaults (overridable from Settings)
// ============================================================
export const SOLAR_SCORE_DEFAULTS = {
    throttle_soc_threshold: 95,    // SOC % above which throttling is detected
    throttle_floor_soc: 98,        // SOC % above which minimum score floor applies
    throttle_floor_score: 80,      // Minimum score when floor condition met
    throttle_panel_min_pct: 10,    // Panel output % threshold to confirm system health
    score_excellent: 80,           // Score threshold for "Excellent"
    score_good: 60,                // Score threshold for "Good"
    score_fair: 40,                // Score threshold for "Fair"
};
