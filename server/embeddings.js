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

    try {
        const result = await voyage.embed({
            input: texts,
            model: EMBEDDING_MODEL,
            inputType: 'document' // For indexing/storing documents
        });

        return result.data.map(item => item.embedding);
    } catch (error) {
        console.error('Embedding generation failed:', error.message);
        throw error;
    }
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
    const parts = [
        `Alert for ${alert.site_name}`,
        `${alert.streak_days} consecutive days of energy deficit`,
        `Severity: ${alert.severity}`,
        alert.deficit_days && alert.deficit_days.length > 0
            ? `Latest deficit: ${Math.round(alert.deficit_days[0].deficit_wh / 1000)}kWh`
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

export function isConfigured() {
    return voyage !== null;
}
