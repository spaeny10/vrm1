import { TRAILER_SPECS } from '../config.js';
import { dailyEnergy, socStartOfDay, consumptionAccumulator, dbAvailable, snapshotCache } from '../state.js';
import { todayStr, extractMpptState } from '../lib/util.js';
import { upsertDailyEnergy, getAllDailyEnergy } from '../db.js';

export function updateDailyEnergy(siteId, siteName, yieldToday, consumedAh, voltage, batterySoc, dcLoadW = null, loadCurrent = null, expectedYieldWh = null) {
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

    // Get snapshot to extract end-of-day MPPT state
    const snapshot = snapshotCache.get(siteId);
    const mpptStateEod = extractMpptState(snapshot);

    siteData[date] = {
        site_name: siteName,
        yield_wh: yieldWh,
        consumed_wh: consumedWh,
        consumption_source: consumptionSource,
        expected_yield_wh: expectedYieldWh ?? siteData[date]?.expected_yield_wh ?? null,
        battery_soc_eod: batterySoc,         // NEW: End-of-day SOC
        mppt_state_eod: mpptStateEod,        // NEW: End-of-day MPPT state
        updated: now,
    };

    // Persist to DB with SOC start-of-day + end-of-day state (async, don't block)
    if (dbAvailable) {
        const socVal = socStartOfDay.get(siteId);
        const socForDb = (socVal && socVal.date === date) ? socVal.soc : null;
        upsertDailyEnergy(siteId, date, siteName, yieldWh, consumedWh, socForDb, siteData[date].expected_yield_wh, consumptionSource, batterySoc, mpptStateEod).catch(() => { });
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
export async function seedDailyEnergyFromDb() {
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
