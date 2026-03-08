import 'dotenv/config';
import { VoyageAIClient } from 'voyageai';

const voyage = process.env.VOYAGE_API_KEY
    ? new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY })
    : null;

// Use voyage-3 model (1024 dimensions, optimized for search)
const EMBEDDING_MODEL = 'voyage-3';

/**
 * Generate embeddings for a batch of texts
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
export async function generateEmbeddings(texts) {
    if (!voyage) {
        throw new Error('Voyage API key not configured');
    }

    if (!texts || texts.length === 0) {
        return [];
    }

    const BATCH_SIZE = 128; // Voyage-3 max per call
    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        try {
            const result = await voyage.embed({
                input: batch,
                model: EMBEDDING_MODEL,
                inputType: 'document'
            });
            allEmbeddings.push(...result.data.map(item => item.embedding));
        } catch (error) {
            console.error(`Embedding batch ${i}-${i + batch.length} failed:`, error.message);
            throw error;
        }
    }

    return allEmbeddings;
}

/**
 * Generate a single query embedding
 * @param {string} query - Query text
 * @returns {Promise<number[]>} Embedding vector
 */
export async function generateQueryEmbedding(query) {
    if (!voyage) {
        throw new Error('Voyage API key not configured');
    }

    try {
        const result = await voyage.embed({
            input: [query],
            model: EMBEDDING_MODEL,
            inputType: 'query' // Optimized for search queries
        });

        return result.data[0].embedding;
    } catch (error) {
        console.error('Query embedding generation failed:', error.message);
        throw error;
    }
}

/**
 * Convert site snapshot to searchable text
 */
export function siteSnapshotToText(site) {
    const parts = [
        `Site: ${site.site_name || 'Site ' + site.site_id}`,
        site.battery_soc !== null ? `Battery: ${site.battery_soc}% SOC` : null,
        site.battery_voltage !== null ? `${site.battery_voltage}V` : null,
        site.solar_watts !== null ? `Solar: ${site.solar_watts}W` : null,
        site.charge_state ? `State: ${site.charge_state}` : null,
        site.battery_temp !== null ? `Temp: ${site.battery_temp}°C` : null,
    ].filter(Boolean);

    return parts.join(', ');
}

/**
 * Convert pepwave device to searchable text
 */
export function pepwaveDeviceToText(device) {
    const parts = [
        `Device: ${device.device_name}`,
        device.online !== null ? (device.online ? 'Online' : 'Offline') : null,
        device.signal_bar !== null ? `Signal: ${device.signal_bar}/5 bars` : null,
        device.rsrp !== null ? `RSRP: ${device.rsrp}dBm` : null,
        device.carrier ? `Carrier: ${device.carrier}` : null,
        device.technology ? `Technology: ${device.technology}` : null,
    ].filter(Boolean);

    return parts.join(', ');
}

/**
 * Convert alert to searchable text
 */
export function alertToText(alert) {
    const throttledCount = alert.deficit_days?.filter(d => d.throttled).length || 0;
    const realCount = alert.deficit_days?.length - throttledCount;

    const parts = [
        `Alert for ${alert.site_name}`,
        `${alert.streak_days} consecutive days of real energy deficit`,
        throttledCount > 0 ? `(${throttledCount} throttled days excluded)` : null,
        `Severity: ${alert.severity}`,
        alert.deficit_days && alert.deficit_days.length > 0
            ? `Latest deficit: ${Math.round(alert.deficit_days[0].deficit_wh / 1000)}kWh${alert.deficit_days[0].throttled ? ' (throttled)' : ''}`
            : null,
    ].filter(Boolean);

    return parts.join('. ');
}

/**
 * Convert diagnostic message to searchable text
 */
export function diagnosticToText(diag, siteName) {
    return `${siteName}: ${diag.description || diag.formattedValue || diag.code}`;
}

/**
 * Batch embed site snapshots
 */
export async function embedSiteSnapshots(sites) {
    const texts = sites.map(siteSnapshotToText);
    const embeddings = await generateEmbeddings(texts);

    return sites.map((site, i) => ({
        contentType: 'site',
        contentId: String(site.site_id),
        contentText: texts[i],
        embedding: embeddings[i],
        metadata: {
            site_id: site.site_id,
            site_name: site.site_name,
            battery_soc: site.battery_soc,
            timestamp: site.timestamp,
        }
    }));
}

/**
 * Batch embed pepwave devices
 */
export async function embedPepwaveDevices(devices) {
    const texts = devices.map(pepwaveDeviceToText);
    const embeddings = await generateEmbeddings(texts);

    return devices.map((device, i) => ({
        contentType: 'device',
        contentId: device.device_name,
        contentText: texts[i],
        embedding: embeddings[i],
        metadata: {
            device_name: device.device_name,
            online: device.online,
            signal_bar: device.signal_bar,
            timestamp: device.timestamp,
        }
    }));
}

/**
 * Batch embed alerts
 */
export async function embedAlerts(alerts) {
    const texts = alerts.map(alertToText);
    const embeddings = await generateEmbeddings(texts);

    return alerts.map((alert, i) => ({
        contentType: 'alert',
        contentId: `${alert.site_id}-${Date.now()}`,
        contentText: texts[i],
        embedding: embeddings[i],
        metadata: {
            site_id: alert.site_id,
            site_name: alert.site_name,
            severity: alert.severity,
            streak_days: alert.streak_days,
        }
    }));
}

/**
 * Convert maintenance log to searchable text
 */
export function maintenanceLogToText(log) {
    const dateFmt = (ms) => ms ? new Date(Number(ms)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
    const parts = [
        `Maintenance: ${log.title}`,
        log.job_site_name ? `at ${log.job_site_name}` : null,
        log.trailer_name ? `for ${log.trailer_name}` : null,
        `Type: ${log.visit_type}`,
        `Status: ${log.status}`,
        log.scheduled_date ? `Scheduled: ${dateFmt(log.scheduled_date)}` : null,
        (log.assigned_technician_name || log.technician) ? `Technician: ${log.assigned_technician_name || log.technician}` : null,
        log.description ? `Description: ${log.description.slice(0, 200)}` : null,
        (log.labor_cost_cents || log.parts_cost_cents) ? `Cost: $${(((log.labor_cost_cents || 0) + (log.parts_cost_cents || 0)) / 100).toFixed(2)}` : null,
    ].filter(Boolean);
    return parts.join('. ');
}

/**
 * Convert job site to searchable text
 */
export function jobSiteToText(site) {
    const dateFmt = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
    const parts = [
        `Job Site: ${site.name}`,
        site.address ? `Address: ${site.address}` : null,
        `Status: ${site.status}`,
        site.trailer_count != null ? `Trailers: ${site.trailer_count}` : null,
        site.delivery_date ? `Delivery: ${dateFmt(site.delivery_date)}` : null,
        site.active_date ? `Active: ${dateFmt(site.active_date)}` : null,
        site.calloff_date ? `Call-off: ${dateFmt(site.calloff_date)}` : null,
        site.pickup_date ? `Pickup: ${dateFmt(site.pickup_date)}` : null,
        site.notes ? `Notes: ${site.notes.slice(0, 200)}` : null,
    ].filter(Boolean);
    return parts.join('. ');
}

/**
 * Batch embed maintenance logs
 */
export async function embedMaintenanceLogs(logs) {
    if (!logs || logs.length === 0) return [];
    const texts = logs.map(maintenanceLogToText);
    const embeddings = await generateEmbeddings(texts);
    return logs.map((log, i) => ({
        contentType: 'maintenance',
        contentId: String(log.id),
        contentText: texts[i],
        embedding: embeddings[i],
        metadata: {
            id: log.id,
            job_site_name: log.job_site_name,
            visit_type: log.visit_type,
            status: log.status,
            technician: log.assigned_technician_name || log.technician,
        }
    }));
}

/**
 * Batch embed job sites
 */
export async function embedJobSites(sites) {
    if (!sites || sites.length === 0) return [];
    const texts = sites.map(jobSiteToText);
    const embeddings = await generateEmbeddings(texts);
    return sites.map((site, i) => ({
        contentType: 'job_site',
        contentId: String(site.id),
        contentText: texts[i],
        embedding: embeddings[i],
        metadata: {
            id: site.id,
            name: site.name,
            status: site.status,
            address: site.address,
        }
    }));
}

export function isConfigured() {
    return voyage !== null;
}
