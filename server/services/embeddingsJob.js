import { dbAvailable, pgvectorAvailable, snapshotCache, pepwaveCache } from '../state.js';
import {
    embedSiteSnapshots, embedPepwaveDevices, embedAlerts, embedMaintenanceLogs, embedJobSites,
    isConfigured as isEmbeddingsConfigured,
} from '../embeddings.js';
import { computeAlerts } from './alerts.js';
import { upsertEmbedding, getMaintenanceLogs, getJobSites } from '../db.js';

// ============================================================
// Background Embedding Generation
// ============================================================
export async function generateEmbeddingsAsync() {
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
