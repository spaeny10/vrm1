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
        <div className="auth">
            <form className="auth-card" onSubmit={handleSubmit}>
                <div className="auth-brand"><img src="/logo.webp" alt="BIGView" /><span>OMNI</span></div>
                <p className="auth-sub">Fleet operations for BIGView solar surveillance trailers</p>

                {sessionExpired && !error && <div className="callout warn" style={{ marginBottom: 14 }}>Your session expired. Please sign in again.</div>}
                {error && <div className="callout crit" style={{ marginBottom: 14 }}>{error}</div>}

                <div className="form">
                    <label className="field">
                        <span>Username</span>
                        <input className="input" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoFocus required />
                    </label>
                    <label className="field">
                        <span>Password</span>
                        <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
                    </label>
                    <button className="btn primary" type="submit" disabled={loading} style={{ height: 38 }}>{loading ? 'Signing in…' : 'Sign in'}</button>
                </div>

                {GOOGLE_CLIENT_ID && (
                    <>
                        <div className="divider">or</div>
                        <div ref={googleBtnRef} style={{ display: 'flex', justifyContent: 'center' }} />
                    </>
                )}
            </form>
        </div>
    );
}
