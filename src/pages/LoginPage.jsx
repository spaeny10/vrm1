import { useState } from 'react';
import { useAuth } from '../components/AuthProvider';

export default function LoginPage() {
    const { login } = useAuth();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            await login(username, password);
        } catch (err) {
            setError(err.message?.includes('401') ? 'Invalid username or password' : err.message || 'Login failed');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-page">
            <form className="login-card" onSubmit={handleSubmit}>
                <div className="login-brand">
                    <div className="login-logo">
                        <svg width="48" height="36" viewBox="0 0 48 36" fill="none">
                            <polygon points="24,0 48,36 0,36" fill="#1a1a2e" />
                            <polygon points="16,8 36,36 0,36" fill="#e74c3c" opacity="0.9" />
                            <polygon points="32,12 48,36 16,36" fill="#f39c12" opacity="0.9" />
                        </svg>
                    </div>
                    <h1 className="login-title">BVIM Dashboard</h1>
                    <p className="login-subtitle">Sign in to continue</p>
                </div>

                {error && <div className="login-error">{error}</div>}

                <div className="form-group">
                    <label>Username</label>
                    <input
                        type="text"
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        autoFocus
                        autoComplete="username"
                        required
                    />
                </div>

                <div className="form-group">
                    <label>Password</label>
                    <input
                        type="password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        autoComplete="current-password"
                        required
                    />
                </div>

                <button className="btn btn-primary login-btn" type="submit" disabled={loading}>
                    {loading ? 'Signing in...' : 'Sign In'}
                </button>
            </form>
        </div>
    );
}
