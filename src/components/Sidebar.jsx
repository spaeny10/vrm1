import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useCallback, useState, useEffect } from 'react'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchFleetAlerts, fetchNotifications, markNotifRead, markAllNotifsRead } from '../api/vrm'
import { useAuth } from './AuthProvider'

function Sidebar({ mobileOpen, onCloseMobile }) {
    const { user, logout } = useAuth()
    const location = useLocation()
    const navigate = useNavigate()
    const fetchAlertsFn = useCallback(() => fetchFleetAlerts(), [])
    const { data: alertsData } = useApiPolling(fetchAlertsFn, 60000)
    const alertCount = alertsData?.alerts?.length || 0

    // Notifications
    const fetchNotifsFn = useCallback(() => fetchNotifications(), [])
    const { data: notifsData, refetch: refetchNotifs } = useApiPolling(fetchNotifsFn, 30000)
    const notifications = notifsData?.notifications || []
    const unreadCount = notifsData?.unread_count || 0
    const [showNotifs, setShowNotifs] = useState(false)

    const [theme, setTheme] = useState(() => localStorage.getItem('vrm_theme') || 'dark')
    const [collapsed, setCollapsed] = useState(() => {
        const saved = localStorage.getItem('vrm_sidebar_collapsed')
        return saved === 'true'
    })

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme)
        localStorage.setItem('vrm_theme', theme)
    }, [theme])

    useEffect(() => {
        localStorage.setItem('vrm_sidebar_collapsed', collapsed)
        // Update CSS variable for main content margin
        document.documentElement.style.setProperty('--sidebar-width', collapsed ? '70px' : '240px')
    }, [collapsed])

    // Close mobile sidebar on navigation
    useEffect(() => {
        if (onCloseMobile) onCloseMobile()
    }, [location.pathname])

    const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark')
    const toggleCollapsed = () => setCollapsed(c => !c)

    const formatNotifTime = (ts) => {
        if (!ts) return ''
        const diff = Date.now() - Number(ts)
        const mins = Math.floor(diff / 60000)
        if (mins < 1) return 'Just now'
        if (mins < 60) return `${mins}m ago`
        const hrs = Math.floor(mins / 60)
        if (hrs < 24) return `${hrs}h ago`
        return `${Math.floor(hrs / 24)}d ago`
    }

    return (
        <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}>
            <div className="sidebar-brand">
                <img src="/logo.webp" alt="BIGView" className="brand-logo" />
                <span className="brand-omni">OMNI</span>
            </div>

            <nav className="sidebar-nav">
                <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} data-tooltip={collapsed ? "Dashboard" : ""}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="7" height="7" rx="1" />
                        <rect x="14" y="3" width="7" height="7" rx="1" />
                        <rect x="3" y="14" width="7" height="7" rx="1" />
                        <rect x="14" y="14" width="7" height="7" rx="1" />
                    </svg>
                    <span>Dashboard</span>
                </NavLink>

                <NavLink to="/map" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} data-tooltip={collapsed ? "Map" : ""}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
                        <circle cx="12" cy="9" r="2.5" />
                    </svg>
                    <span>Map</span>
                </NavLink>

                <NavLink to="/fleet" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} data-tooltip={collapsed ? "Fleet Details" : ""}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 20V10M12 20V4M6 20v-6" />
                    </svg>
                    <span>Fleet Details</span>
                    {alertCount > 0 && <span className="nav-badge">{alertCount}</span>}
                </NavLink>

                <NavLink to="/maintenance" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} data-tooltip={collapsed ? "Maintenance" : ""}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                    <span>Maintenance</span>
                </NavLink>

                <NavLink to="/companies" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} data-tooltip={collapsed ? "Companies" : ""}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" />
                        <polyline points="9 22 9 12 15 12 15 22" />
                    </svg>
                    <span>Companies</span>
                </NavLink>

                <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} data-tooltip={collapsed ? "Settings" : ""}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                    </svg>
                    <span>Settings</span>
                </NavLink>

                <NavLink to="/help" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} data-tooltip={collapsed ? "Help & Documentation" : ""}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                        <circle cx="12" cy="17" r="0.5" fill="currentColor" />
                    </svg>
                    <span>Help</span>
                </NavLink>
            </nav>

            {/* Collapse toggle button - always visible at bottom of nav */}
            <button className="sidebar-collapse-toggle" onClick={toggleCollapsed}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {collapsed ? (
                        <path d="M9 18l6-6-6-6" />
                    ) : (
                        <path d="M15 18l-6-6 6-6" />
                    )}
                </svg>
                <span>{collapsed ? 'Expand' : 'Collapse'}</span>
            </button>

            <div className="sidebar-footer">
                {user && (
                    <div className="sidebar-user">
                        <div className="sidebar-user-info">
                            <span className="sidebar-user-name">{user.display_name}</span>
                            <span className={`role-badge role-badge-${user.role}`}>{user.role}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <div className="notif-bell-wrapper">
                                <button className="notif-bell-btn" onClick={() => setShowNotifs(v => !v)} title="Notifications">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                                    </svg>
                                    {unreadCount > 0 && <span className="notif-bell-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
                                </button>
                                {showNotifs && (
                                    <div className="notif-dropdown">
                                        <div className="notif-dropdown-header">
                                            <h3>Notifications</h3>
                                            {unreadCount > 0 && (
                                                <button onClick={() => { markAllNotifsRead().then(() => refetchNotifs()) }}>Mark all read</button>
                                            )}
                                        </div>
                                        {notifications.length === 0 ? (
                                            <div className="notif-empty">No notifications yet</div>
                                        ) : notifications.map(n => (
                                            <div
                                                key={n.id}
                                                className={`notif-item ${!n.read ? 'notif-item-unread' : ''}`}
                                                onClick={() => {
                                                    if (!n.read) markNotifRead(n.id).then(() => refetchNotifs())
                                                    if (n.link) navigate(n.link)
                                                    setShowNotifs(false)
                                                }}
                                            >
                                                <div className={`notif-dot ${n.read ? 'notif-dot-read' : ''}`} />
                                                <div className="notif-item-content">
                                                    <div className="notif-item-title">{n.title}</div>
                                                    {n.body && <div className="notif-item-body">{n.body}</div>}
                                                    <div className="notif-item-time">{formatNotifTime(n.created_at)}</div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <button className="theme-toggle" onClick={toggleTheme} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
                                {theme === 'dark' ? (
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <circle cx="12" cy="12" r="5" />
                                        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                                    </svg>
                                ) : (
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                                    </svg>
                                )}
                            </button>
                            <button className="sidebar-logout" onClick={logout} title="Sign out">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                                    <polyline points="16 17 21 12 16 7" />
                                    <line x1="21" y1="12" x2="9" y2="12" />
                                </svg>
                            </button>
                        </div>
                    </div>
                )}
                <div className="status-indicator">
                    <span className="status-dot online"></span>
                    <span>System Online</span>
                </div>
            </div>
        </aside>
    )
}

export default Sidebar
