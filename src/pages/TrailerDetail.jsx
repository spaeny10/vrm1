import { useState, useCallback, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
} from 'chart.js'
import { Line, Bar } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchDiagnostics, fetchAlarms, fetchSystemOverview, fetchHistory, fetchFleetNetwork, fetchPepwaveHistory, fetchComponents, createComponent, updateComponent } from '../api/vrm'
import KpiCard from '../components/KpiCard'
import GaugeChart from '../components/GaugeChart'
import AlarmBadge from '../components/AlarmBadge'
import ComponentForm from '../components/ComponentForm'

ChartJS.register(
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
)

const RANGES = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
}

// Helper: extract value from VRM diagnostics records
function diagValue(records, code) {
    const match = records.find(r => r.code === code && r.Device !== 'Gateway');
    if (!match) return null;
    const val = match.rawValue;
    if (val === undefined || val === null || val === '') return null;
    const num = Number(val);
    return isNaN(num) ? val : num;
}

function diagFormatted(records, code) {
    const match = records.find(r => r.code === code && r.Device !== 'Gateway');
    return match?.formattedValue || null;
}

function formatUptime(seconds) {
    if (!seconds) return '—'
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    if (d > 0) return `${d}d ${h}h`
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h ${m}m`
}

function formatMB(mb) {
    if (!mb && mb !== 0) return '—'
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
    return `${Math.round(mb)} MB`
}

function signalQuality(rsrp) {
    if (rsrp === null || rsrp === undefined) return { label: 'Unknown', color: '#888' }
    if (rsrp >= -80) return { label: 'Excellent', color: '#2ecc71' }
    if (rsrp >= -90) return { label: 'Good', color: '#27ae60' }
    if (rsrp >= -100) return { label: 'Fair', color: '#f1c40f' }
    if (rsrp >= -110) return { label: 'Poor', color: '#e67e22' }
    return { label: 'Weak', color: '#e74c3c' }
}

function SignalBars({ bars, size = 28 }) {
    const maxBars = 5
    const barWidth = Math.floor(size / 7)
    const gap = 1
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            {Array.from({ length: maxBars }, (_, i) => {
                const h = ((i + 1) / maxBars) * (size - 2) + 2
                const x = i * (barWidth + gap)
                const y = size - h
                const active = i < (bars ?? 0)
                return (
                    <rect
                        key={i}
                        x={x}
                        y={y}
                        width={barWidth}
                        height={h}
                        rx={1}
                        fill={active
                            ? (bars >= 4 ? '#2ecc71' : bars >= 2 ? '#f1c40f' : '#e74c3c')
                            : 'rgba(255,255,255,0.08)'}
                    />
                )
            })}
        </svg>
    )
}

function TrailerDetail() {
    const { id } = useParams()
    const navigate = useNavigate()
    const [range, setRange] = useState('24h')
    const [historyData, setHistoryData] = useState([])
    const [pepwaveHistoryData, setPepwaveHistoryData] = useState([])
    const [showComponentForm, setShowComponentForm] = useState(false)
    const [editingComponent, setEditingComponent] = useState(null)

    const fetchDiagFn = useCallback(() => fetchDiagnostics(id), [id])
    const fetchAlarmsFn = useCallback(() => fetchAlarms(id), [id])
    const fetchSystemFn = useCallback(() => fetchSystemOverview(id), [id])
    const fetchNetworkFn = useCallback(() => fetchFleetNetwork(), [])

    const fetchComponentsFn = useCallback(() => fetchComponents(id), [id])

    const { data: diagData } = useApiPolling(fetchDiagFn, 30000)
    const { data: alarmsData } = useApiPolling(fetchAlarmsFn, 60000)
    const { data: systemData } = useApiPolling(fetchSystemFn, 120000)
    const { data: networkData } = useApiPolling(fetchNetworkFn, 60000)
    const { data: componentsData, refetch: refetchComponents } = useApiPolling(fetchComponentsFn, 120000)

    const components = componentsData?.components || []

    // Fetch local history based on range
    useEffect(() => {
        const end = Date.now()
        const start = end - RANGES[range]
        fetchHistory(id, start, end)
            .then(res => setHistoryData(res.records || []))
            .catch(() => setHistoryData([]))
    }, [id, range])

    // Parse diagnostics
    const records = diagData?.records || [];

    // Find matching Pepwave device by site name (MUST be before useEffect that uses it)
    // We need the site name — get it from the diagnostics data or system data
    const siteName = useMemo(() => {
        // Try to find name from various sources
        const sysName = systemData?.records?.name
        if (sysName) return sysName
        // Fallback: check if any record has a site name
        const diagRecord = records.find(r => r.idSiteName)
        return diagRecord?.idSiteName || null
    }, [systemData, records])

    const battery = useMemo(() => ({
        soc: diagValue(records, 'SOC') ?? diagValue(records, 'bs'),
        voltage: diagValue(records, 'V') ?? diagValue(records, 'bv'),
        current: diagValue(records, 'I') ?? diagValue(records, 'bc'),
        temp: diagValue(records, 'BT') ?? diagValue(records, 'bT'),
        power: diagValue(records, 'P'),
        consumed: diagValue(records, 'CE'),
        ttg: diagFormatted(records, 'TTG'),
        minCell: diagValue(records, 'mcV'),
        maxCell: diagValue(records, 'McV'),
    }), [records]);

    const solar = useMemo(() => ({
        watts: diagValue(records, 'ScW') ?? diagValue(records, 'Pdc'),
        voltage: diagValue(records, 'ScV') ?? diagValue(records, 'PVV'),
        yieldToday: diagValue(records, 'YT'),
        yieldYesterday: diagValue(records, 'YY'),
        chargeState: diagFormatted(records, 'ScS'),
        temp: diagValue(records, 'ScT'),
    }), [records]);

    // Fetch Pepwave history when device name is known
    useEffect(() => {
        if (!siteName) return
        const end = Date.now()
        const start = end - RANGES[range]
        fetchPepwaveHistory(siteName, start, end)
            .then(res => setPepwaveHistoryData(res.records || []))
            .catch(() => setPepwaveHistoryData([]))
    }, [siteName, range])

    const pepwaveDevice = useMemo(() => {
        if (!siteName || !networkData?.records) return null
        return networkData.records.find(d => d.name === siteName)
    }, [siteName, networkData])

    // Chart data
    const socChartData = useMemo(() => {
        if (!historyData.length) return null
        return {
            labels: historyData.map(h => {
                const d = new Date(h.timestamp)
                return range === '24h'
                    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
            }),
            datasets: [{
                label: 'SOC %',
                data: historyData.map(h => h.battery_soc),
                borderColor: '#2ecc71',
                backgroundColor: 'rgba(46, 204, 113, 0.1)',
                fill: true, tension: 0.3,
                pointRadius: range === '24h' ? 2 : 0,
            }],
        }
    }, [historyData, range])

    const voltageChartData = useMemo(() => {
        if (!historyData.length) return null
        return {
            labels: historyData.map(h => {
                const d = new Date(h.timestamp)
                return range === '24h'
                    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
            }),
            datasets: [{
                label: 'Voltage (V)',
                data: historyData.map(h => h.battery_voltage),
                borderColor: '#3498db',
                backgroundColor: 'rgba(52, 152, 219, 0.1)',
                fill: true, tension: 0.3,
                pointRadius: range === '24h' ? 2 : 0,
            }],
        }
    }, [historyData, range])

    const solarChartData = useMemo(() => {
        if (!historyData.length) return null
        return {
            labels: historyData.map(h => {
                const d = new Date(h.timestamp)
                return range === '24h'
                    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
            }),
            datasets: [{
                label: 'Solar (W)',
                data: historyData.map(h => h.solar_watts),
                backgroundColor: 'rgba(241, 196, 15, 0.7)',
                borderColor: '#f1c40f', borderWidth: 1,
            }],
        }
    }, [historyData, range])

    // Pepwave signal history chart
    const rsrpChartData = useMemo(() => {
        if (!pepwaveHistoryData.length) return null
        return {
            labels: pepwaveHistoryData.map(h => {
                const d = new Date(Number(h.timestamp))
                return range === '24h'
                    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
            }),
            datasets: [{
                label: 'RSRP (dBm)',
                data: pepwaveHistoryData.map(h => h.rsrp),
                borderColor: '#9b59b6',
                backgroundColor: 'rgba(155, 89, 182, 0.1)',
                fill: true, tension: 0.3,
                pointRadius: range === '24h' ? 2 : 0,
            }, {
                label: 'SINR (dB)',
                data: pepwaveHistoryData.map(h => h.sinr),
                borderColor: '#1abc9c',
                backgroundColor: 'rgba(26, 188, 156, 0.05)',
                fill: false, tension: 0.3,
                pointRadius: range === '24h' ? 2 : 0,
            }],
        }
    }, [pepwaveHistoryData, range])

    // Pepwave data usage chart
    const usageChartData = useMemo(() => {
        if (!pepwaveHistoryData.length) return null
        return {
            labels: pepwaveHistoryData.map(h => {
                const d = new Date(Number(h.timestamp))
                return range === '24h'
                    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
            }),
            datasets: [{
                label: 'Cumulative Usage (MB)',
                data: pepwaveHistoryData.map(h => h.usage_mb),
                borderColor: '#e67e22',
                backgroundColor: 'rgba(230, 126, 34, 0.1)',
                fill: true, tension: 0.3,
                pointRadius: range === '24h' ? 2 : 0,
            }],
        }
    }, [pepwaveHistoryData, range])

    const chartOptions = {
        responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: { labels: { color: '#bdc3c7', font: { family: 'Inter' } } },
        },
        scales: {
            x: {
                ticks: { color: '#7f8c8d', maxTicksLimit: 12, font: { family: 'Inter', size: 11 } },
                grid: { color: 'rgba(255,255,255,0.05)' },
            },
            y: {
                ticks: { color: '#7f8c8d', font: { family: 'Inter', size: 11 } },
                grid: { color: 'rgba(255,255,255,0.05)' },
            },
        },
    }

    const alarms = alarmsData?.records || []
    const devices = systemData?.records?.devices || []

    return (
        <div className="site-detail">
            <div className="page-header">
                <button className="back-btn" onClick={() => navigate('/')}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="15 18 9 12 15 6" />
                    </svg>
                    Back to Fleet
                </button>
                <h1>{siteName || `Site #${id}`}</h1>
            </div>

            {/* KPI Cards */}
            <div className="kpi-row">
                <KpiCard
                    title="Battery SOC"
                    value={battery.soc !== null ? Number(battery.soc).toFixed(1) : '—'}
                    unit="%" color={battery.soc > 60 ? 'green' : battery.soc > 30 ? 'yellow' : 'red'}
                    trend={battery.soc > 60 ? 'up' : battery.soc > 30 ? 'ok' : 'warning'}
                />
                <KpiCard
                    title="Battery Voltage"
                    value={battery.voltage !== null ? Number(battery.voltage).toFixed(1) : '—'}
                    unit="V" color="blue" trend="ok"
                />
                <KpiCard
                    title="Solar Power"
                    value={solar.watts !== null ? Math.round(solar.watts) : '—'}
                    unit="W" color="yellow" trend={solar.watts > 0 ? 'up' : 'ok'}
                />
                <KpiCard
                    title="Yield Today"
                    value={solar.yieldToday !== null ? Number(solar.yieldToday).toFixed(2) : '—'}
                    unit="kWh" color="teal" trend="up"
                />
            </div>

            {/* Gauges Row */}
            <div className="detail-gauges">
                <div className="detail-gauge-card">
                    <GaugeChart value={battery.soc ?? 0} max={100} label="SOC" size={140} thickness={12} />
                    <div className="gauge-details">
                        <div className="gauge-detail-row">
                            <span>Current</span>
                            <span>{battery.current !== null ? `${Number(battery.current).toFixed(1)}A` : '—'}</span>
                        </div>
                        <div className="gauge-detail-row">
                            <span>Temperature</span>
                            <span>{battery.temp !== null ? `${Number(battery.temp).toFixed(1)}°C` : '—'}</span>
                        </div>
                        <div className="gauge-detail-row">
                            <span>Time to Go</span>
                            <span>{battery.ttg || '—'}</span>
                        </div>
                        {battery.minCell !== null && (
                            <div className="gauge-detail-row">
                                <span>Cell Range</span>
                                <span>{Number(battery.minCell).toFixed(2)} - {Number(battery.maxCell).toFixed(2)}V</span>
                            </div>
                        )}
                    </div>
                </div>

                <div className="detail-gauge-card">
                    <div className="solar-status">
                        <div className="solar-icon-large">☀️</div>
                        <div className="solar-power-value">{solar.watts !== null ? `${Math.round(solar.watts)}W` : '—'}</div>
                        <div className="solar-state">{solar.chargeState || '—'}</div>
                    </div>
                    <div className="gauge-details">
                        <div className="gauge-detail-row">
                            <span>PV Voltage</span>
                            <span>{solar.voltage !== null ? `${Number(solar.voltage).toFixed(1)}V` : '—'}</span>
                        </div>
                        <div className="gauge-detail-row">
                            <span>Yield Today</span>
                            <span>{solar.yieldToday !== null ? `${Number(solar.yieldToday).toFixed(2)} kWh` : '—'}</span>
                        </div>
                        <div className="gauge-detail-row">
                            <span>Yield Yesterday</span>
                            <span>{solar.yieldYesterday !== null ? `${Number(solar.yieldYesterday).toFixed(2)} kWh` : '—'}</span>
                        </div>
                    </div>
                </div>

                {/* Network card — only shown when Pepwave data is available */}
                {pepwaveDevice && (
                    <div className="detail-gauge-card detail-network-card">
                        <div className="detail-net-hero">
                            <SignalBars bars={pepwaveDevice.cellular?.signal_bar} size={40} />
                            <div className="detail-net-hero-info">
                                <span className="detail-net-carrier">{pepwaveDevice.cellular?.carrier || '—'}</span>
                                <span className="detail-net-tech">{pepwaveDevice.cellular?.technology || ''}</span>
                            </div>
                            <span className={`detail-net-status-badge ${pepwaveDevice.online ? 'detail-net-online' : 'detail-net-offline'}`}>
                                {pepwaveDevice.online ? 'Online' : 'Offline'}
                            </span>
                        </div>
                        <div className="gauge-details">
                            {pepwaveDevice.cellular?.signal && (
                                <>
                                    <div className="gauge-detail-row">
                                        <span>RSRP</span>
                                        <span style={{ color: signalQuality(pepwaveDevice.cellular.signal.rsrp).color, fontWeight: 700 }}>
                                            {pepwaveDevice.cellular.signal.rsrp} dBm
                                        </span>
                                    </div>
                                    <div className="gauge-detail-row">
                                        <span>SINR</span>
                                        <span>{pepwaveDevice.cellular.signal.sinr} dB</span>
                                    </div>
                                </>
                            )}
                            <div className="gauge-detail-row">
                                <span>Clients</span>
                                <span>{pepwaveDevice.client_count}</span>
                            </div>
                            <div className="gauge-detail-row">
                                <span>Data</span>
                                <span>{formatMB(pepwaveDevice.usage_mb)}</span>
                            </div>
                            <div className="gauge-detail-row">
                                <span>Uptime</span>
                                <span>{formatUptime(pepwaveDevice.uptime)}</span>
                            </div>
                            <div className="gauge-detail-row">
                                <span>WAN IP</span>
                                <span className="mono">{pepwaveDevice.wan_ip || '—'}</span>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Range selector */}
            <div className="range-selector">
                <span className="range-label">History Range:</span>
                {Object.keys(RANGES).map(r => (
                    <button key={r} className={`range-btn ${range === r ? 'active' : ''}`}
                        onClick={() => setRange(r)}>{r}</button>
                ))}
            </div>

            {/* Charts */}
            <div className="charts-grid">
                <div className="chart-card">
                    <h3>Battery SOC</h3>
                    <div className="chart-container">
                        {socChartData ? (
                            <Line data={socChartData} options={{
                                ...chartOptions,
                                scales: { ...chartOptions.scales, y: { ...chartOptions.scales.y, min: 0, max: 100 } },
                            }} />
                        ) : (
                            <div className="chart-empty">No history data yet. Data builds up over time.</div>
                        )}
                    </div>
                </div>
                <div className="chart-card">
                    <h3>Battery Voltage</h3>
                    <div className="chart-container">
                        {voltageChartData ? (
                            <Line data={voltageChartData} options={chartOptions} />
                        ) : (
                            <div className="chart-empty">No history data yet.</div>
                        )}
                    </div>
                </div>
                <div className="chart-card chart-card-full">
                    <h3>Solar Production</h3>
                    <div className="chart-container">
                        {solarChartData ? (
                            <Bar data={solarChartData} options={chartOptions} />
                        ) : (
                            <div className="chart-empty">No history data yet.</div>
                        )}
                    </div>
                </div>
            </div>

            {/* Pepwave SIM + WAN section */}
            {pepwaveDevice && (
                <div className="detail-section">
                    <h2>📡 Network Details — {pepwaveDevice.model}</h2>
                    <div className="detail-net-grid">
                        {pepwaveDevice.cellular?.sims?.length > 0 && (
                            <div className="detail-net-block">
                                <h4>SIM Cards</h4>
                                {pepwaveDevice.cellular.sims.map(sim => (
                                    <div key={sim.id} className={`sim-card ${sim.active ? 'sim-active' : 'sim-inactive'}`}>
                                        <div className="sim-header">
                                            <span className="sim-label">SIM {sim.id}</span>
                                            <span className={`sim-status ${sim.active ? 'sim-status-active' : ''}`}>
                                                {sim.active ? '● Active' : '○ Standby'}
                                            </span>
                                        </div>
                                        <div className="sim-details">
                                            {sim.carrier && <span>📱 {sim.carrier}</span>}
                                            {sim.iccid && <span className="sim-iccid">ICCID: {sim.iccid}</span>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="detail-net-block">
                            <h4>WAN Interfaces</h4>
                            {pepwaveDevice.wan_interfaces?.map(iface => (
                                <div key={iface.id} className={`wan-iface wan-iface-${iface.status_led || 'gray'}`}>
                                    <span className="wan-name">{iface.name}</span>
                                    <span className="wan-type">{iface.type}</span>
                                    <span className="wan-status">{iface.message || iface.status}</span>
                                    {iface.ip && <span className="wan-ip">{iface.ip}</span>}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Pepwave History Charts */}
            {pepwaveDevice && (
                <div className="charts-grid">
                    <div className="chart-card">
                        <h3>📶 Signal Strength</h3>
                        <div className="chart-container">
                            {rsrpChartData ? (
                                <Line data={rsrpChartData} options={{
                                    ...chartOptions,
                                    scales: {
                                        ...chartOptions.scales,
                                        y: { ...chartOptions.scales.y, suggestedMin: -120, suggestedMax: -60 },
                                    },
                                }} />
                            ) : (
                                <div className="chart-empty">Signal history will build up as data is polled.</div>
                            )}
                        </div>
                    </div>
                    <div className="chart-card">
                        <h3>📊 Data Usage</h3>
                        <div className="chart-container">
                            {usageChartData ? (
                                <Line data={usageChartData} options={chartOptions} />
                            ) : (
                                <div className="chart-empty">Data usage history will build up as data is polled.</div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Alarms */}
            <div className="detail-section">
                <h2>Alarms & Notifications</h2>
                {alarms.length === 0 ? (
                    <div className="empty-state">No recent alarms</div>
                ) : (
                    <div className="alarm-list">
                        {alarms.slice(0, 20).map((alarm, i) => (
                            <div key={i} className="alarm-row">
                                <AlarmBadge level={alarm.type === 'alarm' ? 'alarm' : 'warning'} />
                                <span className="alarm-name">{alarm.name || alarm.description || 'Alarm'}</span>
                                <span className="alarm-device">{alarm.device || ''}</span>
                                <span className="alarm-time">
                                    {alarm.started ? new Date(alarm.started * 1000).toLocaleString() : ''}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* System Devices */}
            <div className="detail-section">
                <h2>Connected Devices</h2>
                {devices.length === 0 ? (
                    <div className="empty-state">No device information available</div>
                ) : (
                    <div className="devices-table-wrapper">
                        <table className="devices-table">
                            <thead>
                                <tr><th>Device</th><th>Product</th><th>Serial</th><th>Firmware</th></tr>
                            </thead>
                            <tbody>
                                {devices.map((device, i) => (
                                    <tr key={i}>
                                        <td>{device.customName || device.name}</td>
                                        <td>{device.productCode || '—'}</td>
                                        <td className="mono">{device.machineSerialNumber || '—'}</td>
                                        <td>{device.firmwareVersion || '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Component Inventory */}
            <div className="detail-section">
                <div className="detail-section-header">
                    <h2>Component Inventory</h2>
                    <button className="btn btn-primary btn-sm" onClick={() => { setEditingComponent(null); setShowComponentForm(true) }}>
                        + Add Component
                    </button>
                </div>
                {components.length === 0 ? (
                    <div className="empty-section">
                        <p>No components logged yet. Add components to track warranty and installation details.</p>
                    </div>
                ) : (
                    <div className="table-wrapper">
                        <table className="components-table">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Make</th>
                                    <th>Model</th>
                                    <th>Serial Number</th>
                                    <th>Installed</th>
                                    <th>Warranty Expiry</th>
                                    <th>Status</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {components.map(comp => {
                                    const typeLabel = { battery: 'Battery', solar_panel: 'Solar Panel', inverter: 'Inverter', charge_controller: 'Charge Controller', router: 'Router', camera: 'Camera' }[comp.component_type] || comp.component_type
                                    const fmtDate = (ts) => ts ? new Date(Number(ts)).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
                                    const warrantyExpired = comp.warranty_expiry && Number(comp.warranty_expiry) < Date.now()
                                    return (
                                        <tr key={comp.id} className="component-row">
                                            <td><span className="component-type-badge">{typeLabel}</span></td>
                                            <td>{comp.make || '—'}</td>
                                            <td>{comp.model || '—'}</td>
                                            <td className="mono">{comp.serial_number || '—'}</td>
                                            <td>{fmtDate(comp.installed_date)}</td>
                                            <td className={warrantyExpired ? 'warranty-expired' : ''}>{fmtDate(comp.warranty_expiry)}</td>
                                            <td><span className={`comp-status comp-status-${comp.status}`}>{comp.status}</span></td>
                                            <td>
                                                <button className="btn btn-ghost btn-sm" onClick={() => { setEditingComponent(comp); setShowComponentForm(true) }}>Edit</button>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {showComponentForm && (
                <ComponentForm
                    component={editingComponent}
                    siteId={parseInt(id)}
                    onSave={async (data) => {
                        if (editingComponent) {
                            await updateComponent(editingComponent.id, data)
                        } else {
                            await createComponent(data)
                        }
                        setShowComponentForm(false)
                        setEditingComponent(null)
                        refetchComponents()
                    }}
                    onClose={() => { setShowComponentForm(false); setEditingComponent(null) }}
                />
            )}
        </div>
    )
}

export default TrailerDetail
