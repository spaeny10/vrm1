import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ALLOWED_GOOGLE_DOMAIN, GOOGLE_CLIENT_ID, JWT_EXPIRES_IN, JWT_SECRET } from '../config.js';
import { createGoogleUser, getUserByEmail, getUserByGoogleId, getUserById, getUserByUsername, updateUser } from '../db.js';
import { loginLimiter } from '../middleware/auth.js';

export function registerAuthRoutes(app) {

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        const user = await getUserByUsername(username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        await updateUser(user.id, { last_login: Date.now() });
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );
        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, must_change_password: user.must_change_password === true },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/me', async (req, res) => {
    try {
        const user = await getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/change-password', async (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        if (!current_password || !new_password) {
            return res.status(400).json({ error: 'Current and new password required' });
        }
        if (new_password.length < 4) {
            return res.status(400).json({ error: 'Password must be at least 4 characters' });
        }
        const user = await getUserByUsername(req.user.username);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const valid = await bcrypt.compare(current_password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        const hash = await bcrypt.hash(new_password, 10);
        await updateUser(req.user.id, { password_hash: hash, must_change_password: false });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update own profile (display name)
app.put('/api/auth/profile', async (req, res) => {
    try {
        const { display_name } = req.body;
        if (!display_name || !display_name.trim()) {
            return res.status(400).json({ error: 'Display name is required' });
        }
        await updateUser(req.user.id, { display_name: display_name.trim() });
        const updated = await getUserById(req.user.id);
        res.json({ success: true, user: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Google SSO authentication
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential } = req.body;
        if (!credential) {
            return res.status(400).json({ error: 'Google credential required' });
        }
        if (!GOOGLE_CLIENT_ID) {
            return res.status(500).json({ error: 'Google SSO not configured on server' });
        }

        // Verify the Google ID token
        const { OAuth2Client } = await import('google-auth-library');
        const client = new OAuth2Client(GOOGLE_CLIENT_ID);
        const ticket = await client.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();

        const { sub: googleId, email, name, hd } = payload;

        // Restrict to allowed domain
        if (hd !== ALLOWED_GOOGLE_DOMAIN) {
            return res.status(403).json({ error: `Only @${ALLOWED_GOOGLE_DOMAIN} accounts are allowed` });
        }

        // Check if user already exists by Google ID
        let user = await getUserByGoogleId(googleId);

        if (!user) {
            // Check if there's an existing user with same email (link accounts)
            user = await getUserByEmail(email);
            if (user) {
                // Link Google ID to existing account
                await updateUser(user.id, { google_id: googleId, email });
                user = await getUserById(user.id);
            } else {
                // Auto-create new user with viewer role
                user = await createGoogleUser(googleId, email, name || email.split('@')[0], 'viewer');
            }
        }

        if (!user.active) {
            return res.status(403).json({ error: 'Account is deactivated' });
        }

        await updateUser(user.id, { last_login: Date.now() });

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        });
    } catch (err) {
        console.error('Google auth error:', err.message);
        res.status(401).json({ error: 'Google authentication failed' });
    }
});

}
