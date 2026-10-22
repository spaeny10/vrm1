import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { lazy, Suspense, useState, useEffect } from 'react'
import { useAuth } from './components/AuthProvider'
import { WorkspaceProvider, useWorkspace } from './components/WorkspaceProvider'
import Nav from './components/Nav'
import ThemeToggle from './components/ThemeToggle'
import ErrorBoundary from './components/ErrorBoundary'
import LoginPage from './pages/LoginPage'
import ForcePasswordChangePage from './pages/ForcePasswordChangePage'
import { Icon, Loading } from './ui'

const FleetHome = lazy(() => import('./pages/FleetHome'))
const BillingHome = lazy(() => import('./pages/BillingHome'))
const TechHome = lazy(() => import('./pages/TechHome'))
const TrailersPage = lazy(() => import('./pages/TrailersPage'))
const TrailerDetail = lazy(() => import('./pages/TrailerDetail'))
const SitesPage = lazy(() => import('./pages/SitesPage'))
const SiteDetail = lazy(() => import('./pages/SiteDetail'))
const MaintenancePage = lazy(() => import('./pages/MaintenancePage'))
const MapView = lazy(() => import('./pages/MapView'))
const RentalsPage = lazy(() => import('./pages/RentalsPage'))
const StatementsPage = lazy(() => import('./pages/StatementsPage'))
const CustomersPage = lazy(() => import('./pages/CustomersPage'))
const InsightsPage = lazy(() => import('./pages/InsightsPage'))
const Settings = lazy(() => import('./pages/Settings'))
const HelpPage = lazy(() => import('./pages/HelpPage'))
const PortalDashboard = lazy(() => import('./pages/PortalDashboard'))
const PortalSiteDetail = lazy(() => import('./pages/PortalSiteDetail'))
const NotFound = lazy(() => import('./pages/NotFound'))

function ScrollToTop() {
    const { pathname } = useLocation()
    useEffect(() => { window.scrollTo(0, 0) }, [pathname])
    return null
}

// Home means a different page per workspace
function WorkspaceHome() {
    const { workspace } = useWorkspace()
    if (workspace === 'billing') return <BillingHome />
    if (workspace === 'tech') return <TechHome />
    return <FleetHome />
}

function Shell({ children, nav }) {
    const [navOpen, setNavOpen] = useState(false)
    return (
        <div className="shell">
            {nav(navOpen, () => setNavOpen(false))}
            <main className="shell-main">
                <div className="topbar">
                    <button className="icon-btn" onClick={() => setNavOpen(true)} aria-label="Open menu"><Icon name="menu" /></button>
                    <img src="/logo.webp" alt="BIGView" />
                </div>
                <div className="shell-content">
                    <ScrollToTop />
                    <ErrorBoundary>
                        <Suspense fallback={<Loading />}>{children}</Suspense>
                    </ErrorBoundary>
                </div>
            </main>
        </div>
    )
}

export default function App() {
    const { user, loading } = useAuth()

    if (loading) return <div className="auth"><Loading /></div>
    if (!user) return <LoginPage />
    if (user.must_change_password) return <ForcePasswordChangePage />

    if (user.role === 'customer') {
        return (
            <Shell nav={(open, close) => <PortalNav open={open} onClose={close} />}>
                <Routes>
                    <Route path="/" element={<PortalDashboard />} />
                    <Route path="/site/:id" element={<PortalSiteDetail />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </Shell>
        )
    }

    return (
        <WorkspaceProvider>
            <Shell nav={(open, close) => <Nav open={open} onClose={close} />}>
                <Routes>
                    <Route path="/" element={<WorkspaceHome />} />
                    <Route path="/trailers" element={<TrailersPage />} />
                    <Route path="/trailer/:id" element={<TrailerDetail />} />
                    <Route path="/sites" element={<SitesPage />} />
                    <Route path="/site/:id" element={<SiteDetail />} />
                    <Route path="/maintenance" element={<MaintenancePage />} />
                    <Route path="/map" element={<MapView />} />
                    <Route path="/rentals" element={<RentalsPage />} />
                    <Route path="/statements" element={<StatementsPage />} />
                    <Route path="/customers" element={<CustomersPage />} />
                    <Route path="/insights" element={<InsightsPage />} />
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/help" element={<HelpPage />} />
                    {/* Old addresses that may be bookmarked or in emails */}
                    <Route path="/companies" element={<Navigate to="/customers" replace />} />
                    <Route path="/fleet" element={<Navigate to="/insights" replace />} />
                    <Route path="/health" element={<Navigate to="/trailers" replace />} />
                    <Route path="*" element={<NotFound />} />
                </Routes>
            </Shell>
        </WorkspaceProvider>
    )
}

function PortalNav({ open, onClose }) {
    const { user, logout } = useAuth()
    const location = useLocation()
    useEffect(() => { onClose?.() }, [location.pathname])
    return (
        <>
            {open && <div className="scrim" onClick={onClose} />}
            <aside className={`nav ${open ? 'open' : ''}`}>
                <div className="nav-brand"><img src="/logo.webp" alt="BIGView" /><span>OMNI</span></div>
                <nav className="nav-list">
                    <NavLink to="/" className={() => `nav-item ${location.pathname === '/' || location.pathname.startsWith('/site/') ? 'on' : ''}`}><Icon name="pin" />My sites</NavLink>
                </nav>
                <div className="nav-foot">
                    <div className="who"><b>{user?.display_name}</b><small>Customer</small></div>
                    <ThemeToggle />
                    <button className="icon-btn" onClick={logout} aria-label="Sign out" title="Sign out"><Icon name="logout" /></button>
                </div>
            </aside>
        </>
    )
}
