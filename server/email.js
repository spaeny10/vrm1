import sgMail from '@sendgrid/mail';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const ALERT_EMAIL_RECIPIENTS = (process.env.ALERT_EMAIL_RECIPIENTS || '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);
const FROM_EMAIL = process.env.ALERT_FROM_EMAIL || 'noreply@bigview.ai';

if (SENDGRID_API_KEY) {
    sgMail.setApiKey(SENDGRID_API_KEY);
}

// ---------------------------------------------------------------------------
// Rate-limiting (in-memory, per site, 6-hour window)
// ---------------------------------------------------------------------------

const rateLimitMap = new Map(); // siteId -> timestamp (ms)
const RATE_LIMIT_MS = 6 * 60 * 60 * 1000; // 6 hours

export function checkRateLimit(siteId) {
    const lastSent = rateLimitMap.get(siteId);
    if (!lastSent) return false;
    return (Date.now() - lastSent) < RATE_LIMIT_MS;
}

export function markNotified(siteId) {
    rateLimitMap.set(siteId, Date.now());
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function isEmailConfigured() {
    return Boolean(SENDGRID_API_KEY);
}

// ---------------------------------------------------------------------------
// Shared HTML helpers
// ---------------------------------------------------------------------------

const SEVERITY_COLORS = {
    critical: '#e74c3c',
    warning: '#f39c12',
    caution: '#f1c40f',
};

function severityColor(severity) {
    return SEVERITY_COLORS[severity] || '#95a5a6';
}

function wrapHtml(title, bodyContent) {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
</head>
<body style="margin:0; padding:0; background-color:#1a1d23; font-family:Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23;">
        <tr>
            <td align="center" style="padding:24px 16px;">
                <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#23272e; border-radius:8px; overflow:hidden;">
                    <!-- Header -->
                    <tr>
                        <td style="padding:24px 32px; background-color:#2c3038; border-bottom:2px solid #3a3f4b;">
                            <span style="font-size:22px; font-weight:bold; color:#ecf0f1; letter-spacing:0.5px;">BIGView OMNI</span>
                            <span style="font-size:13px; color:#7f8c8d; margin-left:10px;">Fleet Management</span>
                        </td>
                    </tr>
                    <!-- Body -->
                    <tr>
                        <td style="padding:32px; color:#ecf0f1; font-size:14px; line-height:1.6;">
                            ${bodyContent}
                        </td>
                    </tr>
                    <!-- Footer -->
                    <tr>
                        <td style="padding:20px 32px; background-color:#2c3038; border-top:1px solid #3a3f4b; text-align:center;">
                            <a href="https://omni.bigview.ai" style="color:#3498db; text-decoration:none; font-size:13px;">omni.bigview.ai</a>
                            <p style="margin:8px 0 0; color:#7f8c8d; font-size:11px;">This is an automated notification from BIGView OMNI.</p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// sendAlertEmail
// ---------------------------------------------------------------------------

export async function sendAlertEmail(alert) {
    if (!isEmailConfigured() || ALERT_EMAIL_RECIPIENTS.length === 0) return;

    const { site_id, site_name, streak_days, severity, deficit_days } = alert;
    const color = severityColor(severity);

    const deficitRows = (deficit_days || []).map(d => `
        <tr>
            <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${d.date}</td>
            <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1; text-align:right;">${(d.yield_wh / 1000).toFixed(2)} kWh</td>
            <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1; text-align:right;">${(d.consumed_wh / 1000).toFixed(2)} kWh</td>
            <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:${color}; text-align:right; font-weight:bold;">-${(d.deficit_wh / 1000).toFixed(2)} kWh</td>
        </tr>`).join('');

    const body = `
        <div style="margin-bottom:24px;">
            <span style="display:inline-block; padding:4px 12px; border-radius:4px; background-color:${color}; color:#fff; font-size:12px; font-weight:bold; text-transform:uppercase;">${severity}</span>
        </div>
        <h2 style="margin:0 0 8px; color:#ecf0f1; font-size:18px;">Energy Deficit Alert</h2>
        <p style="margin:0 0 20px; color:#bdc3c7;">
            <strong>${site_name}</strong> (ID&nbsp;${site_id}) has been in energy deficit for
            <strong style="color:${color};">${streak_days} consecutive day${streak_days !== 1 ? 's' : ''}</strong>.
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:20px;">
            <tr style="background-color:#2c3038;">
                <th style="padding:10px 12px; text-align:left; color:#7f8c8d; font-size:12px; font-weight:600;">Date</th>
                <th style="padding:10px 12px; text-align:right; color:#7f8c8d; font-size:12px; font-weight:600;">Yield</th>
                <th style="padding:10px 12px; text-align:right; color:#7f8c8d; font-size:12px; font-weight:600;">Consumed</th>
                <th style="padding:10px 12px; text-align:right; color:#7f8c8d; font-size:12px; font-weight:600;">Deficit</th>
            </tr>
            ${deficitRows}
        </table>
        <p style="margin:0; color:#7f8c8d; font-size:13px;">Review this trailer's solar and battery configuration to prevent further energy loss.</p>`;

    const subject = `[${severity.toUpperCase()}] Energy deficit — ${site_name} (${streak_days} day${streak_days !== 1 ? 's' : ''})`;

    const msg = {
        to: ALERT_EMAIL_RECIPIENTS,
        from: FROM_EMAIL,
        subject,
        html: wrapHtml(subject, body),
    };

    await sgMail.send(msg);
}

// ---------------------------------------------------------------------------
// sendAlertResolvedEmail
// ---------------------------------------------------------------------------

export async function sendAlertResolvedEmail(alert) {
    if (!isEmailConfigured() || ALERT_EMAIL_RECIPIENTS.length === 0) return;

    const { site_id, site_name, severity, streak_days } = alert;
    const color = severityColor(severity);

    const body = `
        <div style="margin-bottom:24px;">
            <span style="display:inline-block; padding:4px 12px; border-radius:4px; background-color:#27ae60; color:#fff; font-size:12px; font-weight:bold; text-transform:uppercase;">RESOLVED</span>
        </div>
        <h2 style="margin:0 0 8px; color:#ecf0f1; font-size:18px;">Energy Deficit Resolved</h2>
        <p style="margin:0 0 20px; color:#bdc3c7;">
            The <span style="color:${color}; font-weight:bold;">${severity}</span> energy deficit alert for
            <strong>${site_name}</strong> (ID&nbsp;${site_id}) has been resolved after
            <strong>${streak_days} day${streak_days !== 1 ? 's' : ''}</strong>.
        </p>
        <p style="margin:0; color:#7f8c8d; font-size:13px;">The trailer is now generating enough solar energy to meet consumption. No action is required.</p>`;

    const subject = `[RESOLVED] Energy deficit cleared — ${site_name}`;

    const msg = {
        to: ALERT_EMAIL_RECIPIENTS,
        from: FROM_EMAIL,
        subject,
        html: wrapHtml(subject, body),
    };

    await sgMail.send(msg);
}

// ---------------------------------------------------------------------------
// sendGeofenceEmail
// ---------------------------------------------------------------------------

export async function sendGeofenceEmail(data) {
    if (!isEmailConfigured() || ALERT_EMAIL_RECIPIENTS.length === 0) return;

    const { site_name, job_site_name, distance_m, geofence_radius_m } = data;
    const overshoot = distance_m - geofence_radius_m;

    const body = `
        <div style="margin-bottom:24px;">
            <span style="display:inline-block; padding:4px 12px; border-radius:4px; background-color:#e74c3c; color:#fff; font-size:12px; font-weight:bold; text-transform:uppercase;">GEOFENCE BREACH</span>
        </div>
        <h2 style="margin:0 0 8px; color:#ecf0f1; font-size:18px;">Geofence Breach Detected</h2>
        <p style="margin:0 0 20px; color:#bdc3c7;">
            <strong>${site_name}</strong> has moved outside the geofence for
            <strong>${job_site_name}</strong>.
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:20px;">
            <tr>
                <td style="padding:10px 16px; color:#7f8c8d; font-size:13px; border-bottom:1px solid #3a3f4b;">Current Distance</td>
                <td style="padding:10px 16px; color:#e74c3c; font-size:13px; font-weight:bold; text-align:right; border-bottom:1px solid #3a3f4b;">${distance_m.toLocaleString()} m</td>
            </tr>
            <tr>
                <td style="padding:10px 16px; color:#7f8c8d; font-size:13px; border-bottom:1px solid #3a3f4b;">Geofence Radius</td>
                <td style="padding:10px 16px; color:#ecf0f1; font-size:13px; text-align:right; border-bottom:1px solid #3a3f4b;">${geofence_radius_m.toLocaleString()} m</td>
            </tr>
            <tr>
                <td style="padding:10px 16px; color:#7f8c8d; font-size:13px;">Distance Beyond Fence</td>
                <td style="padding:10px 16px; color:#e74c3c; font-size:13px; font-weight:bold; text-align:right;">${overshoot.toLocaleString()} m</td>
            </tr>
        </table>
        <p style="margin:0; color:#7f8c8d; font-size:13px;">Verify this trailer's location immediately. It may have been moved without authorization.</p>`;

    const subject = `[GEOFENCE] ${site_name} outside ${job_site_name} boundary`;

    const msg = {
        to: ALERT_EMAIL_RECIPIENTS,
        from: FROM_EMAIL,
        subject,
        html: wrapHtml(subject, body),
    };

    await sgMail.send(msg);
}

// ---------------------------------------------------------------------------
// sendDigestEmail
// ---------------------------------------------------------------------------

export async function sendDigestEmail(recipients, digestData) {
    if (!isEmailConfigured()) return;

    const to = Array.isArray(recipients) ? recipients : [recipients];
    if (to.length === 0) return;

    const {
        fleet_size = 0,
        avg_soc = 0,
        total_yield_kwh = 0,
        trailers_below_50_soc = [],
        active_alerts = [],
        overdue_maintenance = [],
        predictive_warnings = [],
    } = digestData;

    // --- Summary cards ---
    const summarySection = `
        <h2 style="margin:0 0 16px; color:#ecf0f1; font-size:18px;">Daily Fleet Digest</h2>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
                <td width="33%" style="padding:12px; background-color:#1a1d23; border-radius:6px; text-align:center;">
                    <div style="font-size:24px; font-weight:bold; color:#3498db;">${fleet_size}</div>
                    <div style="font-size:11px; color:#7f8c8d; margin-top:4px;">Fleet Size</div>
                </td>
                <td width="6"></td>
                <td width="33%" style="padding:12px; background-color:#1a1d23; border-radius:6px; text-align:center;">
                    <div style="font-size:24px; font-weight:bold; color:${avg_soc < 50 ? '#e74c3c' : '#2ecc71'};">${avg_soc.toFixed(1)}%</div>
                    <div style="font-size:11px; color:#7f8c8d; margin-top:4px;">Avg Battery SOC</div>
                </td>
                <td width="6"></td>
                <td width="33%" style="padding:12px; background-color:#1a1d23; border-radius:6px; text-align:center;">
                    <div style="font-size:24px; font-weight:bold; color:#f39c12;">${total_yield_kwh.toFixed(1)}</div>
                    <div style="font-size:11px; color:#7f8c8d; margin-top:4px;">Total Yield (kWh)</div>
                </td>
            </tr>
        </table>`;

    // --- Low SOC trailers ---
    let lowSocSection = '';
    if (trailers_below_50_soc.length > 0) {
        const rows = trailers_below_50_soc.map(t => `
            <tr>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${t.site_name}</td>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:${t.battery_soc < 25 ? '#e74c3c' : '#f39c12'}; text-align:right; font-weight:bold;">${t.battery_soc.toFixed(1)}%</td>
            </tr>`).join('');
        lowSocSection = `
            <h3 style="margin:0 0 10px; color:#ecf0f1; font-size:15px;">Low Battery Trailers</h3>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:24px;">
                <tr style="background-color:#2c3038;">
                    <th style="padding:10px 12px; text-align:left; color:#7f8c8d; font-size:12px; font-weight:600;">Trailer</th>
                    <th style="padding:10px 12px; text-align:right; color:#7f8c8d; font-size:12px; font-weight:600;">SOC</th>
                </tr>
                ${rows}
            </table>`;
    }

    // --- Active alerts ---
    let alertsSection = '';
    if (active_alerts.length > 0) {
        const rows = active_alerts.map(a => `
            <tr>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${a.site_name}</td>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; text-align:center;">
                    <span style="display:inline-block; padding:2px 8px; border-radius:3px; background-color:${severityColor(a.severity)}; color:#fff; font-size:11px; font-weight:bold; text-transform:uppercase;">${a.severity}</span>
                </td>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1; text-align:right;">${a.streak_days} day${a.streak_days !== 1 ? 's' : ''}</td>
            </tr>`).join('');
        alertsSection = `
            <h3 style="margin:0 0 10px; color:#ecf0f1; font-size:15px;">Active Energy Alerts</h3>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:24px;">
                <tr style="background-color:#2c3038;">
                    <th style="padding:10px 12px; text-align:left; color:#7f8c8d; font-size:12px; font-weight:600;">Trailer</th>
                    <th style="padding:10px 12px; text-align:center; color:#7f8c8d; font-size:12px; font-weight:600;">Severity</th>
                    <th style="padding:10px 12px; text-align:right; color:#7f8c8d; font-size:12px; font-weight:600;">Streak</th>
                </tr>
                ${rows}
            </table>`;
    }

    // --- Overdue maintenance ---
    let maintenanceSection = '';
    if (overdue_maintenance.length > 0) {
        const rows = overdue_maintenance.map(m => `
            <tr>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${m.title}</td>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${m.job_site_name}</td>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#e74c3c; text-align:right;">${m.scheduled_date}</td>
            </tr>`).join('');
        maintenanceSection = `
            <h3 style="margin:0 0 10px; color:#ecf0f1; font-size:15px;">Overdue Maintenance</h3>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:24px;">
                <tr style="background-color:#2c3038;">
                    <th style="padding:10px 12px; text-align:left; color:#7f8c8d; font-size:12px; font-weight:600;">Task</th>
                    <th style="padding:10px 12px; text-align:left; color:#7f8c8d; font-size:12px; font-weight:600;">Job Site</th>
                    <th style="padding:10px 12px; text-align:right; color:#7f8c8d; font-size:12px; font-weight:600;">Due Date</th>
                </tr>
                ${rows}
            </table>`;
    }

    // --- Predictive warnings ---
    let predictiveSection = '';
    if (predictive_warnings.length > 0) {
        const rows = predictive_warnings.map(p => `
            <tr>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${p.site_name}</td>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#f39c12; text-align:right; font-weight:bold;">${p.days_to_critical} day${p.days_to_critical !== 1 ? 's' : ''}</td>
                <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:${p.battery_soc < 25 ? '#e74c3c' : '#f39c12'}; text-align:right;">${p.battery_soc.toFixed(1)}%</td>
            </tr>`).join('');
        predictiveSection = `
            <h3 style="margin:0 0 10px; color:#ecf0f1; font-size:15px;">Predictive Warnings</h3>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:24px;">
                <tr style="background-color:#2c3038;">
                    <th style="padding:10px 12px; text-align:left; color:#7f8c8d; font-size:12px; font-weight:600;">Trailer</th>
                    <th style="padding:10px 12px; text-align:right; color:#7f8c8d; font-size:12px; font-weight:600;">Days to Critical</th>
                    <th style="padding:10px 12px; text-align:right; color:#7f8c8d; font-size:12px; font-weight:600;">Current SOC</th>
                </tr>
                ${rows}
            </table>`;
    }

    // --- No issues fallback ---
    const noIssues =
        trailers_below_50_soc.length === 0 &&
        active_alerts.length === 0 &&
        overdue_maintenance.length === 0 &&
        predictive_warnings.length === 0
            ? '<p style="color:#2ecc71; font-size:14px; margin:0 0 20px;">All systems nominal. No issues to report.</p>'
            : '';

    const bodyContent = `${summarySection}${noIssues}${lowSocSection}${alertsSection}${maintenanceSection}${predictiveSection}`;

    const today = new Date().toISOString().slice(0, 10);
    const subject = `BIGView OMNI — Fleet Digest for ${today}`;

    const msg = {
        to,
        from: FROM_EMAIL,
        subject,
        html: wrapHtml(subject, bodyContent),
    };

    await sgMail.send(msg);
}
