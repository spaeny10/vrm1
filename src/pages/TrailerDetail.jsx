import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, TimeScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
} from 'chart.js'
import 'chartjs-adapter-date-fns'
import zoomPlugin from 'chartjs-plugin-zoom'
import { Line, Bar } from 'react-chartjs-2'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchDiagnostics, fetchAlarms, fetchSystemOverview, fetchHistory, fetchFleetNetwork, fetchPepwaveHistory, fetchComponents, createComponent, updateComponent, fetchBatteryHealth, fetchTrailerIntelligence, analyzeTrailer } from '../api/vrm'
import KpiCard from '../components/KpiCard'
import GaugeChart from '../components/GaugeChart'
import AlarmBadge from '../components/AlarmBadge'
import ComponentForm from '../components/ComponentForm'
import DataFreshness from '../components/DataFreshness'
import Breadcrumbs from '../components/Breadcrumbs'
import SignalBars from '../components/SignalBars'
import { signalQuality, formatUptime, formatMB } from '../utils/format'

ChartJS.register(
    CategoryScale, LinearScale, TimeScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler, zoomPlugin
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

function TrailerDetail() {
    const { id } = useParams()
    const navigate = useNavigate()
    const [range, setRange] = useState('24h')
    const [historyData, setHistoryData] = useState([])
    const [pepwaveHistoryData, setPepwaveHistoryData] = useState([])
    const [showComponentForm, setShowComponentForm] = useState(false)
    const [editingComponent, setEditingComponent] = useState(null)

    const socChartRef = useRef(null)
    const voltageChartRef = useRef(null)
    const solarChartRef = useRef(null)
    const rsrpChartRef = useRef(null)
    const usageChartRef = useRef(null)

    const fetchDiagFn = useCallback(() => fetchDiagnostics(id), [id])
    const fetchAlarmsFn = useCallback(() => fetchAlarms(id), [id])
    const fetchSystemFn = useCallback(() => fetchSystemOverview(id), [id])
    const fetchNetworkFn = useCallback(() => fetchFleetNetwork(), [])

    const fetchComponentsFn = useCallback(() => fetchComponents(id), [id])
    const fetchBatteryHealthFn = useCallback(() => fetchBatteryHealth(id), [id])

    const { data: diagData, lastUpdated, refetch } = useApiPolling(fetchDiagFn, 30000)
    const { data: alarmsData } = useApiPolling(fetchAlarmsFn, 60000)
    const { data: systemData } = useApiPolling(fetchSystemFn, 120000)
    const { data: networkData } = useApiPolling(fetchNetworkFn, 60000)
    const { data: componentsData, refetch: refetchComponents } = useApiPolling(fetchComponentsFn, 120000)
    const { data: batteryHealthData } = useApiPolling(fetchBatteryHealthFn, 300000)

    const fetchIntelFn = useCallback(() => fetchTrailerIntelligence(id), [id])
    const { data: intelligenceData } = useApiPolling(fetchIntelFn, 60000)

    const [analysisResult, setAnalysisResult] = useState(null)
    const [analysisLoading, setAnalysisLoading] = useState(false)
    const [analysisError, setAnalysisError] = useState(null)

    const handleAnalyze = async () => {
        setAnalysisLoading(true)
        setAnalysisError(null)
        try {
            const result = await analyzeTrailer(id)
            setAnalysisResult(result)
        } catch (err) {
            setAnalysisError(err.message)
        } finally {
            setAnalysisLoading(false)
        }
    }

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

    // Chart data — use {x: timestamp, y: value} for time scale
    const toTimePoints = (arr, field) =>
        arr.map(h => ({ x: Number(h.timestamp), y: h[field] })).filter(p => p.y != null)

    const socChartData = useMemo(() => {
        if (!historyData.length) return null
        return {
            datasets: [{
                label: 'SOC %',
                data: toTimePoints(historyData, 'battery_soc'),
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
            datasets: [{
                label: 'Voltage (V)',
                data: toTimePoints(historyData, 'battery_voltage'),
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
            datasets: [{
                label: 'Solar (W)',
                data: toTimePoints(historyData, 'solar_watts'),
                backgroundColor: 'rgba(241, 196, 15, 0.7)',
                borderColor: '#f1c40f', borderWidth: 1,
            }],
        }
    }, [historyData])

    // Pepwave signal history chart
    const rsrpChartData = useMemo(() => {
        if (!pepwaveHistoryData.length) return null
        return {
            datasets: [{
                label: 'RSRP (dBm)',
                data: toTimePoints(pepwaveHistoryData, 'rsrp'),
                borderColor: '#9b59b6',
                backgroundColor: 'rgba(155, 89, 182, 0.1)',
                fill: true, tension: 0.3,
                pointRadius: range === '24h' ? 2 : 0,
            }, {
                label: 'SINR (dB)',
                data: toTimePoints(pepwaveHistoryData, 'sinr'),
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
            datasets: [{
                label: 'Cumulative Usage (MB)',
                data: toTimePoints(pepwaveHistoryData, 'usage_mb'),
                borderColor: '#e67e22',
                backgroundColor: 'rgba(230, 126, 34, 0.1)',
                fill: true, tension: 0.3,
                pointRadius: range === '24h' ? 2 : 0,
            }],
        }
    }, [pepwaveHistoryData, range])

    const chartOptions = {
        responsive: true, maintainAspectRatio: false,
        interaction: {
            mode: 'nearest',
            axis: 'x',
            intersect: false,
        },
        plugins: {
            legend: { labels: { color: '#bdc3c7', font: { family: 'Inter' } } },
            tooltip: {
                mode: 'nearest',
                intersect: false,
                callbacks: {
                    title: (items) => {
                        if (!items.length) return ''
                        const ts = items[0].parsed.x
                        return new Date(ts).toLocaleString([], {
                            month: 'short', day: 'numeric',
                            hour: '2-digit', minute: '2-digit', second: '2-digit',
                        })
                    },
                },
            },
            zoom: {
                zoom: {
                    wheel: { enabled: true },
                    pinch: { enabled: true },
                    mode: 'x',
                },
                pan: {
                    enabled: true,
                    mode: 'x',
                },
            },
        },
        scales: {
            x: {
                type: 'time',
                time: {
                    displayFormats: {
                        minute: 'HH:mm',
                        hour: 'MMM d, HH:mm',
                        day: 'MMM d',
                        week: 'MMM d',
                    },
                },
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
                <Breadcrumbs items={[{ label: 'Fleet', to: '/' }, { label: siteName || `Site #${id}` }]} />
                <div className="page-header-row">
                    <h1>{siteName || `Site #${id}`}</h1>
                    <DataFreshness lastUpdated={lastUpdated} refetch={refetch} />
                </div>
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
                        {solar.yieldToday !== null && solar.yieldYesterday !== null && solar.yieldYesterday > 0 && (() => {
                            const pct = ((solar.yieldToday - solar.yieldYesterday) / solar.yieldYesterday * 100).toFixed(0)
                            const maxVal = Math.max(solar.yieldToday, solar.yieldYesterday, 0.01)
                            return (
                                <div className="yield-comparison">
                                    <div className="yield-bar-row">
                                        <span className="yield-bar-label">Today</span>
                                        <div className="yield-bar-track">
                                            <div className="yield-bar yield-bar-today" style={{ width: `${(solar.yieldToday / maxVal) * 100}%` }} />
                                        </div>
                                    </div>
                                    <div className="yield-bar-row">
                                        <span className="yield-bar-label">Yest.</span>
                                        <div className="yield-bar-track">
                                            <div className="yield-bar yield-bar-yesterday" style={{ width: `${(solar.yieldYesterday / maxVal) * 100}%` }} />
                                        </div>
                                    </div>
                                    <span className={`yield-diff-badge ${Number(pct) >= 0 ? 'yield-up' : 'yield-down'}`}>
                                        {Number(pct) >= 0 ? '+' : ''}{pct}%
                                    </span>
                                </div>
                            )
                        })()}
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
                    <div className="chart-card-header">
                        <h3>Battery SOC</h3>
                        {socChartData && <button className="reset-zoom-btn" onClick={() => socChartRef.current?.resetZoom()}>Reset Zoom</button>}
                    </div>
                    <div className="chart-container">
                        {socChartData ? (
                            <Line ref={socChartRef} data={socChartData} options={{
                                ...chartOptions,
                                scales: { ...chartOptions.scales, y: { ...chartOptions.scales.y, min: 0, max: 100 } },
                            }} />
                        ) : (
                            <div className="chart-empty">No history data yet. Data builds up over time.</div>
                        )}
                    </div>
                </div>
                <div className="chart-card">
                    <div className="chart-card-header">
                        <h3>Battery Voltage</h3>
                        {voltageChartData && <button className="reset-zoom-btn" onClick={() => voltageChartRef.current?.resetZoom()}>Reset Zoom</button>}
                    </div>
                    <div className="chart-container">
                        {voltageChartData ? (
                            <Line ref={voltageChartRef} data={voltageChartData} options={chartOptions} />
                        ) : (
                            <div className="chart-empty">No history data yet.</div>
                        )}
                    </div>
                </div>
                <div className="chart-card chart-card-full">
                    <div className="chart-card-header">
                        <h3>Solar Production</h3>
                        {solarChartData && <button className="reset-zoom-btn" onClick={() => solarChartRef.current?.resetZoom()}>Reset Zoom</button>}
                    </div>
                    <div className="chart-container">
                        {solarChartData ? (
                            <Bar ref={solarChartRef} data={solarChartData} options={chartOptions} />
                        ) : (
                            <div className="chart-empty">No history data yet.</div>
                        )}
                    </div>
                </div>
            </div>

            {/* Battery Health Prediction */}
            {batteryHealthData && batteryHealthData.trend && batteryHealthData.trend !== 'insufficient_data' && (
                <div className="detail-section">
                    <h2>Battery Health Trend</h2>
                    <div className="battery-health-card">
                        <div className="battery-health-indicator">
                            <span className={`battery-trend-badge trend-${batteryHealthData.trend}`}>
                                {batteryHealthData.trend === 'improving' ? '↑' : batteryHealthData.trend === 'declining' ? '↓' : '→'}
                                {' '}{batteryHealthData.trend.charAt(0).toUpperCase() + batteryHealthData.trend.slice(1)}
                            </span>
                            <span className="battery-health-detail">
                                {batteryHealthData.avg_daily_change > 0 ? '+' : ''}{batteryHealthData.avg_daily_change}% / day
                            </span>
                            {batteryHealthData.days_until_critical && (
                                <span className="battery-critical-warning">
                                    ~{batteryHealthData.days_until_critical} days until critical (20%)
                                </span>
                            )}
                        </div>
                        {batteryHealthData.data_points?.length > 0 && (
                            <div className="battery-health-sparkline">
                                <svg viewBox={`0 0 ${batteryHealthData.data_points.length * 8} 40`} className="sparkline-svg">
                                    <polyline
                                        fill="none"
                                        stroke={batteryHealthData.trend === 'declining' ? '#e74c3c' : batteryHealthData.trend === 'improving' ? '#2ecc71' : '#3498db'}
                                        strokeWidth="2"
                                        points={batteryHealthData.data_points.map((p, i) => `${i * 8},${40 - (p.min_soc ?? p.avg_soc ?? 0) * 0.4}`).join(' ')}
                                    />
                                </svg>
                                <span className="sparkline-label">30-day min SOC trend</span>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* System Intelligence */}
            {intelligenceData?.intelligence && (() => {
                const intel = intelligenceData.intelligence
                return (
                    <div className="detail-section">
                        <div className="detail-section-header">
                            <h2>System Intelligence</h2>
                            <span className="intel-specs-badge">
                                {intel.specs.solar_capacity_w}W Solar / {(intel.specs.battery_capacity_wh / 1000).toFixed(1)} kWh Battery
                            </span>
                        </div>

                        <div className="intel-metrics-grid">
                            <div className="intel-metric-card">
                                <div className="intel-metric-header">
                                    <span className="intel-metric-title">Solar Score</span>
                                </div>
                                <div className={`intel-metric-value ${
                                    intel.solar.score !== null
                                        ? (intel.solar.score >= 90 ? 'intel-good' : intel.solar.score >= 50 ? 'intel-warning' : 'intel-critical')
                                        : ''
                                }`}>
                                    {intel.solar.score !== null ? intel.solar.score : '--'}
                                    {intel.solar.score !== null && <span className="intel-metric-unit">%</span>}
                                </div>
                                <div className="intel-metric-detail">
                                    {intel.solar.score_label && <span className={`intel-score-badge score-${intel.solar.score_label.toLowerCase()}`}>{intel.solar.score_label}</span>}
                                </div>
                                {intel.solar.avg_7d_score !== null && (
                                    <div className="intel-metric-secondary">7-day avg: {intel.solar.avg_7d_score}%</div>
                                )}
                            </div>

                            <div className="intel-metric-card">
                                <div className="intel-metric-header">
                                    <span className="intel-metric-title">Panel Output</span>
                                </div>
                                <div className="intel-metric-value">
                                    {intel.solar.panel_performance_pct !== null ? intel.solar.panel_performance_pct : '--'}
                                    {intel.solar.panel_performance_pct !== null && <span className="intel-metric-unit">%</span>}
                                </div>
                                <div className="intel-metric-detail">
                                    {intel.solar.current_watts !== null && <span>{Math.round(intel.solar.current_watts)}W of {intel.specs.solar_capacity_w}W rated</span>}
                                </div>
                            </div>

                            <div className="intel-metric-card">
                                <div className="intel-metric-header">
                                    <span className="intel-metric-title">Days of Autonomy</span>
                                </div>
                                <div className={`intel-metric-value ${
                                    intel.battery.days_of_autonomy !== null
                                        ? (intel.battery.days_of_autonomy < 1 ? 'intel-critical' : intel.battery.days_of_autonomy < 2 ? 'intel-warning' : 'intel-good')
                                        : ''
                                }`}>
                                    {intel.battery.days_of_autonomy !== null ? intel.battery.days_of_autonomy : '--'}
                                    {intel.battery.days_of_autonomy !== null && <span className="intel-metric-unit">days</span>}
                                </div>
                                <div className="intel-metric-detail">
                                    {intel.battery.stored_wh !== null && intel.energy.avg_daily_consumption_wh !== null && (
                                        <span>{intel.battery.stored_wh}Wh / {intel.energy.avg_daily_consumption_wh}Wh per day</span>
                                    )}
                                </div>
                            </div>

                            <div className="intel-metric-card">
                                <div className="intel-metric-header">
                                    <span className="intel-metric-title">Time to Full</span>
                                </div>
                                <div className="intel-metric-value">
                                    {intel.battery.charge_time_hours !== null ? intel.battery.charge_time_hours : '--'}
                                    {intel.battery.charge_time_hours !== null && <span className="intel-metric-unit">hrs</span>}
                                </div>
                                <div className="intel-metric-detail">
                                    {intel.battery.remaining_to_full_wh !== null && (
                                        <span>{intel.battery.remaining_to_full_wh}Wh remaining</span>
                                    )}
                                </div>
                            </div>

                            <div className="intel-metric-card">
                                <div className="intel-metric-header">
                                    <span className="intel-metric-title">Yield Today</span>
                                </div>
                                <div className="intel-metric-value">
                                    {intel.solar.yield_today_wh !== null ? Math.round(intel.solar.yield_today_wh) : '--'}
                                    <span className="intel-metric-unit">Wh</span>
                                </div>
                                <div className="intel-metric-detail">
                                    <span>of {intel.location.expected_daily_yield_wh}Wh expected</span>
                                </div>
                            </div>
                        </div>

                        {/* Weather context */}
                        {intel.location.data_source !== 'default' && (
                            <div className="intel-weather-context">
                                PSH: {intel.location.peak_sun_hours}h
                                {intel.location.cloud_cover_pct !== null && <> | Cloud cover: {intel.location.cloud_cover_pct}%</>}
                                {intel.location.sunshine_hours !== null && <> | Sunshine: {intel.location.sunshine_hours}h</>}
                                <span className="intel-source-tag">{intel.location.data_source === 'open-meteo' ? 'Open-Meteo' : 'Astronomical'}</span>
                            </div>
                        )}

                        {/* Energy Balance Bar */}
                        {intel.energy.today_yield_wh !== null && intel.energy.today_consumed_wh !== null && (
                            <div className="intel-energy-balance">
                                <div className="intel-balance-header">
                                    <span>Today's Energy Balance</span>
                                    <span className={intel.energy.today_balance_wh >= 0 ? 'positive' : 'negative'}>
                                        {intel.energy.today_balance_wh >= 0 ? '+' : ''}{intel.energy.today_balance_wh}Wh
                                    </span>
                                </div>
                                <div className="intel-balance-bars">
                                    <div className="intel-bar-row">
                                        <span className="intel-bar-label">Yield</span>
                                        <div className="intel-bar-track">
                                            <div className="intel-bar intel-bar-yield"
                                                style={{ width: `${Math.min(100, (intel.energy.today_yield_wh / intel.location.expected_daily_yield_wh) * 100)}%` }} />
                                        </div>
                                        <span className="intel-bar-value">{intel.energy.today_yield_wh}</span>
                                    </div>
                                    <div className="intel-bar-row">
                                        <span className="intel-bar-label">Used</span>
                                        <div className="intel-bar-track">
                                            <div className="intel-bar intel-bar-consumed"
                                                style={{ width: `${Math.min(100, (intel.energy.today_consumed_wh / intel.location.expected_daily_yield_wh) * 100)}%` }} />
                                        </div>
                                        <span className="intel-bar-value">{intel.energy.today_consumed_wh}</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* AI Analysis */}
                        <div className="intel-analysis-section">
                            <button
                                className="btn btn-primary intel-analyze-btn"
                                onClick={handleAnalyze}
                                disabled={analysisLoading}
                            >
                                {analysisLoading ? 'Analyzing...' : 'AI Analysis'}
                            </button>
                            {analysisError && <div className="intel-analysis-error">{analysisError}</div>}
                            {analysisResult && (
                                <div className="intel-analysis-result">
                                    <div className="intel-analysis-header">
                                        <span>AI Analysis</span>
                                        <span className="intel-analysis-time">{new Date(analysisResult.generated_at).toLocaleTimeString()}</span>
                                    </div>
                                    <pre className="intel-analysis-text">{analysisResult.analysis}</pre>
                                </div>
                            )}
                        </div>
                    </div>
                )
            })()}

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
                        <div className="chart-card-header">
                            <h3>Signal Strength</h3>
                            {rsrpChartData && <button className="reset-zoom-btn" onClick={() => rsrpChartRef.current?.resetZoom()}>Reset Zoom</button>}
                        </div>
                        <div className="chart-container">
                            {rsrpChartData ? (
                                <Line ref={rsrpChartRef} data={rsrpChartData} options={{
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
                        <div className="chart-card-header">
                            <h3>Data Usage</h3>
                            {usageChartData && <button className="reset-zoom-btn" onClick={() => usageChartRef.current?.resetZoom()}>Reset Zoom</button>}
                        </div>
                        <div className="chart-container">
                            {usageChartData ? (
                                <Line ref={usageChartRef} data={usageChartData} options={chartOptions} />
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
