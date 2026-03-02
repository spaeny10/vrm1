import { Routes, Route } from 'react-router-dom'
import { useAuth } from './components/AuthProvider'
import Sidebar from './components/Sidebar'
import PortalSidebar from './components/PortalSidebar'
import MobileHeader from './components/MobileHeader'
import ErrorBoundary from './components/ErrorBoundary'
import LoginPage from './pages/LoginPage'
import FleetOverview from './pages/FleetOverview'
import JobSiteDetail from './pages/JobSiteDetail'
import TrailerDetail from './pages/TrailerDetail'
import MapView from './pages/MapView'
import FleetDetailsPage from './pages/FleetDetailsPage'
import MaintenancePage from './pages/MaintenancePage'
import Settings from './pages/Settings'
import PortalDashboard from './pages/PortalDashboard'
import PortalSiteDetail from './pages/PortalSiteDetail'
import NotFound from './pages/NotFound'
import { useState } from 'react'

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

    // Customer portal: simplified layout
    if (user.role === 'customer') {
        return (
            <div className="app-layout">
                <MobileHeader onToggleSidebar={() => setMobileOpen(o => !o)} />
                <PortalSidebar className={mobileOpen ? 'sidebar-open' : ''} />
                {mobileOpen && <div className="sidebar-overlay visible" onClick={() => setMobileOpen(false)} />}
                <main className="main-content">
                    <ErrorBoundary>
                        <Routes>
                            <Route path="/" element={<PortalDashboard />} />
                            <Route path="/site/:id" element={<PortalSiteDetail />} />
                            <Route path="*" element={<PortalDashboard />} />
                        </Routes>
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
                <ErrorBoundary>
                    <Routes>
                        <Route path="/" element={<FleetOverview />} />
                        <Route path="/site/:id" element={<JobSiteDetail />} />
                        <Route path="/trailer/:id" element={<TrailerDetail />} />
                        <Route path="/map" element={<MapView />} />
                        <Route path="/fleet" element={<FleetDetailsPage />} />
                        <Route path="/maintenance" element={<MaintenancePage />} />
                        <Route path="/settings" element={<Settings />} />
                        <Route path="*" element={<NotFound />} />
                    </Routes>
                </ErrorBoundary>
            </main>
        </div>
    )
}

export default App
