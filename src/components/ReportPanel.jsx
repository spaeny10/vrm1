import { useState, useEffect } from 'react';
import { fetchTrailerReport, fetchSiteReport } from '../api/vrm';

export default function ReportPanel({ type, id, onClose }) {
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        setLoading(true);
        setError('');
        const fetchFn = type === 'trailer' ? fetchTrailerReport : fetchSiteReport;
        fetchFn(id)
            .then(data => setReport(data.report))
            .catch(err => setError(err.message))
            .finally(() => setLoading(false));
    }, [type, id]);

    const handlePrint = () => window.print();

    const formatDate = (ts) => {
        if (!ts) return '—';
        return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    };

    const formatWh = (wh) => {
        if (wh === null || wh === undefined) return '—';
        return wh >= 1000 ? `${(wh / 1000).toFixed(1)} kWh` : `${Math.round(wh)} Wh`;
    };

    if (loading) {
        return (
            <div className="maint-form-overlay" onClick={onClose}>
                <div className="report-panel" onClick={e => e.stopPropagation()}>
                    <p style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Generating report...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="maint-form-overlay report-overlay" onClick={onClose}>
            <div className="report-panel" onClick={e => e.stopPropagation()}>
                <div className="report-header no-print">
                    <h2>Report: {type === 'trailer' ? report?.trailer?.site_name : report?.job_site?.name}</h2>
                    <div className="report-actions">
                        <button className="btn btn-primary btn-sm" onClick={handlePrint}>Print / PDF</button>
                        <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
                    </div>
                </div>

                {error && <div className="login-error">{error}</div>}

                {report && type === 'trailer' && (
                    <div className="report-content">
                        <div className="report-meta">
                            <span>Generated: {formatDate(report.generated_at)}</span>
                            {report.health_grade && (
                                <span className={`health-grade health-grade-${report.health_grade.grade?.toLowerCase()}`}>
                                    Grade: {report.health_grade.grade} ({report.health_grade.score}%)
                                </span>
                            )}
                        </div>

                        <section className="report-section">
                            <h3>Current Status</h3>
                            {report.current_status ? (
                                <div className="report-grid">
                                    <div><strong>Battery SOC:</strong> {report.current_status.battery_soc?.toFixed(1)}%</div>
                                    <div><strong>Battery Voltage:</strong> {report.current_status.battery_voltage?.toFixed(1)}V</div>
                                    <div><strong>Solar Power:</strong> {report.current_status.solar_watts?.toFixed(0)}W</div>
                                    <div><strong>Yield Today:</strong> {report.current_status.solar_yield_today?.toFixed(2)} kWh</div>
                                    <div><strong>Battery Temp:</strong> {report.current_status.battery_temp?.toFixed(1)}°C</div>
                                    <div><strong>Charge State:</strong> {report.current_status.charge_state || '—'}</div>
                                </div>
                            ) : <p className="text-muted">No live data available</p>}
                        </section>

                        {report.intelligence && (
                            <section className="report-section">
                                <h3>Intelligence</h3>
                                <div className="report-grid">
                                    <div><strong>Solar Score:</strong> {report.intelligence.solar?.score?.toFixed(1)}% ({report.intelligence.solar?.score_label})</div>
                                    <div><strong>7d Avg Score:</strong> {report.intelligence.solar?.avg_7d_score?.toFixed(1) || '—'}%</div>
                                    <div><strong>Panel Performance:</strong> {report.intelligence.solar?.panel_performance_pct?.toFixed(1)}%</div>
                                    <div><strong>Days of Autonomy:</strong> {report.intelligence.battery?.days_of_autonomy?.toFixed(1) || '—'}</div>
                                    <div><strong>Yield Today:</strong> {formatWh(report.intelligence.solar?.yield_today_wh)}</div>
                                    <div><strong>Expected Yield:</strong> {formatWh(report.intelligence.location?.expected_daily_yield_wh)}</div>
                                    <div><strong>Stored Energy:</strong> {formatWh(report.intelligence.battery?.stored_wh)}</div>
                                    <div><strong>PSH:</strong> {report.intelligence.location?.peak_sun_hours?.toFixed(1)}h</div>
                                </div>
                            </section>
                        )}

                        {report.alerts?.length > 0 && (
                            <section className="report-section">
                                <h3>Active Alerts</h3>
                                {report.alerts.map((a, i) => (
                                    <div key={i} className="report-alert">
                                        <span className={`maint-status-badge maint-status-${a.severity === 'critical' ? 'red' : 'yellow'}`}>{a.severity}</span>
                                        <span>{a.streak_days}-day energy deficit streak</span>
                                    </div>
                                ))}
                            </section>
                        )}

                        {report.maintenance?.recent?.length > 0 && (
                            <section className="report-section">
                                <h3>Recent Maintenance</h3>
                                <table className="report-table">
                                    <thead><tr><th>Date</th><th>Title</th><th>Type</th><th>Status</th><th>Technician</th></tr></thead>
                                    <tbody>
                                        {report.maintenance.recent.map(m => (
                                            <tr key={m.id}>
                                                <td>{formatDate(m.scheduled_date || m.created_at)}</td>
                                                <td>{m.title}</td>
                                                <td>{m.visit_type}</td>
                                                <td>{m.status}</td>
                                                <td>{m.technician || '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </section>
                        )}

                        {report.energy_history?.length > 0 && (
                            <section className="report-section">
                                <h3>Energy History (14 days)</h3>
                                <table className="report-table">
                                    <thead><tr><th>Date</th><th>Yield</th><th>Consumed</th><th>Balance</th></tr></thead>
                                    <tbody>
                                        {report.energy_history.map(e => (
                                            <tr key={e.date}>
                                                <td>{e.date}</td>
                                                <td>{formatWh(e.yield_wh)}</td>
                                                <td>{formatWh(e.consumed_wh)}</td>
                                                <td style={{ color: (e.yield_wh || 0) >= (e.consumed_wh || 0) ? 'var(--success)' : 'var(--danger)' }}>
                                                    {e.yield_wh != null && e.consumed_wh != null ? formatWh(e.yield_wh - e.consumed_wh) : '—'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </section>
                        )}
                    </div>
                )}

                {report && type === 'site' && (
                    <div className="report-content">
                        <div className="report-meta">
                            <span>Generated: {formatDate(report.generated_at)}</span>
                            {report.job_site?.address && <span>{report.job_site.address}</span>}
                        </div>

                        <section className="report-section">
                            <h3>Trailers ({report.trailers?.length || 0})</h3>
                            <table className="report-table">
                                <thead><tr><th>Trailer</th><th>Grade</th><th>SOC</th><th>Solar</th><th>Yield</th></tr></thead>
                                <tbody>
                                    {(report.trailers || []).map(t => (
                                        <tr key={t.site_id}>
                                            <td>{t.site_name}</td>
                                            <td>
                                                {t.health_grade && (
                                                    <span className={`health-grade health-grade-${t.health_grade.grade?.toLowerCase()}`}>
                                                        {t.health_grade.grade}
                                                    </span>
                                                )}
                                            </td>
                                            <td>{t.battery_soc?.toFixed(1)}%</td>
                                            <td>{t.solar_watts?.toFixed(0)}W</td>
                                            <td>{t.yield_today?.toFixed(2)} kWh</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>

                        {report.maintenance?.recent?.length > 0 && (
                            <section className="report-section">
                                <h3>Recent Maintenance</h3>
                                <table className="report-table">
                                    <thead><tr><th>Date</th><th>Title</th><th>Type</th><th>Status</th></tr></thead>
                                    <tbody>
                                        {report.maintenance.recent.map(m => (
                                            <tr key={m.id}>
                                                <td>{formatDate(m.scheduled_date || m.created_at)}</td>
                                                <td>{m.title}</td>
                                                <td>{m.visit_type}</td>
                                                <td>{m.status}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </section>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
