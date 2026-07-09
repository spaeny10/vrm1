import { TRAILER_SPECS, SOLAR_SCORE_DEFAULTS } from '../config.js';
import {
    snapshotCache, pepwaveCache, dailyEnergy, gpsCache, trailerJobSiteMap,
    socStartOfDay, solarScoreConfig, dbAvailable, geofenceAlerts,
} from '../state.js';
import { getSetting, getDailyEnergy } from '../db.js';
import { fetchSolarIrradiance, computeAstronomicalPSH } from './weather.js';
import { hasVrmData, todayStr, extractMpptState, mpptStateToString, getPepwaveForTrailer } from '../lib/util.js';

export async function loadSolarScoreConfig() {
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
// Trailer Intelligence Computation (spec + location aware)
// ============================================================
export async function computeTrailerIntelligence(siteId) {
    const snapshot = snapshotCache.get(siteId);
    if (!snapshot || !hasVrmData(snapshot)) return null;

    const specs = TRAILER_SPECS;

    // --- Location & Weather ---
    const gps = gpsCache.get(siteId);
    let weather = null;
    if (gps) {
        try { weather = await fetchSolarIrradiance(gps.latitude, gps.longitude); } catch { }
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
        timestamp: snapshot.vrm_timestamp || snapshot.timestamp,
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

export function computeHealthGrade(siteId) {
    const snapshot = snapshotCache.get(siteId);
    if (!snapshot) return null;

    let totalScore = 0;
    let weights = 0;
    const cfg = solarScoreConfig;

    // Solar performance (25%) — use weather-adjusted expected yield + throttle compensation
    const siteEnergy = dailyEnergy.get(siteId) || {};
    const today = todayStr();
    const pastDays = Object.entries(siteEnergy)
        .filter(([d]) => d < today)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 7);
    if (pastDays.length > 0) {
        // Per-day scores using each day's stored expected yield (weather-adjusted)
        const dayScores = pastDays
            .filter(([, d]) => d.yield_wh != null && d.yield_wh > 0)
            .map(([, d]) => {
                const exp = d.expected_yield_wh || null;
                return exp > 0 ? Math.min(100, (d.yield_wh / exp) * 100) : null;
            })
            .filter(v => v !== null);
        if (dayScores.length > 0) {
            let solarPct = dayScores.reduce((s, v) => s + v, 0) / dayScores.length;

            // Throttle compensation: if batteries are full, low yield is expected (MPPT throttled)
            const csNum = typeof snapshot.charge_state === 'string' ? parseInt(snapshot.charge_state, 10) : snapshot.charge_state;
            const isThrottled = (typeof csNum === 'number' && !isNaN(csNum) && (csNum === 5 || csNum === 6))
                || (typeof snapshot.charge_state === 'string' && /float|idle|storage|external/i.test(snapshot.charge_state));
            const isHighSoc = snapshot.battery_soc !== null && snapshot.battery_soc >= cfg.throttle_soc_threshold;

            if (isThrottled && isHighSoc && solarPct < cfg.score_excellent) {
                solarPct = Math.max(solarPct, cfg.throttle_floor_score);
            }

            totalScore += solarPct * 0.25;
            weights += 0.25;
        }
    }

    // Battery SOC (30%) — this is the strongest indicator of system health
    if (snapshot.battery_soc !== null) {
        totalScore += Math.min(100, snapshot.battery_soc) * 0.30;
        weights += 0.30;
    }

    // Autonomy proxy (15%) — tiered scoring based on SOC levels
    if (snapshot.battery_soc !== null) {
        const autonomyScore = snapshot.battery_soc >= 60 ? 100 : snapshot.battery_soc >= 30 ? 60 : snapshot.battery_soc >= 15 ? 30 : 10;
        totalScore += autonomyScore * 0.15;
        weights += 0.15;
    }

    // Network status (15%)
    const pw = getPepwaveForTrailer({ site_name: snapshot.site_name, ic2_device_id: null, site_id: siteId });
    let networkScore = 50; // default if no data
    if (pw) {
        networkScore = pw.online ? (pw.signal_bar >= 3 ? 100 : pw.signal_bar >= 1 ? 60 : 30) : 0;
    }
    totalScore += networkScore * 0.15;
    weights += 0.15;

    // Maintenance / system health (15%) — default to 85 (no issues = healthy)
    totalScore += 85 * 0.15;
    weights += 0.15;

    const score = weights > 0 ? Math.round(totalScore / weights) : null;
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
    const color = score >= 90 ? '#27ae60' : score >= 75 ? '#16a085' : score >= 60 ? '#d4a017' : score >= 40 ? '#f39c12' : '#c0392b';

    return { grade, score, color };
}

// ============================================================
// Tech Status — Actionable 3-state status for field techs
// ============================================================
export function computeTechStatus(siteId, alertsMap) {
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
export function computeSocTrend(siteId) {
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
