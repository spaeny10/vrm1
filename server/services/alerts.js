import {
    dailyEnergy, trailerJobSiteMap, snapshotCache, dbAvailable,
} from '../state.js';
import { todayStr, mpptStateToString, hasVrmData } from '../lib/util.js';
import { DEFICIT_URGENT_BELOW_SOC } from '../config.js';
import { isMonitored } from './roster.js';
import { getTrailerAssignments, insertAlertHistory, resolveAlert, getActiveAlerts, updateActiveAlert } from '../db.js';
import { sendAlertEmail, sendAlertResolvedEmail, isEmailConfigured, checkRateLimit, markNotified } from '../email.js';

// ============================================================
// Trailer to Job Site Mapping
// ============================================================
export async function refreshTrailerJobSiteMap() {
    if (!dbAvailable) return;
    try {
        const assignments = await getTrailerAssignments();
        trailerJobSiteMap.clear();
        for (const assignment of assignments) {
            if (assignment.job_site_name) {
                trailerJobSiteMap.set(assignment.site_id, assignment.job_site_name);
            }
        }
    } catch (err) {
        console.error('  Error refreshing trailer job site map:', err.message);
    }
}

// ============================================================
// Alert logic: yield < consumed for 2+ consecutive REAL deficit days
// (excludes idle-throttled deficits: SOC ≥88%, MPPT Float/Storage, <1 kWh)
//
// Only trailers that are in service and reporting right now can have
// an energy alert. A unit in the yard may be indoors or on shore power;
// a superseded VRM installation isn't a trailer; and a trailer that has
// gone dark has a bigger problem than its energy balance, which the
// board reports as offline. Pass { all: true } to see every installation.
// ============================================================
export function computeAlerts({ all = false } = {}) {
    const alerts = [];
    const today = todayStr();

    for (const [siteId, days] of dailyEnergy.entries()) {
        const snapshot = snapshotCache.get(siteId);
        if (!all && (!isMonitored(siteId) || !hasVrmData(snapshot))) continue;

        const dates = Object.keys(days)
            .filter(d => d < today)
            .sort()
            .reverse();

        let realStreak = 0;  // Only count real deficits
        const siteName = Object.values(days)[0]?.site_name || `Site ${siteId}`;

        // Count consecutive real deficit days (idle-throttled breaks streak)
        for (const date of dates) {
            const { yield_wh, consumed_wh } = days[date];

            if (yield_wh !== null && consumed_wh !== null && yield_wh < consumed_wh) {
                const deficitWh = consumed_wh - yield_wh;
                const classification = isRealDeficit(days[date], deficitWh);

                if (classification.real) {
                    realStreak++;  // ✅ Only count real deficits
                } else {
                    // Idle-throttled day breaks the streak (Option A)
                    break;
                }
            } else {
                break;  // Surplus day breaks streak
            }
        }

        if (realStreak >= 2) {  // Alert threshold: 2+ real deficit days
            // Collect all deficit days for transparency (including throttled)
            const allDeficitDays = [];
            for (let i = 0; i < dates.length; i++) {
                const date = dates[i];
                const day = days[date];

                if (day.yield_wh !== null && day.consumed_wh !== null && day.yield_wh < day.consumed_wh) {
                    const deficitWh = day.consumed_wh - day.yield_wh;
                    const classification = isRealDeficit(day, deficitWh);

                    allDeficitDays.push({
                        date,
                        yield_wh: day.yield_wh,
                        consumed_wh: day.consumed_wh,
                        deficit_wh: deficitWh,
                        throttled: !classification.real,      // NEW
                        throttle_reason: classification.reason,  // NEW
                        throttle_details: classification.details, // NEW
                    });

                    if (!classification.real) break;  // Stop at first throttled day
                } else {
                    break;  // Stop at surplus day
                }
            }

            // A long streak is only critical once the battery is being drawn
            // down; while it holds near full, the trailer is coping.
            const soc = hasVrmData(snapshot) ? snapshot.battery_soc : null;
            const batteryHolding = soc != null && soc >= DEFICIT_URGENT_BELOW_SOC;
            alerts.push({
                site_id: siteId,
                site_name: siteName,
                job_site_name: trailerJobSiteMap.get(siteId) || null,  // NEW: Job site for email context
                streak_days: realStreak,  // Only real deficit days
                deficit_days: allDeficitDays,
                battery_soc: soc,
                battery_holding: batteryHolding,
                severity: realStreak >= 5 && !batteryHolding ? 'critical' : realStreak >= 3 ? 'warning' : 'caution',
            });
        }
    }

    alerts.sort((a, b) => b.streak_days - a.streak_days);
    return alerts;
}

export function isRealDeficit(dayData, deficitWh) {
    // Missing data - can't determine, assume real for safety
    if (!dayData || deficitWh === null || deficitWh === undefined) {
        return { real: true, reason: null, details: null };
    }

    // Check throttling conditions
    const mpptState = dayData.mppt_state_eod;
    const isThrottled = mpptState === 5 || mpptState === 6;  // Float or Storage
    const isHighSoc = dayData.battery_soc_eod !== null && dayData.battery_soc_eod >= 88;
    const isSmallDeficit = deficitWh < 1000;  // <1 kWh

    // All three conditions met = idle throttling, not a real problem
    if (isThrottled && isHighSoc && isSmallDeficit) {
        return {
            real: false,
            reason: 'idle_throttled',
            details: `EOD: ${dayData.battery_soc_eod?.toFixed(0)}% SOC, MPPT ${mpptStateToString(mpptState)}, ${(deficitWh / 1000).toFixed(2)} kWh deficit`
        };
    }

    return { real: true, reason: null, details: null };
}

// ============================================================
// Alert history persistence
// ============================================================
export async function persistAlertHistory(currentAlerts) {
    try {
        const activeDbAlerts = await getActiveAlerts();
        const activeSiteIds = new Set(currentAlerts.map(a => a.site_id));
        const dbSiteIds = new Set(activeDbAlerts.map(a => a.site_id));

        // Insert new alerts; keep active ones current as streaks grow
        const activeBySite = new Map(activeDbAlerts.map(a => [a.site_id, a]));
        for (const alert of currentAlerts) {
            const totalDeficit = alert.deficit_days?.reduce((s, d) => s + (d.deficit_wh || 0), 0) || 0;
            const existing = activeBySite.get(alert.site_id);
            if (!existing) {
                await insertAlertHistory(alert.site_id, alert.site_name, alert.severity, alert.streak_days, totalDeficit);
                // Send email notification (rate-limited, fire-and-forget)
                if (isEmailConfigured() && !checkRateLimit(alert.site_id)) {
                    markNotified(alert.site_id);
                    sendAlertEmail(alert).catch(err => console.error('  Alert email error:', err.message));
                }
            } else if (existing.severity !== alert.severity || existing.streak_days !== alert.streak_days) {
                await updateActiveAlert(alert.site_id, alert.severity, alert.streak_days, totalDeficit);
                // Escalation to critical is worth a fresh email even inside the rate-limit window
                if (alert.severity === 'critical' && existing.severity !== 'critical' && isEmailConfigured()) {
                    markNotified(alert.site_id);
                    sendAlertEmail(alert).catch(err => console.error('  Alert email error:', err.message));
                }
            }
        }

        // Resolve alerts that are no longer active
        for (const dbAlert of activeDbAlerts) {
            if (!activeSiteIds.has(dbAlert.site_id)) {
                await resolveAlert(dbAlert.site_id);
                // "Resolved" means the energy balance recovered. If the alert ended
                // because the trailer went dark or left service, say nothing.
                const recovered = isMonitored(dbAlert.site_id) && hasVrmData(snapshotCache.get(dbAlert.site_id));
                if (recovered && isEmailConfigured()) {
                    sendAlertResolvedEmail(dbAlert).catch(err => console.error('  Resolution email error:', err.message));
                }
            }
        }
    } catch (err) {
        console.error('  persistAlertHistory error:', err.message);
    }
}
