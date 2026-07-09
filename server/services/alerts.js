import {
    dailyEnergy, trailerJobSiteMap, snapshotCache, dbAvailable,
} from '../state.js';
import { todayStr, mpptStateToString, extractMpptState } from '../lib/util.js';
import { getTrailerAssignments, insertAlertHistory, resolveAlert, getActiveAlerts } from '../db.js';
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
// ============================================================
export function computeAlerts() {
    const alerts = [];
    const today = todayStr();

    for (const [siteId, days] of dailyEnergy.entries()) {
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

            alerts.push({
                site_id: siteId,
                site_name: siteName,
                job_site_name: trailerJobSiteMap.get(siteId) || null,  // NEW: Job site for email context
                streak_days: realStreak,  // Only real deficit days
                deficit_days: allDeficitDays,
                severity: realStreak >= 5 ? 'critical' : realStreak >= 3 ? 'warning' : 'caution',
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

        // Insert new alerts
        for (const alert of currentAlerts) {
            if (!dbSiteIds.has(alert.site_id)) {
                const totalDeficit = alert.deficit_days?.reduce((s, d) => s + (d.deficit_wh || 0), 0) || 0;
                await insertAlertHistory(alert.site_id, alert.site_name, alert.severity, alert.streak_days, totalDeficit);
                // Send email notification (rate-limited, fire-and-forget)
                if (isEmailConfigured() && !checkRateLimit(alert.site_id)) {
                    markNotified(alert.site_id);
                    sendAlertEmail(alert).catch(err => console.error('  Alert email error:', err.message));
                }
            }
        }

        // Resolve alerts that are no longer active
        for (const dbAlert of activeDbAlerts) {
            if (!activeSiteIds.has(dbAlert.site_id)) {
                await resolveAlert(dbAlert.site_id);
                // Send resolution email (fire-and-forget)
                if (isEmailConfigured()) {
                    sendAlertResolvedEmail(dbAlert).catch(err => console.error('  Resolution email error:', err.message));
                }
            }
        }
    } catch (err) {
        console.error('  persistAlertHistory error:', err.message);
    }
}
