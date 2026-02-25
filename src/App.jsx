import { Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import FleetOverview from './pages/FleetOverview'
import JobSiteDetail from './pages/JobSiteDetail'
import TrailerDetail from './pages/TrailerDetail'
import MapView from './pages/MapView'
import EnergyPage from './pages/EnergyPage'
import NetworkPage from './pages/NetworkPage'
import MaintenancePage from './pages/MaintenancePage'
import AnalyticsPage from './pages/AnalyticsPage'
import Settings from './pages/Settings'

function App() {
    return (
        <div className="app-layout">
            <Sidebar />
            <main className="main-content">
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
                </Routes>
            </main>
        </div>
    )
}

export default App
