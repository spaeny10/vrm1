import bcrypt from 'bcryptjs';
import { createUser, deleteUser, getUsers, updateUser } from '../db.js';
import { requireRole } from '../middleware/auth.js';

export function registerUsersRoutes(app) {

app.get('/api/users', requireRole('admin'), async (req, res) => {
    try {
        const users = await getUsers();
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
    try {
        const { username, password, display_name, role } = req.body;
        if (!username || !password || !display_name) {
            return res.status(400).json({ error: 'Username, password, and display name required' });
        }
        if (!['admin', 'technician', 'viewer'].includes(role || 'viewer')) {
            return res.status(400).json({ error: 'Invalid role' });
        }
        const hash = await bcrypt.hash(password, 10);
        const user = await createUser(username, hash, display_name, role || 'viewer');
        res.json({ success: true, user });
    } catch (err) {
        if (err.message?.includes('unique') || err.code === '23505') {
            return res.status(409).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:id', requireRole('admin'), async (req, res) => {
    try {
        const { display_name, role, active, digest_enabled } = req.body;
        const updates = {};
        if (display_name !== undefined) updates.display_name = display_name;
        if (role !== undefined) updates.role = role;
        if (active !== undefined) updates.active = active;
        if (digest_enabled !== undefined) updates.digest_enabled = digest_enabled;
        const user = await updateUser(parseInt(req.params.id), updates);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {
    try {
        if (parseInt(req.params.id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot deactivate your own account' });
        }
        await deleteUser(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users/:id/reset-password', requireRole('admin'), async (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 4) {
            return res.status(400).json({ error: 'Password must be at least 4 characters' });
        }
        const hash = await bcrypt.hash(new_password, 10);
        const user = await updateUser(parseInt(req.params.id), { password_hash: hash });
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET mentionable users (lightweight, just id + display_name)
app.get('/api/users/mentionable', async (req, res) => {
    try {
        const users = await getUsers();
        const mentionable = users
            .filter(u => u.active !== false)
            .map(u => ({ id: u.id, display_name: u.display_name, role: u.role }));
        res.json({ success: true, users: mentionable });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

}
