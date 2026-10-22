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
        <div className="auth">
            <form className="auth-card" onSubmit={handleSubmit}>
                <div className="auth-brand"><img src="/logo.webp" alt="BIGView" /><span>OMNI</span></div>
                <p className="auth-sub">Set a new password to continue</p>
                <div className="callout" style={{ marginBottom: 14 }}>This account has a temporary password. Choose your own before continuing.</div>
                {error && <div className="callout crit" style={{ marginBottom: 14 }}>{error}</div>}
                <div className="form">
                    <label className="field"><span>Current password</span>
                        <input className="input" type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} autoComplete="current-password" required /></label>
                    <label className="field"><span>New password</span>
                        <input className="input" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" minLength={8} required /></label>
                    <label className="field"><span>Confirm new password</span>
                        <input className="input" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" minLength={8} required /></label>
                    <button className="btn primary" type="submit" disabled={saving} style={{ height: 38 }}>{saving ? 'Saving…' : 'Set password'}</button>
                    <button className="btn ghost" type="button" onClick={logout}>Sign out</button>
                </div>
            </form>
        </div>
    )
}

export default ForcePasswordChangePage
