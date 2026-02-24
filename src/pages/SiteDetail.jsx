import { useState, useCallback, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
} from 'chart.js'
import { Line, Bar } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchDiagnostics, fetchAlarms, fetchSystemOverview, fetchHistory } from '../api/vrm'
import KpiCard from '../components/KpiCard'
import GaugeChart from '../components/GaugeChart'
import AlarmBadge from '../components/AlarmBadge'

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

function SiteDetail() {
    const { id } = useParams()
    const navigate = useNavigate()
    const [range, setRange] = useState('24h')
    const [historyData, setHistoryData] = useState([])

    const fetchDiagFn = useCallback(() => fetchDiagnostics(id), [id])
    const fetchAlarmsFn = useCallback(() => fetchAlarms(id), [id])
    const fetchSystemFn = useCallback(() => fetchSystemOverview(id), [id])

    const { data: diagData } = useApiPolling(fetchDiagFn, 30000)
    const { data: alarmsData } = useApiPolling(fetchAlarmsFn, 60000)
    const { data: systemData } = useApiPolling(fetchSystemFn, 120000)

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

    // Chart data from local history
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
                <h1>Site #{id}</h1>
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
        </div>
    )
}

export default SiteDetail
