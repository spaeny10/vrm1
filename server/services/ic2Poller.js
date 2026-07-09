import { IC2_ORG_ID, IC2_GROUP_ID, IC2_CLIENT_ID, IC2_CLIENT_SECRET } from '../config.js';
import {
    pepwaveCache, gpsCache, ic2DeviceIdToSiteId, ic2DeviceIdToName,
    dbAvailable, sitesCache, offlineTimestamps,
    setLastIc2Poll, setBandwidthLoggedOnce, bandwidthLoggedOnce,
} from '../state.js';
import { ic2Fetch, extractCellularInfo, extractWanInterfaces } from './ic2Client.js';
import { insertPepwaveSnapshot, upsertTrailerAssignment, linkIc2Device, updateTrailerGps, getPool } from '../db.js';
import { runClustering } from '../clustering.js';
import { checkGeofences, detectGpsChanges } from './geofence.js';

export function resolveIc2DeviceToSiteId(dev, vrmSites) {
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

// --- Background polling: InControl2 ---
export let isPollingIc2 = false;

export async function pollIc2Devices() {
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
                setBandwidthLoggedOnce(true);
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

        // Evict pepwaveCache entries for devices no longer in IC2
        const activeDeviceNames = new Set(devices.map(d => d.name));
        for (const cachedName of pepwaveCache.keys()) {
            if (!activeDeviceNames.has(cachedName)) {
                pepwaveCache.delete(cachedName);
                offlineTimestamps.delete(cachedName);
            }
        }

        // GPS change detection runs continuously during IC2 polling
        if (dbAvailable && gpsCache.size > 0) {
            detectGpsChanges().catch(err =>
                console.error('  GPS change detection failed:', err.message)
            );
        }

        // Re-run clustering periodically after GPS updates (every 30 min, not every poll)
        if (dbAvailable && gpsCache.size > 0) {
            const CLUSTER_INTERVAL = 30 * 60 * 1000; // 30 minutes
            if (!pollIc2Devices._lastCluster || Date.now() - pollIc2Devices._lastCluster > CLUSTER_INTERVAL) {
                pollIc2Devices._lastCluster = Date.now();
                runClustering().catch(err =>
                    console.error('  Auto-clustering after IC2 poll failed:', err.message)
                );
            }
        }

        // Check geofences after GPS update (async, don't block)
        if (gpsCache.size > 0) {
            checkGeofences().catch(err => console.error('  Geofence check failed:', err.message));
        }

        setLastIc2Poll(Date.now());
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  IC2 poll complete: ${devices.length} devices (${onlineCount} online, ${offlineCount} offline) in ${elapsed}s`);
    } catch (err) {
        console.error('  IC2 poll error:', err.message);
    } finally {
        isPollingIc2 = false;
    }
}
