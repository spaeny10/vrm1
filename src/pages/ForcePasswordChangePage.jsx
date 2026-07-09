import { useState } from 'react'
import { useAuth } from '../components/AuthProvider'
import { changePassword } from '../api/vrm'

// Shown after login when the account is flagged must_change_password
// (e.g. the seeded default admin). Blocks the whole app until the
// password is rotated.
function ForcePasswordChangePage() {
    const { markPasswordChanged, logout } = useAuth()
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [error, setError] = useState('')
    const [saving, setSaving] = useState(false)

    const handleSubmit = async (e) => {
        e.preventDefault()
        setError('')
        if (newPassword !== confirmPassword) {
            setError('New passwords do not match')
            return
        }
        if (newPassword === currentPassword) {
            setError('New password must be different from the current password')
            return
        }
        setSaving(true)
        try {
            await changePassword(currentPassword, newPassword)
            markPasswordChanged()
        } catch (err) {
            setError(err.message?.includes('401') ? 'Current password is incorrect' : err.message || 'Password change failed')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="login-page">
            <form className="login-card" onSubmit={handleSubmit}>
                <div className="login-brand">
                    <div className="login-logo-row">
                        <img src="/logo.webp" alt="BIGView" className="login-logo-img" />
                        <span className="login-omni">OMNI</span>
                    </div>
                    <p className="login-subtitle">Set a new password to continue</p>
                </div>

                <div className="login-expired">
                    This account is using a temporary password. Choose a new one before accessing the dashboard.
                </div>
                {error && <div className="login-error">{error}</div>}

                <div className="form-group">
                    <label>Current Password</label>
                    <input
                        type="password"
                        value={currentPassword}
                        onChange={e => setCurrentPassword(e.target.value)}
                        autoComplete="current-password"
                        required
                    />
                </div>
                <div className="form-group">
                    <label>New Password</label>
                    <input
                        type="password"
                        value={newPassword}
                        onChange={e => setNewPassword(e.target.value)}
                        autoComplete="new-password"
                        minLength={4}
                        required
                    />
                </div>
                <div className="form-group">
                    <label>Confirm New Password</label>
                    <input
                        type="password"
                        value={confirmPassword}
                        onChange={e => setConfirmPassword(e.target.value)}
                        autoComplete="new-password"
                        minLength={4}
                        required
                    />
                </div>

                <button type="submit" className="btn btn-primary login-btn" disabled={saving}>
                    {saving ? 'Saving...' : 'Change Password'}
                </button>
                <button type="button" className="btn btn-ghost" style={{ marginTop: 10, width: '100%' }} onClick={logout}>
                    Sign out
                </button>
            </form>
        </div>
    )
}

export default ForcePasswordChangePage
