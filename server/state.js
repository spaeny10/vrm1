// ============================================================
// Shared in-memory state. Live reads come from these Maps and
// scalars; PostgreSQL is the persistence/history layer.
//
// Maps are `export const` and mutated in place — importers share
// the same reference. Scalars use ESM live bindings: importers
// always read the current value; mutation happens only through
// the setters below.
// ============================================================
import { SOLAR_SCORE_DEFAULTS } from './config.js';

// In-memory snapshot cache: siteId -> latest snapshot data
export const snapshotCache = new Map();

// Pepwave device cache: deviceName -> device data
export const pepwaveCache = new Map();
export const ic2DeviceIdToSiteId = new Map();  // ic2DeviceId -> siteId (persistent linkage)
export const ic2DeviceIdToName = new Map();    // ic2DeviceId -> deviceName (for pepwave lookups)

// GPS cache: siteId -> { latitude, longitude, updatedAt }
export const gpsCache = new Map();

// Trailer to job site mapping: siteId -> job_site_name
export const trailerJobSiteMap = new Map();

// SOC-at-start-of-day cache: siteId -> { date, soc }
// Used to estimate daily consumption when CE diagnostic is unavailable
export const socStartOfDay = new Map();

// Consumption accumulator: siteId -> { date, wh, lastTimestamp }
// Integrates DC load power over time when CE diagnostic unavailable
export const consumptionAccumulator = new Map();

// Daily energy per site: siteId -> Map(date -> { yield_wh, consumed_wh, ... })
export const dailyEnergy = new Map();

// Weather / Solar Irradiance cache. Key: "lat,lon" (rounded to 0.1°)
export const weatherCache = new Map();

// deviceName -> firstOfflineTime
export const offlineTimestamps = new Map();

// siteId -> { breached, distance_m, lastAlertedAt, site_name, job_site_name }
export const geofenceAlerts = new Map();

// Solar score config: defaults, overwritten in place from settings at startup
export const solarScoreConfig = { ...SOLAR_SCORE_DEFAULTS };

// --- Mutable scalars (read via live bindings, written via setters) ---

export let dbAvailable = false;
export function setDbAvailable(v) { dbAvailable = v; }

export let pgvectorAvailable = false;
export function setPgvectorAvailable(v) { pgvectorAvailable = v; }

export let dbPool = null;
export function setDbPool(v) { dbPool = v; }

export let sitesCache = null;
export let sitesCacheTime = 0;
export function setSitesCache(data) { sitesCache = data; sitesCacheTime = Date.now(); }

export let lastIc2Poll = 0;
export function setLastIc2Poll(v) { lastIc2Poll = v; }

export let bandwidthLoggedOnce = false;
export function setBandwidthLoggedOnce(v) { bandwidthLoggedOnce = v; }
