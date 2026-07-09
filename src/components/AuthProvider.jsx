import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { login as apiLogin, loginWithGoogle as apiLoginWithGoogle, fetchCurrentUser, updateProfile as apiUpdateProfile } from '../api/vrm';

const AuthContext = createContext(null);

export function useAuth() {
    return useContext(AuthContext);
}

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem('vrm_token');
        if (!token) {
            setLoading(false);
            return;
        }
        fetchCurrentUser()
            .then(data => setUser(data.user))
            .catch(() => localStorage.removeItem('vrm_token'))
            .finally(() => setLoading(false));
    }, []);

    const login = useCallback(async (username, password) => {
        const data = await apiLogin(username, password);
        localStorage.setItem('vrm_token', data.token);
        setUser(data.user);
        return data.user;
    }, []);

    const googleLogin = useCallback(async (credential) => {
        const data = await apiLoginWithGoogle(credential);
        localStorage.setItem('vrm_token', data.token);
        setUser(data.user);
        return data.user;
    }, []);

    const updateDisplayName = useCallback(async (displayName) => {
        const data = await apiUpdateProfile(displayName);
        setUser(prev => ({ ...prev, display_name: displayName }));
        return data;
    }, []);

    const logout = useCallback(() => {
        localStorage.removeItem('vrm_token');
        setUser(null);
    }, []);

    // Clear the forced-password-change flag after a successful change
    const markPasswordChanged = useCallback(() => {
        setUser(prev => (prev ? { ...prev, must_change_password: false } : prev));
    }, []);

    return (
        <AuthContext.Provider value={{ user, login, googleLogin, logout, loading, updateDisplayName, markPasswordChanged }}>
            {children}
        </AuthContext.Provider>
    );
}
