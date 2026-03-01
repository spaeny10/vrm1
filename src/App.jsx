import { Routes, Route } from 'react-router-dom'
import { useAuth } from './components/AuthProvider'
import Sidebar from './components/Sidebar'
import ErrorBoundary from './components/ErrorBoundary'
import LoginPage from './pages/LoginPage'
import FleetOverview from './pages/FleetOverview'
import JobSiteDetail from './pages/JobSiteDetail'
import TrailerDetail from './pages/TrailerDetail'
import MapView from './pages/MapView'
import FleetDetailsPage from './pages/FleetDetailsPage'
import MaintenancePage from './pages/MaintenancePage'
import Settings from './pages/Settings'
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
