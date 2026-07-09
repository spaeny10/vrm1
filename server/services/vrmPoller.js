import { VRM_USER_ID, TRAILER_SPECS } from '../config.js';
import {
    snapshotCache, pepwaveCache, gpsCache, trailerJobSiteMap, dailyEnergy,
    socStartOfDay, dbAvailable, pgvectorAvailable, sitesCache, setSitesCache,
} from '../state.js';
import { vrmFetch, extractDiagValue, extractVrmTimestamp } from './vrmClient.js';
import { insertSnapshot, pruneOldData, upsertTrailerAssignment } from '../db.js';
import { isConfigured as isEmbeddingsConfigured } from '../embeddings.js';
import { updateDailyEnergy } from './energy.js';
import { fetchSolarIrradiance } from './weather.js';
import { computeAlerts, persistAlertHistory, refreshTrailerJobSiteMap } from './alerts.js';
import { generateEmbeddingsAsync } from './embeddingsJob.js';
import { computeYesterdayMetrics } from './analyticsJobs.js';
import { detectGpsChanges } from './geofence.js';
import { refreshMaintStatsCache } from './intelligence.js';

// --- Background polling: VRM ---
export let isPolling = false;

export async function pollAllSites() {
    if (isPolling) return;
    isPolling = true;
    const startTime = Date.now();
    console.log(`[${new Date().toISOString()}] Polling VRM sites...`);

    try {
        if (!sitesCache) {
            const data = await vrmFetch(`/users/${VRM_USER_ID}/installations`);
            setSitesCache(data);
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

                    // GPS: IC2 Peplink is the sole source (populated in pollIc2Devices)

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

                    const vrmTs = extractVrmTimestamp(records);

                    const snapshot = {
                        site_id: site.idSite,
                        site_name: site.name,
                        timestamp: Date.now(),
                        vrm_timestamp: vrmTs,
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
                        } catch { }
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

        // Evict snapshots for sites no longer in VRM
        const activeSiteIds = new Set(sites.map(s => s.idSite));
        for (const cachedId of snapshotCache.keys()) {
            if (!activeSiteIds.has(cachedId)) {
                snapshotCache.delete(cachedId);
                gpsCache.delete(cachedId);      // clean up associated GPS
                dailyEnergy.delete(cachedId);    // clean up associated energy
            }
        }

        if (dbAvailable) {
            try { await pruneOldData(); } catch (e) { /* ignore */ }
            // Refresh trailer-to-job-site mapping for alert emails
            try { await refreshTrailerJobSiteMap(); } catch (e) { /* ignore */ }
            // Refresh maintenance stats for health grades
            try { await refreshMaintStatsCache(); } catch (e) { /* ignore */ }
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

        // GPS change detection runs continuously during polling
        if (dbAvailable && gpsCache.size > 0) {
            detectGpsChanges().catch(err =>
                console.error('  GPS change detection failed:', err.message)
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
