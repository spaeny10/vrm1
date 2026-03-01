import { useState, useCallback } from 'react'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchFleetAlerts } from '../api/vrm'
import EnergyPage from './EnergyPage'
import NetworkPage from './NetworkPage'
import AnalyticsPage from './AnalyticsPage'

const TABS = [
    { key: 'energy', label: 'Energy', icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' },
    { key: 'network', label: 'Network', icon: 'M2 20h20M5 17a9 9 0 0 1 14 0M8 14a5.5 5.5 0 0 1 8 0' },
    { key: 'intelligence', label: 'Intelligence', icon: 'M18 20V10M12 20V4M6 20v-6' },
]

export default function FleetDetailsPage() {
    const [activeTab, setActiveTab] = useState('energy')

    // Alert count for the Energy tab badge
    const fetchAlertsFn = useCallback(() => fetchFleetAlerts(), [])
    const { data: alertsData } = useApiPolling(fetchAlertsFn, 60000)
    const alertCount = alertsData?.alerts?.length || 0

    return (
        <div className="fleet-details-page">
            <div className="page-header">
                <h1>Fleet Details</h1>
                <p className="page-subtitle">Energy analysis, network status, and fleet intelligence</p>
            </div>

            <div className="fleet-details-tabs">
                {TABS.map(tab => (
                    <button
                        key={tab.key}
                        className={`fleet-tab ${activeTab === tab.key ? 'active' : ''}`}
                        onClick={() => setActiveTab(tab.key)}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d={tab.icon} />
                            {tab.key === 'network' && <circle cx="12" cy="20" r="1" fill="currentColor" />}
                        </svg>
                        <span>{tab.label}</span>
                        {tab.key === 'energy' && alertCount > 0 && (
                            <span className="fleet-tab-badge">{alertCount}</span>
                        )}
                    </button>
                ))}
            </div>

            <div className="fleet-details-content">
                {activeTab === 'energy' && <EnergyPage embedded />}
                {activeTab === 'network' && <NetworkPage embedded />}
                {activeTab === 'intelligence' && <AnalyticsPage embedded />}
            </div>
        </div>
    )
}
