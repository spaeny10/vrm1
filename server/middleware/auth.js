import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { JWT_SECRET } from '../config.js';

export function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        // Tokens issued before display_name was added to the payload fall
        // back to the username so authorship/audit never reads "system"
        if (!decoded.display_name) decoded.display_name = decoded.username;
        req.user = decoded;
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}

// Auth gate for all /api routes except login/health and the Twilio
// webhook (Twilio can't send a Bearer token; the webhook handler
// authenticates the request via Twilio signature validation instead)
export function apiAuthGate(req, res, next) {
    if (req.path === '/auth/login' || req.path === '/auth/google' || req.path === '/health'
        || req.path === '/webhooks/twilio') return next();
    authMiddleware(req, res, () => {
        // Customer accounts are portal-only: internal routes expose every
        // customer's sites, rates and staff notes
        if (req.user.role === 'customer' && !CUSTOMER_ALLOWED.some(re => re.test(req.path))) {
            return res.status(403).json({ error: 'Not available to customer accounts' });
        }
        next();
    });
}

const CUSTOMER_ALLOWED = [/^\/auth\//, /^\/portal\//, /^\/notifications(\/|$)/];

// Rate limiters — SINGLETONS. aiLimiter is one shared bucket across all
// AI endpoints (/api/query and /api/analyze/trailer/:id); creating a
// second instance would double the quota.
export const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 15, message: { error: 'Too many login attempts, try again in 15 minutes' } });
export const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: 'Too many AI requests, try again in a minute' } });
