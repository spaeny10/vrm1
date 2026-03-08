import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

function StatusBadge({ status, size = 'medium' }) {
    const colors = {
        good: '#22c55e',
        watch: '#f59e0b',
        critical: '#ef4444'
    }
    const labels = {
        good: 'Good',
        watch: 'Watch',
        critical: 'Needs Attention'
    }
    return (
        <span className={`status-badge status-badge-${status} status-badge-${size}`}>
            <span className="status-dot" style={{ background: colors[status] }}></span>
            {labels[status]}
        </span>
    )
}

function SeverityBadge({ severity }) {
    const colors = {
        critical: '#ef4444',
        warning: '#f59e0b',
        caution: '#eab308'
    }
    return (
        <span className="severity-badge" style={{
            background: colors[severity],
            color: '#fff',
            padding: '4px 12px',
            borderRadius: '4px',
            fontSize: '12px',
            fontWeight: 600,
            textTransform: 'uppercase'
        }}>
            {severity}
        </span>
    )
}

function PriorityBadge({ priority }) {
    const colors = {
        1: '#ef4444',
        2: '#ef4444',
        3: '#f59e0b',
        4: '#eab308',
        5: '#eab308'
    }
    return (
        <span className="priority-badge" style={{
            background: colors[priority],
            color: '#fff',
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            fontWeight: 600
        }}>
            {priority}
        </span>
    )
}

function SolarScoreBadge({ score }) {
    let grade, color
    if (score >= 90) { grade = 'Excellent'; color = '#22c55e' }
    else if (score >= 70) { grade = 'Good'; color = '#eab308' }
    else if (score >= 50) { grade = 'Fair'; color = '#f59e0b' }
    else { grade = 'Poor'; color = '#ef4444' }

    return (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '24px', fontWeight: 700, color }}>{score}%</span>
            <span style={{
                background: color,
                color: '#fff',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: 600
            }}>
                {grade}
            </span>
        </div>
    )
}

function DeficitFlowchart() {
    return (
        <div className="help-diagram">
            <div className="flowchart">
                <div className="flow-node flow-start">
                    <div className="flow-content">Daily Deficit Detected<br/>(yield &lt; consumed)</div>
                </div>
                <div className="flow-arrow">↓</div>
                <div className="flow-node flow-decision">
                    <div className="flow-content">EOD SOC ≥88%?</div>
                </div>
                <div className="flow-split">
                    <div className="flow-branch">
                        <div className="flow-arrow-label">No</div>
                        <div className="flow-arrow">↓</div>
                        <div className="flow-node flow-result flow-critical">
                            <div className="flow-content">⚠️ Real Deficit<br/>Investigate</div>
                        </div>
                    </div>
                    <div className="flow-branch">
                        <div className="flow-arrow-label">Yes</div>
                        <div className="flow-arrow">↓</div>
                        <div className="flow-node flow-decision">
                            <div className="flow-content">MPPT Float/Storage?</div>
                        </div>
                        <div className="flow-split">
                            <div className="flow-branch">
                                <div className="flow-arrow-label">No</div>
                                <div className="flow-arrow">↓</div>
                                <div className="flow-node flow-result flow-critical">
                                    <div className="flow-content">⚠️ Real Deficit</div>
                                </div>
                            </div>
                            <div className="flow-branch">
                                <div className="flow-arrow-label">Yes</div>
                                <div className="flow-arrow">↓</div>
                                <div className="flow-node flow-decision">
                                    <div className="flow-content">Deficit &lt;1 kWh?</div>
                                </div>
                                <div className="flow-split">
                                    <div className="flow-branch">
                                        <div className="flow-arrow-label">No</div>
                                        <div className="flow-arrow">↓</div>
                                        <div className="flow-node flow-result flow-critical">
                                            <div className="flow-content">⚠️ Real Deficit</div>
                                        </div>
                                    </div>
                                    <div className="flow-branch">
                                        <div className="flow-arrow-label">Yes</div>
                                        <div className="flow-arrow">↓</div>
                                        <div className="flow-node flow-result flow-good">
                                            <div className="flow-content">🔋 Throttled<br/>No Action</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

function MpptStateChart() {
    const states = [
        { id: 0, name: 'Off', color: '#6b7280', desc: 'MPPT not charging' },
        { id: 1, name: 'Low Power', color: '#8b5cf6', desc: 'Minimal solar input' },
        { id: 2, name: 'Fault', color: '#ef4444', desc: 'Error condition' },
        { id: 3, name: 'Bulk', color: '#3b82f6', desc: 'Max charging (SOC <80%)' },
        { id: 4, name: 'Absorption', color: '#0ea5e9', desc: 'Constant voltage (80-95%)' },
        { id: 5, name: 'Float', color: '#22c55e', desc: 'Maintenance charge (>95%)' },
        { id: 6, name: 'Storage', color: '#10b981', desc: 'Long-term storage mode' },
        { id: 7, name: 'Equalize', color: '#f59e0b', desc: 'Cell balancing' },
    ]

    return (
        <div className="help-table">
            <table>
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>State</th>
                        <th>Description</th>
                        <th>Typical SOC</th>
                    </tr>
                </thead>
                <tbody>
                    {states.map(s => (
                        <tr key={s.id}>
                            <td><code>{s.id}</code></td>
                            <td>
                                <span style={{
                                    display: 'inline-block',
                                    padding: '4px 10px',
                                    borderRadius: '4px',
                                    background: s.color,
                                    color: '#fff',
                                    fontSize: '13px',
                                    fontWeight: 600
                                }}>
                                    {s.name}
                                </span>
                            </td>
                            <td>{s.desc}</td>
                            <td>
                                {s.id === 3 && '<80%'}
                                {s.id === 4 && '80-95%'}
                                {(s.id === 5 || s.id === 6) && '>95%'}
                                {(s.id !== 3 && s.id !== 4 && s.id !== 5 && s.id !== 6) && '—'}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function TechStatusTriggers() {
    return (
        <div className="help-table">
            <table>
                <thead>
                    <tr>
                        <th style={{ width: '180px' }}>Tech Status</th>
                        <th>Trigger Conditions</th>
                        <th style={{ width: '140px' }}>Action</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><StatusBadge status="critical" /></td>
                        <td>
                            <ul style={{ margin: 0, paddingLeft: '20px' }}>
                                <li>Battery SOC &lt;20%</li>
                                <li>Active VRM alarm/error</li>
                                <li>Energy deficit ≥5 real days</li>
                                <li>SOC declining, critical in &lt;3 days</li>
                                <li>Offline 24+ hours</li>
                            </ul>
                        </td>
                        <td><strong style={{ color: '#ef4444' }}>Dispatch Now</strong></td>
                    </tr>
                    <tr>
                        <td><StatusBadge status="watch" /></td>
                        <td>
                            <ul style={{ margin: 0, paddingLeft: '20px' }}>
                                <li>Battery SOC 20-40%</li>
                                <li>SOC declining &gt;2%/day</li>
                                <li>Energy deficit 2-4 real days</li>
                                <li>Offline &lt;24 hours</li>
                            </ul>
                        </td>
                        <td><strong style={{ color: '#f59e0b' }}>Monitor Today</strong></td>
                    </tr>
                    <tr>
                        <td><StatusBadge status="good" /></td>
                        <td>No critical or watch conditions met</td>
                        <td><strong style={{ color: '#22c55e' }}>Normal</strong></td>
                    </tr>
                </tbody>
            </table>
        </div>
    )
}

function PriorityLevels() {
    return (
        <div className="help-table">
            <table>
                <thead>
                    <tr>
                        <th style={{ width: '80px' }}>Priority</th>
                        <th style={{ width: '120px' }}>Urgency</th>
                        <th>Examples</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><PriorityBadge priority={1} /></td>
                        <td><strong style={{ color: '#ef4444' }}>Critical</strong></td>
                        <td>Energy deficit critical (≥5 days), critical SOC (&lt;20%)</td>
                    </tr>
                    <tr>
                        <td><PriorityBadge priority={2} /></td>
                        <td><strong style={{ color: '#ef4444' }}>High</strong></td>
                        <td>Battery temp critical, offline 24+ hours</td>
                    </tr>
                    <tr>
                        <td><PriorityBadge priority={3} /></td>
                        <td><strong style={{ color: '#f59e0b' }}>Medium</strong></td>
                        <td>Energy deficit warning (3-4 days), weak signal</td>
                    </tr>
                    <tr>
                        <td><PriorityBadge priority={4} /></td>
                        <td><strong style={{ color: '#eab308' }}>Low</strong></td>
                        <td>Solar underperforming, load high</td>
                    </tr>
                    <tr>
                        <td><PriorityBadge priority={5} /></td>
                        <td><strong style={{ color: '#eab308' }}>Info</strong></td>
                        <td>Network usage high, caution alerts</td>
                    </tr>
                </tbody>
            </table>
        </div>
    )
}

function DeficitExampleTable() {
    return (
        <div className="help-example">
            <h4>Example: Mixed Deficit Scenario</h4>
            <table className="deficit-example-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Yield</th>
                        <th>Consumed</th>
                        <th>Balance</th>
                        <th>EOD SOC</th>
                        <th>MPPT State</th>
                        <th>Classification</th>
                    </tr>
                </thead>
                <tbody>
                    <tr className="deficit-row-real">
                        <td>Mar 5</td>
                        <td>8.5 kWh</td>
                        <td>10.2 kWh</td>
                        <td className="negative">-1.7 kWh</td>
                        <td>72%</td>
                        <td><span className="mppt-badge mppt-bulk">Bulk</span></td>
                        <td><strong style={{ color: '#ef4444' }}>⚠️ Real Deficit</strong></td>
                    </tr>
                    <tr className="deficit-row-real">
                        <td>Mar 6</td>
                        <td>7.8 kWh</td>
                        <td>9.5 kWh</td>
                        <td className="negative">-1.7 kWh</td>
                        <td>65%</td>
                        <td><span className="mppt-badge mppt-bulk">Bulk</span></td>
                        <td><strong style={{ color: '#ef4444' }}>⚠️ Real Deficit</strong></td>
                    </tr>
                    <tr className="deficit-row-throttled">
                        <td>Mar 7</td>
                        <td>9.0 kWh</td>
                        <td>9.6 kWh</td>
                        <td className="negative">-0.6 kWh <span className="throttle-badge">🔋 Throttled</span></td>
                        <td>92%</td>
                        <td><span className="mppt-badge mppt-float">Float</span></td>
                        <td><strong style={{ color: '#22c55e' }}>✓ Throttled (No Action)</strong></td>
                    </tr>
                </tbody>
            </table>
            <p style={{ fontSize: '14px', color: 'var(--text-muted)', marginTop: '12px' }}>
                <strong>Result:</strong> Alert shows "2 Day Streak" (Mar 5-6 only). Mar 7 is throttled, so it breaks the streak.
            </p>
        </div>
    )
}

function HelpPage() {
    const [activeSection, setActiveSection] = useState('overview')
    const [searchQuery, setSearchQuery] = useState('')

    useEffect(() => {
        // Scroll to section if hash in URL
        const hash = window.location.hash.slice(1)
        if (hash) {
            setActiveSection(hash)
            setTimeout(() => {
                document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' })
            }, 100)
        }
    }, [])

    const sections = [
        { id: 'overview', title: 'System Overview', icon: '📊' },
        { id: 'tech-status', title: 'Tech Status System', icon: '🚦' },
        { id: 'deficit-detection', title: 'Energy Deficit Detection', icon: '⚡' },
        { id: 'solar-score', title: 'Solar Performance Score', icon: '☀️' },
        { id: 'alerts', title: 'Alerts & Notifications', icon: '🔔' },
        { id: 'action-queue', title: 'Action Queue', icon: '📋' },
        { id: 'pages', title: 'Where Data Appears', icon: '🗺️' },
        { id: 'digest', title: 'Morning Digest', icon: '📧' },
        { id: 'interpretation', title: 'How to Interpret Data', icon: '🔍' },
        { id: 'troubleshooting', title: 'Common Scenarios', icon: '🛠️' },
        { id: 'best-practices', title: 'Best Practices', icon: '✨' },
        { id: 'glossary', title: 'Glossary', icon: '📖' },
    ]

    return (
        <div className="help-page">
            <div className="help-header">
                <div className="help-header-content">
                    <h1>📚 Intelligence Analysis & Alerting Guide</h1>
                    <p className="help-subtitle">Complete documentation for technicians and management staff</p>
                    <div className="help-meta">
                        <span className="help-version">Version 1.0</span>
                        <span className="help-date">Last Updated: March 8, 2026</span>
                    </div>
                </div>
            </div>

            <div className="help-layout">
                <aside className="help-sidebar">
                    <div className="help-search">
                        <input
                            type="text"
                            placeholder="Search documentation..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="help-search-input"
                        />
                    </div>
                    <nav className="help-nav">
                        {sections.map(section => (
                            <a
                                key={section.id}
                                href={`#${section.id}`}
                                className={`help-nav-item ${activeSection === section.id ? 'active' : ''}`}
                                onClick={(e) => {
                                    e.preventDefault()
                                    setActiveSection(section.id)
                                    document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth' })
                                }}
                            >
                                <span className="help-nav-icon">{section.icon}</span>
                                <span className="help-nav-text">{section.title}</span>
                            </a>
                        ))}
                    </nav>
                    <div className="help-sidebar-footer">
                        <Link to="/settings" className="help-link">
                            ⚙️ Go to Settings
                        </Link>
                        <Link to="/" className="help-link">
                            🏠 Back to Dashboard
                        </Link>
                    </div>
                </aside>

                <main className="help-content">
                    {/* System Overview */}
                    <section id="overview" className="help-section">
                        <h2>📊 System Overview</h2>
                        <p>BIGView OMNI continuously monitors ~110 solar security trailers across ~53 construction job sites. The <strong>Intelligence Analysis & Alerting System</strong> automatically detects problems and prioritizes actions for field technicians.</p>

                        <div className="help-card">
                            <h3>Key Components</h3>
                            <div className="help-grid-3">
                                <div className="help-feature">
                                    <div className="help-feature-icon">🚦</div>
                                    <h4>Tech Status</h4>
                                    <p>3-state actionable status (Good/Watch/Needs Attention)</p>
                                </div>
                                <div className="help-feature">
                                    <div className="help-feature-icon">⚡</div>
                                    <h4>Energy Deficit Alerts</h4>
                                    <p>Detects multi-day solar shortages with smart filtering</p>
                                </div>
                                <div className="help-feature">
                                    <div className="help-feature-icon">☀️</div>
                                    <h4>Solar Score</h4>
                                    <p>Location-aware solar performance rating (0-100%)</p>
                                </div>
                                <div className="help-feature">
                                    <div className="help-feature-icon">📋</div>
                                    <h4>Action Queue</h4>
                                    <p>Priority-sorted task list on Dashboard</p>
                                </div>
                                <div className="help-feature">
                                    <div className="help-feature-icon">📧</div>
                                    <h4>Morning Digest</h4>
                                    <p>Daily email with yesterday's metrics + action items</p>
                                </div>
                                <div className="help-feature">
                                    <div className="help-feature-icon">📡</div>
                                    <h4>Real-time Monitoring</h4>
                                    <p>Battery SOC, solar power, DC load, network status</p>
                                </div>
                            </div>
                        </div>

                        <div className="help-info">
                            <strong>Data Sources:</strong> Victron VRM API (solar), Pepwave InControl2 (network), Open-Meteo Weather API (expected yield), PostgreSQL (historical data)
                        </div>
                    </section>

                    {/* Tech Status System */}
                    <section id="tech-status" className="help-section">
                        <h2>🚦 Tech Status System</h2>
                        <p><strong>Tech Status</strong> is a 3-state actionable indicator for field technicians, distinct from Intelligence grades (A-F).</p>

                        <div className="help-card">
                            <h3>Three States</h3>
                            <div className="help-status-examples">
                                <div className="help-status-card">
                                    <StatusBadge status="good" size="large" />
                                    <h4>All Systems Nominal</h4>
                                    <p>No issues detected. Continue normal monitoring.</p>
                                </div>
                                <div className="help-status-card">
                                    <StatusBadge status="watch" size="large" />
                                    <h4>Potential Issue Developing</h4>
                                    <p>Monitor closely today. May escalate if not addressed.</p>
                                </div>
                                <div className="help-status-card">
                                    <StatusBadge status="critical" size="large" />
                                    <h4>Critical Issue</h4>
                                    <p>Dispatch technician immediately. Requires urgent attention.</p>
                                </div>
                            </div>
                        </div>

                        <h3>Trigger Conditions</h3>
                        <TechStatusTriggers />

                        <div className="help-tip">
                            <strong>💡 Pro Tip:</strong> Use the Tech Status filter bar on the Dashboard to quickly see all trailers needing attention. Click the colored cards to filter the fleet table.
                        </div>
                    </section>

                    {/* Energy Deficit Detection */}
                    <section id="deficit-detection" className="help-section">
                        <h2>⚡ Energy Deficit Detection</h2>
                        <p>A <strong>deficit</strong> occurs when daily energy consumption exceeds solar generation (consumed_wh &gt; yield_wh). The system tracks consecutive deficit days and generates alerts when patterns indicate potential energy shortage.</p>

                        <div className="help-card">
                            <h3>🆕 Intelligent Deficit Classification</h3>
                            <p><strong>Problem:</strong> Not all deficits indicate energy shortage. When batteries are full and MPPT enters Float/Storage mode, solar production is intentionally throttled — creating small deficits that are actually <strong>good battery management</strong>, not problems.</p>

                            <p><strong>Solution:</strong> The system now distinguishes between two types of deficits:</p>

                            <div className="help-grid-2">
                                <div className="help-deficit-type deficit-type-real">
                                    <h4>⚠️ Real Deficit</h4>
                                    <p><strong>Indicates actual energy shortage requiring attention.</strong></p>
                                    <ul>
                                        <li>Large deficit (&gt;1 kWh) OR</li>
                                        <li>Low/moderate EOD SOC (&lt;88%) OR</li>
                                        <li>MPPT in Bulk/Absorption/other active charging</li>
                                    </ul>
                                    <p className="deficit-action"><strong>Action:</strong> Monitor and investigate. May need panel cleaning, load reduction, or battery servicing.</p>
                                </div>

                                <div className="help-deficit-type deficit-type-throttled">
                                    <h4>🔋 Idle-Throttled Deficit</h4>
                                    <p><strong>Small deficit caused by MPPT throttling when batteries full. Not a problem.</strong></p>
                                    <p><strong>Criteria (ALL must be met):</strong></p>
                                    <ul>
                                        <li>✅ End-of-day SOC ≥88% (high battery)</li>
                                        <li>✅ MPPT state: Float (5) or Storage (6)</li>
                                        <li>✅ Deficit &lt;1 kWh (small)</li>
                                    </ul>
                                    <p className="deficit-action"><strong>Action:</strong> None. This is normal when batteries full and excess solar throttled.</p>
                                </div>
                            </div>
                        </div>

                        <h3>Deficit Classification Flowchart</h3>
                        <DeficitFlowchart />

                        <h3>Alert Thresholds</h3>
                        <div className="help-table">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Streak Length</th>
                                        <th>Severity</th>
                                        <th>Tech Status</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr>
                                        <td><strong>≥5 real deficit days</strong></td>
                                        <td><SeverityBadge severity="critical" /></td>
                                        <td><StatusBadge status="critical" /></td>
                                        <td>Dispatch immediately</td>
                                    </tr>
                                    <tr>
                                        <td><strong>3-4 real deficit days</strong></td>
                                        <td><SeverityBadge severity="warning" /></td>
                                        <td><StatusBadge status="watch" /></td>
                                        <td>Monitor closely</td>
                                    </tr>
                                    <tr>
                                        <td><strong>2 real deficit days</strong></td>
                                        <td><SeverityBadge severity="caution" /></td>
                                        <td><StatusBadge status="watch" /></td>
                                        <td>Monitor</td>
                                    </tr>
                                    <tr>
                                        <td><strong>&lt;2 days</strong></td>
                                        <td>—</td>
                                        <td><StatusBadge status="good" /></td>
                                        <td>Normal monitoring</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div className="help-warning">
                            <strong>⚠️ Important:</strong> Idle-throttled days <strong>break</strong> the deficit streak. Only consecutive <strong>real</strong> deficit days count toward alerts.
                        </div>

                        <DeficitExampleTable />
                    </section>

                    {/* Solar Performance Score */}
                    <section id="solar-score" className="help-section">
                        <h2>☀️ Solar Performance Score</h2>
                        <p><strong>Solar Score</strong> is a location-aware performance rating (0-100%) that compares actual solar yield to expected yield based on weather conditions.</p>

                        <div className="help-card">
                            <h3>How It's Calculated</h3>
                            <div className="help-formula">
                                <code>Solar Score = (Actual Yield Today / Expected Yield Today) × 100%</code>
                            </div>
                            <p><strong>Expected Yield</strong> is calculated using GPS coordinates, solar panel specs (3× 435W = 1,305W), weather data (cloud cover, irradiance), and 80% system efficiency.</p>
                        </div>

                        <h3>Score Grades</h3>
                        <div className="help-score-examples">
                            <div className="help-score-card">
                                <SolarScoreBadge score={95} />
                                <p>Optimal performance, panels operating as expected</p>
                            </div>
                            <div className="help-score-card">
                                <SolarScoreBadge score={78} />
                                <p>Acceptable performance, minor issues possible</p>
                            </div>
                            <div className="help-score-card">
                                <SolarScoreBadge score={62} />
                                <p>Below expected, investigate possible causes</p>
                            </div>
                            <div className="help-score-card">
                                <SolarScoreBadge score={42} />
                                <p>Significant underperformance, dispatch technician</p>
                            </div>
                        </div>

                        <div className="help-card">
                            <h3>🆕 Throttling Adjustment</h3>
                            <p>When MPPT is in Float/Storage mode with high SOC, the score adjusts upward to account for intentional solar throttling:</p>
                            <ul>
                                <li><strong>Conditions:</strong> MPPT Float/Storage (5/6), SOC ≥90%, current score &lt;90%</li>
                                <li><strong>Adjustment:</strong> Score boosted based on 7-day average and panel health indicators</li>
                                <li><strong>Floor:</strong> If SOC ≥95%, score minimum 85%</li>
                            </ul>
                            <div className="help-example">
                                <strong>Example:</strong> Raw score 78% → Adjusted to 92% (throttled_full_battery)
                            </div>
                        </div>

                        <h3>MPPT Charge States</h3>
                        <MpptStateChart />
                    </section>

                    {/* Alerts & Notifications */}
                    <section id="alerts" className="help-section">
                        <h2>🔔 Alerts & Notifications</h2>

                        <div className="help-card">
                            <h3>Email Notifications</h3>
                            <p><strong>Trigger:</strong> New energy deficit alert (≥2 real deficit days)</p>
                            <p><strong>Rate Limit:</strong> 1 email per 6 hours per trailer (prevents spam)</p>

                            <div className="help-example">
                                <h4>Email Content Includes:</h4>
                                <ul>
                                    <li>Severity badge (CRITICAL/WARNING/CAUTION)</li>
                                    <li>Trailer name and ID</li>
                                    <li>Consecutive deficit day count</li>
                                    <li>Daily breakdown table (yield, consumed, deficit)</li>
                                    <li>🔋 Throttled badge on idle-throttled days</li>
                                    <li>Footer note explaining throttling logic</li>
                                </ul>
                            </div>
                        </div>

                        <h3>Alert Resolution</h3>
                        <p>Alerts are automatically resolved when:</p>
                        <ul>
                            <li>Deficit streak breaks (surplus day or throttled day)</li>
                            <li>Battery SOC recovers (for SOC alerts)</li>
                            <li>Alarm/error clears (for VRM alerts)</li>
                        </ul>
                        <p>A <strong>resolution email</strong> is sent when the alert clears.</p>
                    </section>

                    {/* Action Queue */}
                    <section id="action-queue" className="help-section">
                        <h2>📋 Action Queue</h2>
                        <p>The <strong>Action Queue</strong> is a priority-sorted task list on the Dashboard that consolidates all actionable items requiring technician attention.</p>

                        <h3>Priority Levels</h3>
                        <PriorityLevels />

                        <div className="help-card">
                            <h3>Using the Action Queue</h3>
                            <div className="help-grid-2">
                                <div>
                                    <h4>✅ DO:</h4>
                                    <ul>
                                        <li>Sort by priority (automatic)</li>
                                        <li>Acknowledge reviewed items</li>
                                        <li>Click trailer names for more context</li>
                                        <li>Expand deficit alerts for daily breakdown</li>
                                        <li>Look for 🔋 Throttled badges</li>
                                    </ul>
                                </div>
                                <div>
                                    <h4>❌ DON'T:</h4>
                                    <ul>
                                        <li>Ignore Priority 1 alerts</li>
                                        <li>Acknowledge without reviewing</li>
                                        <li>Assume all deficits are problems</li>
                                        <li>Dispatch to throttled-only deficits</li>
                                    </ul>
                                </div>
                            </div>
                        </div>

                        <div className="help-tip">
                            <strong>💡 Pro Tip:</strong> Acknowledge actions you're aware of to prevent duplicate work and help team coordination.
                        </div>
                    </section>

                    {/* Where Data Appears */}
                    <section id="pages" className="help-section">
                        <h2>🗺️ Where Data Appears</h2>

                        <div className="help-pages-grid">
                            <div className="help-page-card">
                                <h3>📊 Dashboard</h3>
                                <p><code>/</code></p>
                                <ul>
                                    <li>Fleet KPIs (size, online, avg SOC, yield, at risk)</li>
                                    <li>Tech Status summary bar (clickable filters)</li>
                                    <li>Action Queue (priority 1-5 sorted)</li>
                                    <li>Fleet table/grid with status dots</li>
                                </ul>
                            </div>

                            <div className="help-page-card">
                                <h3>⚡ Energy Page</h3>
                                <p><code>/fleet</code> (Energy tab)</p>
                                <ul>
                                    <li>Deficit alert cards with severity badges</li>
                                    <li>Daily breakdown tables</li>
                                    <li>🔋 Throttled day indicators</li>
                                    <li>Expand/collapse details</li>
                                </ul>
                            </div>

                            <div className="help-page-card">
                                <h3>🚗 Trailer Detail</h3>
                                <p><code>/trailer/:id</code></p>
                                <ul>
                                    <li>Live gauges (SOC, voltage, solar, load)</li>
                                    <li>Alert banners (alarms/errors)</li>
                                    <li>Intelligence section (solar score, energy balance, predictive SOC)</li>
                                    <li>Historical charts (7 days SOC, yield, voltage)</li>
                                </ul>
                            </div>

                            <div className="help-page-card">
                                <h3>📈 Analytics</h3>
                                <p><code>/fleet</code> (Intelligence tab)</p>
                                <ul>
                                    <li>Fleet Intelligence table</li>
                                    <li>Solar scores with transparency (raw/adjusted)</li>
                                    <li>7-day averages</li>
                                    <li>Top/bottom performers</li>
                                </ul>
                            </div>

                            <div className="help-page-card">
                                <h3>🗺️ Map View</h3>
                                <p><code>/map</code></p>
                                <ul>
                                    <li>Interactive job site markers</li>
                                    <li>Trailer pins with status colors</li>
                                    <li>Click popups with details</li>
                                    <li>Deployment status filters</li>
                                </ul>
                            </div>

                            <div className="help-page-card">
                                <h3>🔧 Maintenance</h3>
                                <p><code>/maintenance</code></p>
                                <ul>
                                    <li>Maintenance logs</li>
                                    <li>Service history</li>
                                    <li>Parts used tracking</li>
                                    <li>Technician assignments</li>
                                </ul>
                            </div>
                        </div>
                    </section>

                    {/* Morning Digest */}
                    <section id="digest" className="help-section">
                        <h2>📧 Daily Morning Digest</h2>
                        <p>A comprehensive daily email sent every morning at <strong>6:00 AM</strong> summarizing yesterday's fleet performance and today's action items.</p>

                        <div className="help-card">
                            <h3>Email Sections</h3>
                            <ol className="help-numbered-list">
                                <li>
                                    <strong>Yesterday's Fleet Performance</strong>
                                    <ul>
                                        <li>Fleet size, avg EOD SOC, total yield, total data usage</li>
                                        <li>Data from database (complete 24-hour metrics)</li>
                                    </ul>
                                </li>
                                <li>
                                    <strong>Current Status</strong>
                                    <ul>
                                        <li>Online now, current avg SOC</li>
                                        <li>Real-time snapshot taken when digest builds</li>
                                    </ul>
                                </li>
                                <li>
                                    <strong>Needs Attention</strong>
                                    <ul>
                                        <li><strong>Critical:</strong> SOC &lt;20%, active alarms, offline 24+ hours</li>
                                        <li><strong>Watch:</strong> SOC 20-40%, ≥5 real deficit days, declining SOC &gt;2%/day</li>
                                    </ul>
                                </li>
                                <li>
                                    <strong>Performance Highlights</strong>
                                    <ul>
                                        <li>Top performers (&gt;100% expected yield)</li>
                                        <li>Underperformers (&lt;70% expected yield)</li>
                                    </ul>
                                </li>
                                <li>
                                    <strong>Network Summary</strong>
                                    <ul>
                                        <li>Avg signal strength, high data usage devices</li>
                                    </ul>
                                </li>
                            </ol>
                        </div>

                        <div className="help-info">
                            <strong>Recipients:</strong> Managed via Settings page. Environment variable + user opt-in checkboxes.
                        </div>
                    </section>

                    {/* How to Interpret */}
                    <section id="interpretation" className="help-section">
                        <h2>🔍 How to Interpret Intelligence Data</h2>

                        <div className="help-card">
                            <h3>Understanding Deficit Alerts</h3>
                            <p><strong>Quick Decision Tree:</strong></p>
                            <div className="help-decision-tree">
                                <div className="decision-node">Is there a 🔋 Throttled badge?</div>
                                <div className="decision-branches">
                                    <div className="decision-branch">
                                        <span className="branch-label">Yes →</span>
                                        <div className="decision-content">
                                            <div className="decision-node">Are ALL deficit days throttled?</div>
                                            <div className="decision-branches">
                                                <div className="decision-branch">
                                                    <span className="branch-label">All →</span>
                                                    <div className="decision-result decision-good">✓ No action needed (will auto-resolve)</div>
                                                </div>
                                                <div className="decision-branch">
                                                    <span className="branch-label">Some →</span>
                                                    <div className="decision-result decision-warn">⚠️ Investigate real deficit days only</div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="decision-branch">
                                        <span className="branch-label">No →</span>
                                        <div className="decision-result decision-critical">⚠️ Real energy shortage, investigate immediately</div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="help-card">
                            <h3>Key Questions to Ask</h3>
                            <ol className="help-numbered-list">
                                <li><strong>What is the current battery SOC?</strong> (If &lt;40%, dispatch)</li>
                                <li><strong>What is the SOC trend?</strong> (Declining = worse, stable = monitor)</li>
                                <li><strong>How many REAL deficit days?</strong> (Ignore throttled)</li>
                                <li><strong>What is the deficit size?</strong> (&gt;2 kWh/day = significant)</li>
                                <li><strong>What is the MPPT state?</strong> (Bulk = charging hard, Float = throttling)</li>
                            </ol>
                        </div>

                        <div className="help-card">
                            <h3>Interpreting Solar Score</h3>
                            <div className="help-example">
                                <p><strong>Question:</strong> "Score shows 92% but raw score is 78%. Why the difference?"</p>
                                <p><strong>Answer:</strong> MPPT was in Float mode with high SOC (batteries full), so solar production was intentionally throttled. The system adjusted the score upward based on recent averages and panel health. The trailer is actually performing well; the low raw score is due to throttling, not panel issues.</p>
                                <p><strong>Action:</strong> None needed. This is normal when batteries are full.</p>
                            </div>
                        </div>
                    </section>

                    {/* Troubleshooting */}
                    <section id="troubleshooting" className="help-section">
                        <h2>🛠️ Common Scenarios & Troubleshooting</h2>

                        <div className="help-scenario">
                            <h3>Scenario 1: Energy Deficit with Declining SOC</h3>
                            <div className="help-scenario-content">
                                <div className="scenario-symptom">
                                    <strong>Symptom:</strong> 5-day deficit alert, SOC declining 85% → 72% → 58% → 45% → 32%
                                </div>
                                <div className="scenario-diagnosis">
                                    <strong>Diagnosis:</strong> Real energy shortage. Consumption exceeds generation consistently.
                                </div>
                                <div className="scenario-causes">
                                    <strong>Possible Causes:</strong>
                                    <ul>
                                        <li>Dirty/damaged solar panels (reduced yield)</li>
                                        <li>Excessive DC load (new equipment added?)</li>
                                        <li>Weather (extended cloudy/rainy period)</li>
                                        <li>Battery degradation (capacity loss)</li>
                                        <li>Shading (trees, buildings, obstructions)</li>
                                    </ul>
                                </div>
                                <div className="scenario-action">
                                    <strong>Action (Priority 1 - Dispatch Now):</strong>
                                    <ol>
                                        <li>Inspect and clean solar panels</li>
                                        <li>Measure DC load (compare to baseline)</li>
                                        <li>Check for new equipment drawing power</li>
                                        <li>Test battery capacity (may need replacement)</li>
                                        <li>Verify panel angles and shading</li>
                                    </ol>
                                </div>
                            </div>
                        </div>

                        <div className="help-scenario">
                            <h3>Scenario 2: Throttled Days Breaking Streak</h3>
                            <div className="help-scenario-content">
                                <div className="scenario-symptom">
                                    <strong>Symptom:</strong> Trailer had 4-day deficit, but alert cleared after adding a 5th deficit day
                                </div>
                                <div className="scenario-diagnosis">
                                    <strong>Diagnosis:</strong> The 5th day was idle-throttled (EOD SOC ≥88%, MPPT Float, &lt;1 kWh deficit). This breaks the streak.
                                </div>
                                <div className="scenario-explanation">
                                    <strong>Explanation:</strong> The system prioritizes real energy shortage detection. When batteries end the day full and MPPT is throttling, that's good battery management, not a problem. The streak resets.
                                </div>
                                <div className="scenario-action">
                                    <strong>Action:</strong> None. This is expected behavior. Monitor for new real deficit days starting tomorrow.
                                </div>
                            </div>
                        </div>

                        <div className="help-scenario">
                            <h3>Scenario 3: Offline 24+ Hours</h3>
                            <div className="help-scenario-content">
                                <div className="scenario-symptom">
                                    <strong>Symptom:</strong> Trailer shows offline, no VRM or network data for 24+ hours
                                </div>
                                <div className="scenario-diagnosis">
                                    <strong>Diagnosis:</strong> Complete system offline (power loss, hardware failure, or cellular outage)
                                </div>
                                <div className="scenario-causes">
                                    <strong>Possible Causes:</strong>
                                    <ul>
                                        <li>Battery fully discharged (system shut down)</li>
                                        <li>Cerbo GX power loss (fuse blown, wiring issue)</li>
                                        <li>Pepwave router offline (power loss, modem failure)</li>
                                        <li>Cellular service outage (carrier network down)</li>
                                    </ul>
                                </div>
                                <div className="scenario-action">
                                    <strong>Action (Priority 3 - Today):</strong>
                                    <ol>
                                        <li>Visit job site to inspect trailer</li>
                                        <li>Check battery voltage at terminals</li>
                                        <li>Verify Cerbo GX and Pepwave have power (LEDs)</li>
                                        <li>Check all fuses and circuit breakers</li>
                                        <li>Test cellular signal strength manually</li>
                                        <li>Power cycle equipment if needed</li>
                                    </ol>
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* Best Practices */}
                    <section id="best-practices" className="help-section">
                        <h2>✨ Best Practices for Technicians</h2>

                        <div className="help-card">
                            <h3>Daily Routine</h3>
                            <div className="help-timeline">
                                <div className="timeline-item">
                                    <div className="timeline-badge">🌅</div>
                                    <div className="timeline-content">
                                        <h4>Morning</h4>
                                        <ol>
                                            <li>Read Morning Digest email</li>
                                            <li>Check Dashboard Action Queue</li>
                                            <li>Filter Tech Status to 🔴 Needs Attention</li>
                                            <li>Acknowledge actions you're aware of</li>
                                        </ol>
                                    </div>
                                </div>
                                <div className="timeline-item">
                                    <div className="timeline-badge">☀️</div>
                                    <div className="timeline-content">
                                        <h4>During Day</h4>
                                        <ol>
                                            <li>Dispatch to critical trailers (Priority 1-2)</li>
                                            <li>Monitor Watch trailers remotely (Priority 3-4)</li>
                                            <li>Update maintenance logs for work completed</li>
                                        </ol>
                                    </div>
                                </div>
                                <div className="timeline-item">
                                    <div className="timeline-badge">🌙</div>
                                    <div className="timeline-content">
                                        <h4>Evening</h4>
                                        <ol>
                                            <li>Review resolved alerts (queue should shrink)</li>
                                            <li>Flag persistent issues for management</li>
                                        </ol>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="help-card">
                            <h3>Communicating with Management</h3>
                            <div className="help-example">
                                <h4>Example Escalation:</h4>
                                <blockquote>
                                    <strong>Priority 1 Alert: Trailer 582 at Aurora North</strong><br/>
                                    - 5-day real energy deficit (excludes 2 throttled days)<br/>
                                    - SOC declining 4.2%/day (85% → 68% → 52% → 35% → 18%)<br/>
                                    - Current SOC: 18% (critical)<br/>
                                    - Root cause: Panels 40% covered in dust/dirt<br/>
                                    - Action: Dispatching tech for panel cleaning today<br/>
                                    - ETA resolution: End of day
                                </blockquote>
                            </div>
                        </div>
                    </section>

                    {/* Glossary */}
                    <section id="glossary" className="help-section">
                        <h2>📖 Glossary</h2>
                        <div className="help-glossary">
                            <dl>
                                <dt>SOC</dt>
                                <dd>State of Charge (battery %, 0-100%)</dd>

                                <dt>EOD</dt>
                                <dd>End-of-Day (snapshot taken at midnight or last reading)</dd>

                                <dt>MPPT</dt>
                                <dd>Maximum Power Point Tracker (solar charge controller)</dd>

                                <dt>Bulk</dt>
                                <dd>MPPT charging stage (batteries &lt;80%, max current)</dd>

                                <dt>Absorption</dt>
                                <dd>MPPT charging stage (batteries 80-95%, constant voltage)</dd>

                                <dt>Float</dt>
                                <dd>MPPT maintenance stage (batteries &gt;95%, trickle charge)</dd>

                                <dt>Storage</dt>
                                <dd>MPPT storage stage (batteries full, minimal charge)</dd>

                                <dt>Deficit</dt>
                                <dd>Day when consumption &gt; solar yield</dd>

                                <dt>Real Deficit</dt>
                                <dd>Deficit indicating energy shortage (not throttled)</dd>

                                <dt>Idle-Throttled Deficit</dt>
                                <dd>Small deficit due to MPPT throttling when batteries full</dd>

                                <dt>Streak</dt>
                                <dd>Consecutive days of real deficit (throttled days break streak)</dd>

                                <dt>Tech Status</dt>
                                <dd>3-state actionable indicator (Good/Watch/Needs Attention)</dd>

                                <dt>Intelligence Grade</dt>
                                <dd>A-F performance grade (separate from Tech Status)</dd>

                                <dt>Solar Score</dt>
                                <dd>Location-aware solar performance rating (0-100%)</dd>

                                <dt>Action Queue</dt>
                                <dd>Priority-sorted task list on Dashboard</dd>

                                <dt>Morning Digest</dt>
                                <dd>Daily email with yesterday's metrics + action items</dd>

                                <dt>IC2</dt>
                                <dd>Pepwave InControl2 (network device management platform)</dd>

                                <dt>VRM</dt>
                                <dd>Victron Remote Management (solar system monitoring platform)</dd>

                                <dt>Cerbo GX</dt>
                                <dd>Victron data logger/gateway device</dd>

                                <dt>kWh</dt>
                                <dd>Kilowatt-hour (energy unit, 1000 watt-hours)</dd>

                                <dt>dBm</dt>
                                <dd>Decibel-milliwatts (signal strength unit, lower = weaker)</dd>
                            </dl>
                        </div>
                    </section>

                    <div className="help-footer-section">
                        <h2>💬 Support & Feedback</h2>
                        <p><strong>Questions?</strong> Contact your fleet operations manager or system administrator.</p>
                        <p><strong>Found a bug?</strong> Report issues at: <a href="https://github.com/spaeny10/vrm1/issues" target="_blank" rel="noopener noreferrer">GitHub Issues</a></p>
                        <p><strong>Feature requests?</strong> Discuss with management or submit via GitHub Issues.</p>
                    </div>
                </main>
            </div>
        </div>
    )
}

export default HelpPage
