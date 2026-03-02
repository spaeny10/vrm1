import { NavLink } from 'react-router-dom'
import { useAuth } from './AuthProvider'

export default function PortalSidebar({ className }) {
    const { user, logout } = useAuth()
    return (
        <aside className={`sidebar portal-sidebar ${className || ''}`}>
            <div className="sidebar-brand">
                <img src="/logo.webp" alt="BIGView" className="brand-logo" />
                <span className="brand-omni">OMNI</span>
            </div>
            <nav className="sidebar-nav">
                <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="7" height="7" rx="1" />
                        <rect x="14" y="3" width="7" height="7" rx="1" />
                        <rect x="3" y="14" width="7" height="7" rx="1" />
                        <rect x="14" y="14" width="7" height="7" rx="1" />
                    </svg>
                    <span>My Sites</span>
                </NavLink>
            </nav>
            <div className="sidebar-footer">
                {user && (
                    <div className="sidebar-user">
                        <div className="sidebar-user-info">
                            <span className="sidebar-user-name">{user.display_name}</span>
                            <span className="role-badge role-badge-customer">customer</span>
                        </div>
                        <button className="sidebar-logout" onClick={logout} title="Sign out">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                                <polyline points="16 17 21 12 16 7" />
                                <line x1="21" y1="12" x2="9" y2="12" />
                            </svg>
                        </button>
                    </div>
                )}
            </div>
        </aside>
    )
}
