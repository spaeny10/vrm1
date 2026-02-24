function KpiCard({ title, value, unit, icon, color = 'blue', trend }) {
    return (
        <div className={`kpi-card kpi-${color}`}>
            <div className="kpi-content">
                <div className="kpi-label">{title}</div>
                <div className="kpi-value">
                    {value}
                    {unit && <span className="kpi-unit">{unit}</span>}
                </div>
            </div>
            <div className="kpi-icon">
                {trend === 'up' && (
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M7 14l5-5 5 5z" />
                    </svg>
                )}
                {trend === 'down' && (
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M7 10l5 5 5-5z" />
                    </svg>
                )}
                {trend === 'ok' && (
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                )}
                {trend === 'warning' && (
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
                    </svg>
                )}
            </div>
        </div>
    )
}

export default KpiCard
