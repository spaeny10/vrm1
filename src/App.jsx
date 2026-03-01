import { Routes, Route } from 'react-router-dom'
import { useAuth } from './components/AuthProvider'
import Sidebar from './components/Sidebar'
import ErrorBoundary from './components/ErrorBoundary'
import LoginPage from './pages/LoginPage'
import FleetOverview from './pages/FleetOverview'
import JobSiteDetail from './pages/JobSiteDetail'
import TrailerDetail from './pages/TrailerDetail'
import MapView from './pages/MapView'
import EnergyPage from './pages/EnergyPage'
import NetworkPage from './pages/NetworkPage'
import MaintenancePage from './pages/MaintenancePage'
import AnalyticsPage from './pages/AnalyticsPage'
import Settings from './pages/Settings'
import MyWorkPage from './pages/MyWorkPage'
import NotFound from './pages/NotFound'

function App() {
    const { user, loading } = useAuth()

    if (loading) {
        return (
            <div className="login-page">
                <div className="login-card" style={{ textAlign: 'center', padding: '40px' }}>
                    <div className="login-logo">VRM</div>
                    <p style={{ color: 'var(--text-secondary)', marginTop: '16px' }}>Loading...</p>
                </div>
            </div>
        )
    }

    if (!user) {
        return <LoginPage />
    }

    return (
        <div className="app-layout">
            <Sidebar />
            <main className="main-content">
                <ErrorBoundary>
                    <Routes>
                        <Route path="/" element={<FleetOverview />} />
                        <Route path="/site/:id" element={<JobSiteDetail />} />
                        <Route path="/trailer/:id" element={<TrailerDetail />} />
                        <Route path="/map" element={<MapView />} />
                        <Route path="/energy" element={<EnergyPage />} />
                        <Route path="/network" element={<NetworkPage />} />
                        <Route path="/maintenance" element={<MaintenancePage />} />
                        <Route path="/analytics" element={<AnalyticsPage />} />
                        <Route path="/settings" element={<Settings />} />
                        <Route path="/my-work" element={<MyWorkPage />} />
                        <Route path="*" element={<NotFound />} />
                    </Routes>
                </ErrorBoundary>
            </main>
        </div>
    )
}

export default App
