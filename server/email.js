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

    const deficitRows = (deficit_days || []).map(d => {
        const throttleBadge = d.throttled
            ? `<span style="display:inline-block;background:#f39c12;color:#1a1d23;padding:2px 6px;border-radius:3px;font-size:10px;margin-left:6px;">THROTTLED</span>`
            : '';
        return `
        <tr>
            <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${d.date}</td>
            <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1; text-align:right;">${(d.yield_wh / 1000).toFixed(2)} kWh</td>
            <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1; text-align:right;">${(d.consumed_wh / 1000).toFixed(2)} kWh</td>
            <td style="padding:8px 12px; border-bottom:1px solid #3a3f4b; color:${color}; text-align:right; font-weight:bold;">
                -${(d.deficit_wh / 1000).toFixed(2)} kWh${throttleBadge}
            </td>
        </tr>`;
    }).join('');

    const hasThrottled = (deficit_days || []).some(d => d.throttled);
    const throttleNote = hasThrottled
        ? `<p style="font-size:13px;color:#95a5a6;margin-top:16px;">
             <strong>Note:</strong> Days marked "THROTTLED" had high battery SOC (≥88%) with MPPT in Float/Storage mode.
             Small deficits on these days are typically due to intentional solar throttling, not energy shortage.
           </p>`
        : '';

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
        <p style="margin:0; color:#7f8c8d; font-size:13px;">Review this trailer's solar and battery configuration to prevent further energy loss.</p>
        ${throttleNote}`;

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

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    // === YESTERDAY'S FLEET SUMMARY ===
    const yesterdaySection = `
        <h2 style="margin:0 0 8px; color:#ecf0f1; font-size:18px;">📊 Yesterday's Fleet Performance</h2>
        <p style="margin:0 0 12px; color:#7f8c8d; font-size:12px;">${yesterdayStr} — Complete 24-hour metrics</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
                <td width="23%" style="padding:12px; background-color:#1a1d23; border-radius:6px; text-align:center;">
                    <div style="font-size:20px; font-weight:bold; color:#3498db;">${digestData.fleet_size || 0}</div>
                    <div style="font-size:10px; color:#7f8c8d; margin-top:4px;">Fleet Size</div>
                    <div style="font-size:9px; color:#5a6c7d; margin-top:2px;">${digestData.fleet_breakdown?.vrm || 0} VRM + ${digestData.fleet_breakdown?.ic2_only || 0} IC2</div>
                </td>
                <td width="4"></td>
                <td width="23%" style="padding:12px; background-color:#1a1d23; border-radius:6px; text-align:center;">
                    <div style="font-size:20px; font-weight:bold; color:#2ecc71;">${digestData.yesterday?.avg_eod_soc?.toFixed(1) || 0}%</div>
                    <div style="font-size:10px; color:#7f8c8d; margin-top:4px;">Avg EOD SOC</div>
                    <div style="font-size:9px; color:#5a6c7d; margin-top:2px;">End of day</div>
                </td>
                <td width="4"></td>
                <td width="23%" style="padding:12px; background-color:#1a1d23; border-radius:6px; text-align:center;">
                    <div style="font-size:20px; font-weight:bold; color:#f39c12;">${digestData.yesterday?.total_yield_kwh?.toFixed(1) || 0}</div>
                    <div style="font-size:10px; color:#7f8c8d; margin-top:4px;">Total Yield (kWh)</div>
                    <div style="font-size:9px; color:#5a6c7d; margin-top:2px;">All day</div>
                </td>
                <td width="4"></td>
                <td width="23%" style="padding:12px; background-color:#1a1d23; border-radius:6px; text-align:center;">
                    <div style="font-size:20px; font-weight:bold; color:#9b59b6;">${digestData.yesterday?.total_data_gb?.toFixed(1) || 0}</div>
                    <div style="font-size:10px; color:#7f8c8d; margin-top:4px;">Data Usage (GB)</div>
                    <div style="font-size:9px; color:#5a6c7d; margin-top:2px;">Network</div>
                </td>
            </tr>
        </table>`;

    // === CURRENT STATUS ===
    const currentSection = `
        <h2 style="margin:0 0 10px; color:#ecf0f1; font-size:16px;">🔋 Current Status</h2>
        <p style="margin:0 0 12px; color:#7f8c8d; font-size:11px;">Right now — ${digestData.current?.online || 0}/${digestData.current?.total || 0} online · Avg SOC ${digestData.current?.avg_soc?.toFixed(1) || 0}%</p>`;

    // === NEEDS ATTENTION ===
    let needsAttentionSection = '';
    const criticalItems = digestData.critical_items || [];
    const watchItems = digestData.watch_items || [];

    if (criticalItems.length > 0 || watchItems.length > 0) {
        let criticalRows = '';
        if (criticalItems.length > 0) {
            criticalRows = criticalItems.map(item => {
                if (item.type === 'low_soc') {
                    return `<tr><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${item.trailer}</td><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#e74c3c; text-align:right; font-weight:bold;">SOC ${item.soc.toFixed(0)}%</td></tr>`;
                } else if (item.type === 'alarm') {
                    return `<tr><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${item.trailer}</td><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#e74c3c; text-align:right;">${item.message}</td></tr>`;
                }
                return '';
            }).join('');
        }

        let watchRows = '';
        if (watchItems.length > 0) {
            watchRows = watchItems.slice(0, 5).map(item => {
                if (item.type === 'low_soc') {
                    return `<tr><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${item.trailer}</td><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#f39c12; text-align:right;">SOC ${item.soc.toFixed(0)}%</td></tr>`;
                } else if (item.type === 'energy_deficit') {
                    return `<tr><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${item.trailer}</td><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#f39c12; text-align:right;">${item.streak_days}d deficit</td></tr>`;
                }
                return '';
            }).join('');
        }

        needsAttentionSection = `
            <h2 style="margin:0 0 10px; color:#ecf0f1; font-size:16px;">🚨 Needs Attention Today</h2>
            ${criticalItems.length > 0 ? `
                <h3 style="margin:0 0 8px; color:#e74c3c; font-size:13px;">Critical — Dispatch Now (${criticalItems.length})</h3>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:16px;">
                    ${criticalRows}
                </table>` : ''}
            ${watchItems.length > 0 ? `
                <h3 style="margin:0 0 8px; color:#f39c12; font-size:13px;">Watch — Monitor Today (${watchItems.length})</h3>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:24px;">
                    ${watchRows}
                </table>` : ''}`;
    }

    // === PERFORMANCE HIGHLIGHTS ===
    let performanceSection = '';
    const topPerformers = digestData.top_performers || [];
    const underperformers = digestData.underperformers || [];

    if (topPerformers.length > 0 || underperformers.length > 0) {
        performanceSection = `<h2 style="margin:0 0 10px; color:#ecf0f1; font-size:16px;">📈 Performance Highlights</h2>`;

        if (topPerformers.length > 0) {
            const topRows = topPerformers.map(p =>
                `<tr><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${p.site_name}</td><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#2ecc71; text-align:right; font-weight:bold;">${p.percent.toFixed(0)}%</td><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#7f8c8d; text-align:right; font-size:11px;">${p.yield_kwh.toFixed(1)} kWh</td></tr>`
            ).join('');
            performanceSection += `
                <h3 style="margin:0 0 8px; color:#2ecc71; font-size:13px;">Top Performers</h3>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:16px;">
                    ${topRows}
                </table>`;
        }

        if (underperformers.length > 0) {
            const underRows = underperformers.map(p =>
                `<tr><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${p.site_name}</td><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#e74c3c; text-align:right; font-weight:bold;">${p.percent.toFixed(0)}%</td><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#7f8c8d; text-align:right; font-size:11px;">${p.yield_kwh.toFixed(1)} kWh</td></tr>`
            ).join('');
            performanceSection += `
                <h3 style="margin:0 0 8px; color:#e74c3c; font-size:13px;">Underperformers</h3>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:24px;">
                    ${underRows}
                </table>`;
        }
    }

    // === NETWORK SUMMARY ===
    let networkSection = '';
    if (digestData.network) {
        const net = digestData.network;
        networkSection = `
            <h2 style="margin:0 0 10px; color:#ecf0f1; font-size:16px;">📡 Network Summary</h2>
            <p style="margin:0 0 12px; color:#7f8c8d; font-size:11px;">Avg Signal: ${net.avg_signal_dbm?.toFixed(0) || 0} dBm · Total Usage: ${net.total_data_gb?.toFixed(1) || 0} GB</p>`;

        if (net.high_usage && net.high_usage.length > 0) {
            const highRows = net.high_usage.map(h =>
                `<tr><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#ecf0f1;">${h.device}</td><td style="padding:6px 12px; border-bottom:1px solid #3a3f4b; color:#f39c12; text-align:right; font-weight:bold;">${h.usage_gb.toFixed(2)} GB</td></tr>`
            ).join('');
            networkSection += `
                <h3 style="margin:0 0 8px; color:#f39c12; font-size:13px;">High Data Usage (>500 MB)</h3>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#1a1d23; border-radius:6px; overflow:hidden; margin-bottom:24px;">
                    ${highRows}
                </table>`;
        }
    }

    // === ALL SYSTEMS NOMINAL ===
    const noIssues = (criticalItems.length === 0 && watchItems.length === 0)
        ? '<p style="color:#2ecc71; font-size:14px; margin:0 0 20px;">✓ All systems nominal. No critical issues to report.</p>'
        : '';

    const bodyContent = `${yesterdaySection}${currentSection}${noIssues}${needsAttentionSection}${performanceSection}${networkSection}`;

    const today = new Date().toISOString().slice(0, 10);
    const subject = `BIGView OMNI — Morning Digest for ${today}`;

    const msg = {
        to,
        from: FROM_EMAIL,
        subject,
        html: wrapHtml(subject, bodyContent),
    };

    await sgMail.send(msg);
}
