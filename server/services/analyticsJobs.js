import { dbAvailable } from '../state.js';
import { computeDailyMetrics } from '../db.js';

// Lazy daily metrics computation — call after VRM poll
export let lastMetricsDate = null;

export async function computeYesterdayMetrics() {
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
