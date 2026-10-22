import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchNotifications, markNotifRead, markAllNotifsRead } from '../api/vrm'
import { useAuth } from './AuthProvider'
import { useWorkspace, WORKSPACES } from './WorkspaceProvider'
import { Icon } from '../ui'
import { fmtAgo } from '../ui/format'
import AskModal from './AskModal'
import ThemeToggle from './ThemeToggle'

// What each workspace's menu contains. Home means a different page per workspace.
const MENUS = {
    fleet: [
        { to: '/', label: 'Home', icon: 'home', end: true },
        { to: '/trailers', label: 'Trailers', icon: 'truck' },
        { to: '/sites', label: 'Sites', icon: 'pin' },
        { to: '/maintenance', label: 'Field service', icon: 'wrench' },
        { to: '/map', label: 'Map', icon: 'map' },
    ],
    billing: [
        { to: '/', label: 'Home', icon: 'home', end: true },
        { to: '/rentals', label: 'Rentals', icon: 'dollar' },
        { to: '/statements', label: 'Statements', icon: 'doc' },
        { to: '/customers', label: 'Customers', icon: 'building' },
    ],
    tech: [
        { to: '/', label: 'Home', icon: 'home', end: true },
        { to: '/trailers', label: 'Trailers', icon: 'truck' },
        { to: '/insights', label: 'Insights', icon: 'chart' },
        { to: '/map', label: 'Map', icon: 'map' },
    ],
}

export default function Nav({ open, onClose }) {
    const { user, logout } = useAuth()
    const { workspace, setWorkspace } = useWorkspace()
    const navigate = useNavigate()
    const location = useLocation()
    const [showNotifs, setShowNotifs] = useState(false)
    const [asking, setAsking] = useState(false)
    const notifRef = useRef(null)

    useEffect(() => { onClose?.() }, [location.pathname])

    useEffect(() => {
        if (!showNotifs) return
        const h = e => { if (notifRef.current && !notifRef.current.contains(e.target)) setShowNotifs(false) }
        document.addEventListener('mousedown', h)
        return () => document.removeEventListener('mousedown', h)
    }, [showNotifs])

    const fetchNotifs = useCallback(() => fetchNotifications(), [])
    const { data: notifData, refetch: refetchNotifs } = useApiPolling(fetchNotifs, 30000)
    const notifications = notifData?.notifications || []
    const unread = notifData?.unread_count || 0

    const switchTo = (key) => { setWorkspace(key); navigate('/') }
    const isAdmin = user?.role === 'admin'

    return (
        <>
            {open && <div className="scrim" onClick={onClose} />}
            <aside className={`nav ${open ? 'open' : ''}`}>
                <div className="nav-brand">
                    <img src="/logo.webp" alt="BIGView" />
                    <span>OMNI</span>
                </div>

                <div className="nav-ws" role="tablist" aria-label="Workspace">
                    {Object.values(WORKSPACES).map(ws => (
                        <button key={ws.key} className={workspace === ws.key ? 'on' : ''} onClick={() => switchTo(ws.key)} title={ws.description}>
                            {ws.label}
                        </button>
                    ))}
                </div>

                <nav className="nav-list">
                    {(MENUS[workspace] || MENUS.fleet).map(item => (
                        <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}>
                            <Icon name={item.icon} />{item.label}
                        </NavLink>
                    ))}

                    <div className="nav-label">Tools</div>
                    <button className="nav-item" style={{ width: '100%', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }} onClick={() => setAsking(true)}>
                        <Icon name="sparkle" />Ask the fleet
                    </button>
                    <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}>
                        <Icon name="gear" />{isAdmin ? 'Settings' : 'Account'}
                    </NavLink>
                    <NavLink to="/help" className={({ isActive }) => `nav-item ${isActive ? 'on' : ''}`}>
                        <Icon name="help" />Help
                    </NavLink>
                </nav>

                <div className="nav-foot">
                    <div className="who">
                        <b>{user?.display_name || user?.username}</b>
                        <small>{user?.role}</small>
                    </div>
                    <div ref={notifRef} style={{ position: 'relative' }}>
                        <button className="icon-btn" onClick={() => setShowNotifs(v => !v)} aria-label="Notifications" title="Notifications">
                            <Icon name="bell" />{unread > 0 && <span className="dot" />}
                        </button>
                        {showNotifs && (
                            <div className="card" style={{ position: 'absolute', bottom: 40, left: 0, width: 320, maxHeight: 420, overflow: 'auto', boxShadow: 'var(--shadow)', zIndex: 60 }}>
                                <div className="card-head">
                                    <h3>Notifications</h3>
                                    {unread > 0 && <button className="btn ghost sm" onClick={() => markAllNotifsRead().then(refetchNotifs)}>Mark all read</button>}
                                </div>
                                {notifications.length === 0 ? (
                                    <div className="empty compact">You're all caught up.</div>
                                ) : notifications.map(n => (
                                    <div key={n.id} className="list-row clickable" onClick={() => {
                                        if (!n.read) markNotifRead(n.id).then(refetchNotifs)
                                        if (n.link) navigate(n.link)
                                        setShowNotifs(false)
                                    }}>
                                        <span className={`dot ${n.read ? 'off' : 'info'}`} />
                                        <div className="main">
                                            <div className="title" style={{ fontWeight: n.read ? 500 : 600 }}>{n.title}</div>
                                            {n.body && <div className="desc">{n.body}</div>}
                                        </div>
                                        <div className="side">{fmtAgo(n.created_at)}</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    <ThemeToggle />
                    <button className="icon-btn" onClick={logout} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
                </div>
            </aside>
            {asking && <AskModal onClose={() => setAsking(false)} />}
        </>
    )
}
