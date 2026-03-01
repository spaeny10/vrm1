import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../components/AuthProvider';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

export default function LoginPage() {
    const { login, googleLogin } = useAuth();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [sessionExpired, setSessionExpired] = useState(false);
    const googleBtnRef = useRef(null);

    useEffect(() => {
        if (localStorage.getItem('vrm_session_expired')) {
            setSessionExpired(true);
            localStorage.removeItem('vrm_session_expired');
        }
    }, []);

    const handleGoogleResponse = useCallback(async (response) => {
        setError('');
        setLoading(true);
        try {
            await googleLogin(response.credential);
        } catch (err) {
            setError(err.message || 'Google sign-in failed');
        } finally {
            setLoading(false);
        }
    }, [googleLogin]);

    useEffect(() => {
        if (!GOOGLE_CLIENT_ID || !window.google?.accounts?.id) return;
        window.google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: handleGoogleResponse,
            auto_select: false,
        });
        if (googleBtnRef.current) {
            window.google.accounts.id.renderButton(googleBtnRef.current, {
                theme: 'filled_black',
                size: 'large',
                width: 320,
                text: 'signin_with',
                shape: 'rectangular',
            });
        }
    }, [handleGoogleResponse]);

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
                    <div className="login-logo-row">
                        <img src="/logo.webp" alt="BIGView" className="login-logo-img" />
                        <span className="login-omni">OMNI</span>
                    </div>
                    <p className="login-subtitle">Fleet Management — Sign in to continue</p>
                </div>

                {sessionExpired && !error && (
                    <div className="login-expired">Your session has expired. Please sign in again.</div>
                )}
                {error && <div className="login-error">{error}</div>}

                {GOOGLE_CLIENT_ID && (
                    <>
                        <div className="google-signin-wrapper" ref={googleBtnRef}></div>
                        <div className="login-divider">
                            <span>or sign in with username</span>
                        </div>
                    </>
                )}

                <div className="form-group">
                    <label>Username</label>
                    <input
                        type="text"
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        autoFocus={!GOOGLE_CLIENT_ID}
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
