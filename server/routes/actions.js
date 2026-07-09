import { acknowledgeAction as dbAcknowledgeAction, unacknowledgeAction as dbUnacknowledgeAction } from '../db.js';
import { TRAILER_SPECS } from '../config.js';
import { getAcknowledgedActions, getUpcomingMaintenance, getBillingPastCalloff, getBillingAtHeadquarters, getUnbilledDeployedTrailers, getGpsSuggestions } from '../db.js';
import { hasVrmData, todayStr } from '../lib/util.js';
import { requireRole } from '../middleware/auth.js';
import { computeAlerts } from '../services/alerts.js';
import { dailyEnergy, dbAvailable, geofenceAlerts, snapshotCache } from '../state.js';

export function registerActionsRoutes(app) {

app.get('/api/action-queue', async (req, res) => {
    try {
        const actions = [];
        const now = Date.now();

        // Source 1: Energy deficit alerts
        const alerts = computeAlerts();
        for (const alert of alerts) {
            const priority = alert.severity === 'critical' ? 1 : alert.severity === 'warning' ? 3 : 5;
            actions.push({
                key: `alert:${alert.site_id}`,
                priority,
                category: 'energy',
                title: `Energy Deficit — ${alert.streak_days} day streak`,
                subtitle: alert.site_name,
                site_id: alert.site_id,
                site_name: alert.site_name,
                severity: alert.severity,
                details: {
                    streak_days: alert.streak_days,
                    deficit_days: alert.deficit_days,
                    hasThrottledDays: alert.deficit_days.some(d => d.throttled),  // NEW
                },
                created_at: now,
            });
        }

        // Source 2: Intelligence flags (VRM-connected trailers only)
        for (const [siteId, snapshot] of snapshotCache) {
            if (!hasVrmData(snapshot)) continue;
            // Battery temp critical
            if (snapshot.battery_temp !== null && snapshot.battery_temp > 45) {
                actions.push({
                    key: `intel:temp:${siteId}`,
                    priority: 2,
                    category: 'intelligence',
                    title: `Battery Temp Critical — ${snapshot.battery_temp}°C`,
                    subtitle: snapshot.site_name,
                    site_id: siteId,
                    site_name: snapshot.site_name,
                    severity: 'critical',
                    details: { temp: snapshot.battery_temp },
                    created_at: now,
                });
            }

            // Low SOC (proxy for autonomy)
            if (snapshot.battery_soc !== null && snapshot.battery_soc < 15) {
                actions.push({
                    key: `intel:soc:${siteId}`,
                    priority: 2,
                    category: 'intelligence',
                    title: `Critical Battery — ${snapshot.battery_soc}% SOC`,
                    subtitle: snapshot.site_name,
                    site_id: siteId,
                    site_name: snapshot.site_name,
                    severity: 'critical',
                    details: { soc: snapshot.battery_soc },
                    created_at: now,
                });
            } else if (snapshot.battery_soc !== null && snapshot.battery_soc < 30) {
                actions.push({
                    key: `intel:soc:${siteId}`,
                    priority: 4,
                    category: 'intelligence',
                    title: `Low Battery — ${snapshot.battery_soc}% SOC`,
                    subtitle: snapshot.site_name,
                    site_id: siteId,
                    site_name: snapshot.site_name,
                    severity: 'warning',
                    details: { soc: snapshot.battery_soc },
                    created_at: now,
                });
            }
        }

        // Source 3: Maintenance overdue/upcoming
        if (dbAvailable) {
            try {
                const upcoming = await getUpcomingMaintenance(30);
                for (const item of upcoming) {
                    if (item.status === 'cancelled' || item.status === 'completed') continue;
                    const scheduled = item.scheduled_date;
                    if (!scheduled) continue;
                    const daysUntil = (scheduled - now) / 86400000;
                    let priority, severity;
                    if (daysUntil < 0) { priority = 2; severity = 'critical'; }
                    else if (daysUntil <= 3) { priority = 4; severity = 'warning'; }
                    else if (daysUntil <= 7) { priority = 6; severity = 'info'; }
                    else continue;
                    actions.push({
                        key: `maint:${item.id}`,
                        priority,
                        category: 'maintenance',
                        title: daysUntil < 0 ? `Overdue: ${item.title}` : `Due in ${Math.ceil(daysUntil)}d: ${item.title}`,
                        subtitle: item.job_site_name || item.site_name || 'Unassigned',
                        site_id: item.site_id,
                        site_name: item.site_name,
                        severity,
                        details: { maintenance_id: item.id, scheduled_date: scheduled, visit_type: item.visit_type },
                        created_at: item.created_at || now,
                    });
                }
            } catch { }
        }

        // Source: Predictive SOC depletion (VRM-connected trailers only)
        for (const [siteId, snapshot] of snapshotCache) {
            if (!hasVrmData(snapshot)) continue;
            const siteEnergy = dailyEnergy.get(siteId) || {};
            const today = todayStr();
            const pastDays = Object.entries(siteEnergy)
                .filter(([d]) => d < today)
                .sort(([a], [b]) => b.localeCompare(a))
                .slice(0, 7);
            const consumptionValues = pastDays.map(([, i]) => i.consumed_wh).filter(v => v !== null && v > 0);
            let avgConsumption = consumptionValues.length > 0
                ? consumptionValues.reduce((s, v) => s + v, 0) / consumptionValues.length
                : null;
            if (avgConsumption === null) {
                const todayData = siteEnergy[today];
                if (todayData?.consumed_wh > 0) avgConsumption = todayData.consumed_wh;
            }
            if (avgConsumption && avgConsumption > 0 && snapshot.battery_soc !== null) {
                const usableWh = Math.max(0, (snapshot.battery_soc - TRAILER_SPECS.battery.min_soc_threshold) * TRAILER_SPECS.battery.total_wh / 100);
                const daysToCritical = Math.round((usableWh / avgConsumption) * 10) / 10;
                if (daysToCritical <= 3) {
                    actions.push({
                        key: `predictive:soc:${siteId}`,
                        priority: daysToCritical <= 1 ? 1 : 2,
                        category: 'battery',
                        title: `SOC critical in ~${daysToCritical} days`,
                        subtitle: snapshot.site_name,
                        site_id: siteId,
                        details: `Current SOC: ${snapshot.battery_soc}%, avg consumption: ${Math.round(avgConsumption)}Wh/day`,
                    });
                }
            }
        }

        // Source: Geofence breaches and suggestions
        for (const [siteId, gf] of geofenceAlerts) {
            if (gf.unassigned_near_site) {
                actions.push({
                    key: `geofence:suggest:${siteId}`,
                    priority: 2,
                    category: 'network',
                    title: `Unassigned Trailer Near Site`,
                    subtitle: `${gf.site_name}`,
                    site_id: siteId,
                    details: `Trailer is ${gf.distance_m}m from ${gf.suggested_site.name}. Consider assigning it.`,
                });
            } else {
                let detailsMsg = `Trailer is ${gf.distance_m}m from assigned job site (radius: 500m).`;
                if (gf.suggested_site) {
                    detailsMsg += ` Suggestion: Assign to ${gf.suggested_site.name} (${gf.suggested_site.distance_m}m away).`;
                }
                actions.push({
                    key: `geofence:${siteId}`,
                    priority: 2,
                    category: 'network',
                    title: `Geofence breach: ${gf.distance_m}m from site`,
                    subtitle: `${gf.site_name} — ${gf.job_site_name}`,
                    site_id: siteId,
                    details: detailsMsg,
                });
            }
        }

        // Source: Revenue leakage (rental/billing mismatches)
        if (dbAvailable) {
            try {
                const [pastCalloff, atHq, unbilled] = await Promise.all([
                    getBillingPastCalloff(),
                    getBillingAtHeadquarters(),
                    getUnbilledDeployedTrailers(),
                ]);
                for (const r of pastCalloff) {
                    actions.push({
                        key: `revenue:calloff:${r.id}`,
                        priority: 3,
                        category: 'revenue',
                        title: `Billing past calloff — ${r.unit_number}`,
                        subtitle: r.job_site_name || r.company_name || 'Rental',
                        rental_id: r.id,
                        severity: 'warning',
                        details: `Called off ${new Date(r.calloff_at).toLocaleDateString()} but billing never stopped. Stop billing or clear the calloff date on the Rentals page.`,
                        created_at: now,
                    });
                }
                for (const r of atHq) {
                    actions.push({
                        key: `revenue:athq:${r.id}`,
                        priority: 1,
                        category: 'revenue',
                        title: `Billing while at HQ — ${r.unit_number}`,
                        subtitle: r.hq_name,
                        rental_id: r.id,
                        severity: 'critical',
                        details: `Trailer is physically at ${r.hq_name} but its rental is still billing — the customer may be overbilled.`,
                        created_at: now,
                    });
                }
                for (const t of unbilled) {
                    actions.push({
                        key: `revenue:unbilled:${t.trailer_id}`,
                        priority: 1,
                        category: 'revenue',
                        title: `Unbilled trailer on site — ${t.unit_number}`,
                        subtitle: t.job_site_name,
                        trailer_id: t.trailer_id,
                        severity: 'critical',
                        details: `Deployed at active site "${t.job_site_name}" with no open rental — revenue is leaking. Create a rental for this unit.`,
                        created_at: now,
                    });
                }
            } catch { }
        }

        // Source: Pending GPS relocation suggestions (approve/reject inline)
        if (dbAvailable) {
            try {
                const suggestions = await getGpsSuggestions('pending');
                for (const sg of suggestions) {
                    const target = sg.suggestion_type === 'reassign_existing' && sg.suggested_job_site_name
                        ? `Suggest reassigning to ${sg.suggested_job_site_name}.`
                        : 'No nearby site matched — suggest creating a new job site.';
                    actions.push({
                        key: `gps:suggestion:${sg.id}`,
                        priority: 2,
                        category: 'location',
                        title: `Trailer moved ${Math.round(sg.distance_km * 10) / 10} km — ${sg.site_name}`,
                        subtitle: sg.current_job_site_name ? `Was at ${sg.current_job_site_name}` : 'Unassigned',
                        site_id: sg.site_id,
                        suggestion_id: sg.id,
                        severity: 'warning',
                        details: `${target} Approving updates the trailer's job-site assignment.`,
                        created_at: Number(sg.created_at) || now,
                    });
                }
            } catch { }
        }

        // Get acknowledged actions
        const acks = dbAvailable ? await getAcknowledgedActions() : [];
        const ackMap = new Map(acks.map(a => [a.action_key, a]));

        // Sort by priority, mark acknowledged
        actions.sort((a, b) => a.priority - b.priority);
        for (const action of actions) {
            const ack = ackMap.get(action.key);
            action.acknowledged = !!ack;
            if (ack) {
                action.acknowledged_by = ack.acknowledged_by_name;
                action.acknowledged_at = ack.acknowledged_at;
            }
        }

        const summary = {
            total: actions.length,
            critical: actions.filter(a => a.severity === 'critical').length,
            warning: actions.filter(a => a.severity === 'warning').length,
            info: actions.filter(a => !['critical', 'warning'].includes(a.severity)).length,
            acknowledged: actions.filter(a => a.acknowledged).length,
        };

        res.json({ success: true, actions, summary });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/action-queue/:key/acknowledge', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const ack = await dbAcknowledgeAction(decodeURIComponent(req.params.key), req.user.id, req.body.notes);
        res.json({ success: true, ack });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/action-queue/:key/acknowledge', requireRole('admin', 'technician'), async (req, res) => {
    try {
        await dbUnacknowledgeAction(decodeURIComponent(req.params.key));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

}
