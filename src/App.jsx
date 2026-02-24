import { Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import FleetOverview from './pages/FleetOverview'
import SiteDetail from './pages/SiteDetail'
import EnergyPage from './pages/EnergyPage'
import NetworkPage from './pages/NetworkPage'
import Settings from './pages/Settings'

function App() {
    return (
        <div className="app-layout">
            <Sidebar />
            <main className="main-content">
                <Routes>
                    <Route path="/" element={<FleetOverview />} />
                    <Route path="/site/:id" element={<SiteDetail />} />
                    <Route path="/energy" element={<EnergyPage />} />
                    <Route path="/network" element={<NetworkPage />} />
                    <Route path="/settings" element={<Settings />} />
                </Routes>
            </main>
        </div>
    )
}

export default App
