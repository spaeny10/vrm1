import { isEmailConfigured, sendAlertEmail, sendDigestEmail, sendGeofenceEmail } from '../email.js';
import { requireRole } from '../middleware/auth.js';
import { buildDigestData } from '../services/digest.js';

export function registerDigestRoutesRoutes(app) {

// --- Digest Preview ---
app.get('/api/reports/digest-preview', requireRole('admin'), async (req, res) => {
    try {
        const data = await buildDigestData();
        res.json({ success: true, digest: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check SendGrid configuration status
app.get('/api/email-config-status', requireRole('admin'), (req, res) => {
    const configured = isEmailConfigured();
    const recipients = (process.env.ALERT_EMAIL_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean);
    const fromEmail = process.env.ALERT_FROM_EMAIL || 'noreply@bigview.ai';
    const hasApiKey = Boolean(process.env.SENDGRID_API_KEY);
    const apiKeyPrefix = hasApiKey ? process.env.SENDGRID_API_KEY.substring(0, 10) + '...' : null;

    res.json({
        success: true,
        configured,
        config: {
            hasApiKey,
            apiKeyPrefix,
            fromEmail,
            recipients,
            recipientCount: recipients.length
        }
    });
});

// Send test email to verify SendGrid configuration
app.post('/api/test-email', requireRole('admin'), async (req, res) => {
    try {
        if (!isEmailConfigured()) {
            return res.status(400).json({
                success: false,
                error: 'SendGrid not configured. Set SENDGRID_API_KEY, ALERT_FROM_EMAIL, and ALERT_EMAIL_RECIPIENTS in environment variables.'
            });
        }

        const { type = 'alert' } = req.body;

        if (type === 'alert') {
            // Send a test energy deficit alert
            const testAlert = {
                site_id: 999999,
                site_name: 'Test Trailer (SendGrid Test)',
                streak_days: 3,
                severity: 'warning',
                deficit_days: [
                    { date: '2026-03-03', yield_wh: 1500, consumed_wh: 3200, deficit_wh: 1700 },
                    { date: '2026-03-04', yield_wh: 1800, consumed_wh: 3500, deficit_wh: 1700 },
                    { date: '2026-03-05', yield_wh: 1200, consumed_wh: 2800, deficit_wh: 1600 },
                ]
            };
            await sendAlertEmail(testAlert);
        } else if (type === 'digest') {
            // Send test daily digest
            const data = await buildDigestData();
            const recipients = (process.env.ALERT_EMAIL_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean);
            if (recipients.length === 0) {
                return res.status(400).json({ success: false, error: 'No ALERT_EMAIL_RECIPIENTS configured' });
            }
            await sendDigestEmail(recipients, data);
        } else if (type === 'geofence') {
            // Send test geofence alert
            const testGeofence = {
                site_name: 'Test Trailer (SendGrid Test)',
                job_site_name: 'Test Job Site, Colorado',
                distance_m: 750,
                geofence_radius_m: 500,
            };
            await sendGeofenceEmail(testGeofence);
        } else {
            return res.status(400).json({ success: false, error: 'Invalid type. Use: alert, digest, or geofence' });
        }

        res.json({
            success: true,
            message: `Test ${type} email sent successfully`,
            recipients: (process.env.ALERT_EMAIL_RECIPIENTS || '').split(',').map(e => e.trim()).filter(Boolean)
        });
    } catch (err) {
        console.error('Test email error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

}
