import { Routes, Route, useLocation } from 'react-router-dom'
import { useAuth } from './components/AuthProvider'
import Sidebar from './components/Sidebar'
import PortalSidebar from './components/PortalSidebar'
import MobileHeader from './components/MobileHeader'
import ErrorBoundary from './components/ErrorBoundary'
import LoginPage from './pages/LoginPage'
import ForcePasswordChangePage from './pages/ForcePasswordChangePage'
import FleetOverview from './pages/FleetOverview'
import JobSiteDetail from './pages/JobSiteDetail'
import NotFound from './pages/NotFound'
import { lazy, Suspense, useState, useEffect } from 'react'

function ScrollToTop() {
    const { pathname } = useLocation()
    useEffect(() => { window.scrollTo(0, 0) }, [pathname])
    return null
}

// Lazy-load heavy pages (Chart.js, Leaflet, jsPDF, etc.)
const TrailerDetail = lazy(() => import('./pages/TrailerDetail'))
const MapView = lazy(() => import('./pages/MapView'))
const FleetDetailsPage = lazy(() => import('./pages/FleetDetailsPage'))
const MaintenancePage = lazy(() => import('./pages/MaintenancePage'))
const RentalsPage = lazy(() => import('./pages/RentalsPage'))
const Settings = lazy(() => import('./pages/Settings'))
const HelpPage = lazy(() => import('./pages/HelpPage'))
const PortalDashboard = lazy(() => import('./pages/PortalDashboard'))
const PortalSiteDetail = lazy(() => import('./pages/PortalSiteDetail'))
const Companies = lazy(() => import('./pages/Companies'))

function PageLoader() {
    return (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
            <p style={{ color: 'var(--text-secondary)' }}>Loading...</p>
        </div>
    )
}

function App() {
    const { user, loading } = useAuth()
    const [mobileOpen, setMobileOpen] = useState(false)

    if (loading) {
        return (
            <div className="login-page">
                <div className="login-card" style={{ textAlign: 'center', padding: '40px' }}>
                    <div className="login-logo-row">
                        <img src="/logo.webp" alt="BIGView" className="login-logo-img" />
                        <span className="login-omni">OMNI</span>
                    </div>
                    <p style={{ color: 'var(--text-secondary)', marginTop: '16px' }}>Loading...</p>
                </div>
            </div>
        )
    }

    if (!user) {
        return <LoginPage />
    }

    // Temporary-password accounts must rotate before touching anything
    if (user.must_change_password) {
        return <ForcePasswordChangePage />
    }

    // Customer portal: simplified layout
    if (user.role === 'customer') {
        return (
            <div className="app-layout">
                <MobileHeader onToggleSidebar={() => setMobileOpen(o => !o)} />
                <PortalSidebar className={mobileOpen ? 'sidebar-open' : ''} />
                {mobileOpen && <div className="sidebar-overlay visible" onClick={() => setMobileOpen(false)} />}
                <main className="main-content">
                    <ScrollToTop />
                    <ErrorBoundary>
                        <Suspense fallback={<PageLoader />}>
                            <Routes>
                                <Route path="/" element={<PortalDashboard />} />
                                <Route path="/site/:id" element={<PortalSiteDetail />} />
                                <Route path="*" element={<PortalDashboard />} />
                            </Routes>
                        </Suspense>
                    </ErrorBoundary>
                </main>
            </div>
        )
    }

    return (
        <div className="app-layout">
            <MobileHeader onToggleSidebar={() => setMobileOpen(o => !o)} />
            <Sidebar mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />
            {mobileOpen && <div className="sidebar-overlay visible" onClick={() => setMobileOpen(false)} />}
            <main className="main-content">
                <ScrollToTop />
                <ErrorBoundary>
                    <Suspense fallback={<PageLoader />}>
                        <Routes>
                            <Route path="/" element={<FleetOverview />} />
                            <Route path="/site/:id" element={<JobSiteDetail />} />
                            <Route path="/trailer/:id" element={<TrailerDetail />} />
                            <Route path="/map" element={<MapView />} />
                            <Route path="/fleet" element={<FleetDetailsPage />} />
                            <Route path="/maintenance" element={<MaintenancePage />} />
                            <Route path="/rentals" element={<RentalsPage />} />
                            <Route path="/companies" element={<Companies />} />
                            <Route path="/settings" element={<Settings />} />
                            <Route path="/help" element={<HelpPage />} />
                            <Route path="*" element={<NotFound />} />
                        </Routes>
                    </Suspense>
                </ErrorBoundary>
            </main>
        </div>
    )
}

export default App
