// ============================================================
// UI kit: the building blocks every page is composed from.
// Styling lives in ui.css; these components keep markup consistent.
// ============================================================
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { HEALTH, socTone, fmtPct } from './format'

// ---------- Icons (inline, stroke-based) ----------
const PATHS = {
    home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></>,
    truck: <><rect x="1.5" y="6" width="14" height="10" rx="1.5" /><path d="M15.5 10h4l3 3v3h-7" /><circle cx="6" cy="18.5" r="1.8" /><circle cx="18" cy="18.5" r="1.8" /></>,
    pin: <><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></>,
    map: <><path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4z" /><path d="M9 4v13M15 6.5v13" /></>,
    wrench: <path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-2-2 6.3-6.3a4 4 0 0 1-5-5L6 14l-2-2 8-8 2.7 2.3z" />,
    dollar: <><path d="M12 2v20" /><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></>,
    doc: <><path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
    building: <><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" /></>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
    pulse: <path d="M3 12h4l3-8 4 16 3-8h4" />,
    gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
    help: <><circle cx="12" cy="12" r="9.5" /><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.9" /><circle cx="12" cy="17.2" r=".6" fill="currentColor" /></>,
    bell: <><path d="M18 8.5a6 6 0 0 0-12 0c0 6.5-3 8.5-3 8.5h18s-3-2-3-8.5" /><path d="M13.7 20.5a2 2 0 0 1-3.4 0" /></>,
    sun: <><circle cx="12" cy="12" r="4.5" /><path d="M12 1.5v2M12 20.5v2M3.5 3.5l1.4 1.4M19.1 19.1l1.4 1.4M1.5 12h2M20.5 12h2M3.5 20.5l1.4-1.4M19.1 4.9l1.4-1.4" /></>,
    moon: <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20.5 20.5-4.3-4.3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    x: <path d="M18 6 6 18M6 6l12 12" />,
    check: <path d="M20 6 9 17l-5-5" />,
    checkCircle: <><circle cx="12" cy="12" r="9.5" /><path d="m8 12.5 2.7 2.7L16.5 9.5" /></>,
    alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></>,
    menu: <path d="M3 6h18M3 12h18M3 18h18" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    back: <path d="m15 18-6-6 6-6" />,
    sparkle: <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3zM19 15l.9 2.1 2.1.9-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />,
    signal: <><path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16" /></>,
    battery: <><rect x="2" y="7" width="17" height="10" rx="2" /><path d="M22 11v2" /></>,
    calendar: <><rect x="3" y="4.5" width="18" height="16.5" rx="2" /><path d="M16 2.5v4M8 2.5v4M3 10h18" /></>,
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
    refresh: <><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12A9 9 0 0 1 18.5 5.7L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></>,
}

export function Icon({ name, size }) {
    return (
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={size ? { width: size, height: size } : undefined} aria-hidden="true">
            {PATHS[name]}
        </svg>
    )
}

// ---------- Page ----------
export function Page({ title, sub, crumbs, actions, children }) {
    return (
        <div>
            <div className="page-head">
                <div>
                    {crumbs && (
                        <div className="crumbs">
                            {crumbs.map((c, i) => (
                                <span key={i} style={{ display: 'contents' }}>
                                    {i > 0 && <span>/</span>}
                                    {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
                                </span>
                            ))}
                        </div>
                    )}
                    <h1>{title}</h1>
                    {sub && <div className="sub">{sub}</div>}
                </div>
                {actions && <div className="page-actions">{actions}</div>}
            </div>
            <div className="stack">{children}</div>
        </div>
    )
}

export function Card({ title, meta, actions, children, flush, foot, className = '', style }) {
    return (
        <section className={`card ${className}`} style={style}>
            {(title || actions || meta) && (
                <header className="card-head">
                    <h3>{title}{meta != null && <span className="meta">{meta}</span>}</h3>
                    {actions && <div className="btn-row">{actions}</div>}
                </header>
            )}
            <div className={`card-body ${flush ? 'flush' : ''}`}>{children}</div>
            {foot && <div className="card-foot">{foot}</div>}
        </section>
    )
}

// ---------- Stats ----------
export function Stats({ children }) {
    return <div className="stats">{children}</div>
}

export function Stat({ label, value, unit, hint, tone, dot, onClick, active }) {
    const Tag = onClick ? 'button' : 'div'
    return (
        <Tag className={`stat ${tone ? 'tone-' + tone : ''} ${active ? 'on' : ''}`} onClick={onClick} type={onClick ? 'button' : undefined}>
            <div className="label">{dot && <Dot tone={dot} />}{label}</div>
            <div className="value">{value}{unit && <small>{unit}</small>}</div>
            {hint && <div className="hint">{hint}</div>}
        </Tag>
    )
}

// ---------- Status ----------
export function Dot({ tone = 'off', pulse }) {
    return <span className={`dot ${tone} ${pulse ? 'pulse' : ''}`} />
}

export function Badge({ tone = 'plain', children, dot }) {
    return <span className={`badge ${tone}`}>{dot && <Dot tone={tone} />}{children}</span>
}

export function HealthBadge({ health }) {
    const h = HEALTH[health] || HEALTH.unknown
    return <Badge tone={h.tone} dot>{h.label}</Badge>
}

export function Grade({ grade }) {
    if (!grade) return <span className="faint">—</span>
    return <span className={`grade g-${grade}`} title={`Health grade ${grade}`}>{grade}</span>
}

export function Soc({ value }) {
    if (value == null) return <span className="faint">—</span>
    const tone = socTone(value)
    return (
        <span className="soc num">
            <span className={`meter ${tone === 'ok' ? '' : tone}`}><i style={{ width: `${Math.max(3, Math.min(100, value))}%` }} /></span>
            {fmtPct(value)}
        </span>
    )
}

export function Signal({ bars, online }) {
    if (!online) return <span className="faint">offline</span>
    if (bars == null) return <span className="faint">—</span>
    return (
        <span title={`${bars}/5 bars`} style={{ display: 'inline-flex', gap: 2, alignItems: 'flex-end', height: 14 }}>
            {[1, 2, 3, 4, 5].map(i => (
                <i key={i} style={{ width: 3, height: 3 + i * 2, borderRadius: 1, background: i <= bars ? (bars <= 1 ? 'var(--crit)' : bars <= 2 ? 'var(--warn)' : 'var(--ok)') : 'var(--surface-3)' }} />
            ))}
        </span>
    )
}

// ---------- Controls ----------
export function Tabs({ tabs, value, onChange }) {
    return (
        <div className="tabs" role="tablist">
            {tabs.map(t => (
                <button key={t.key} role="tab" className={value === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>
                    {t.label}{t.count != null && <span className="n">{t.count}</span>}
                </button>
            ))}
        </div>
    )
}

export function Seg({ options, value, onChange }) {
    return (
        <div className="seg">
            {options.map(o => (
                <button key={o.key} className={value === o.key ? 'on' : ''} onClick={() => onChange(o.key)}>{o.label}</button>
            ))}
        </div>
    )
}

export function Chips({ options, value, onChange }) {
    return (
        <div className="chips">
            {options.map(o => (
                <button key={o.key} className={`chip ${value === o.key ? 'on' : ''}`} onClick={() => onChange(o.key)}>
                    {o.dot && <Dot tone={o.dot} />}{o.label}{o.count != null && <span className="n">{o.count}</span>}
                </button>
            ))}
        </div>
    )
}

export function Search({ value, onChange, placeholder = 'Search…' }) {
    return (
        <label className="search">
            <Icon name="search" />
            <input className="input" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
        </label>
    )
}

export function Field({ label, hint, children }) {
    return (
        <label className="field">
            <span>{label}</span>
            {children}
            {hint && <small>{hint}</small>}
        </label>
    )
}

// ---------- Overlays ----------
function useEscape(onClose) {
    useEffect(() => {
        const h = e => { if (e.key === 'Escape') onClose?.() }
        window.addEventListener('keydown', h)
        return () => window.removeEventListener('keydown', h)
    }, [onClose])
}

export function Modal({ title, onClose, children, footer, wide }) {
    useEscape(onClose)
    return (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose?.() }}>
            <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
                <div className="modal-head">
                    <h2>{title}</h2>
                    <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
                </div>
                <div className="modal-body">{children}</div>
                {footer && <div className="modal-foot">{footer}</div>}
            </div>
        </div>
    )
}

export function Drawer({ title, sub, onClose, children, actions }) {
    useEscape(onClose)
    return (
        <>
            <div className="drawer-overlay" onClick={onClose} />
            <aside className="drawer" role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
                <div className="drawer-head">
                    <div>
                        <h2 style={{ fontSize: 17, fontWeight: 650 }}>{title}</h2>
                        {sub && <div className="muted" style={{ marginTop: 4 }}>{sub}</div>}
                    </div>
                    <div className="btn-row">
                        {actions}
                        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
                    </div>
                </div>
                <div className="drawer-body">{children}</div>
            </aside>
        </>
    )
}

// ---------- Empty states ----------
export function Empty({ title, children, compact }) {
    return (
        <div className={`empty ${compact ? 'compact' : ''}`}>
            {title && <b>{title}</b>}
            {children}
        </div>
    )
}

export function AllClear({ children }) {
    return <div className="allclear"><Icon name="checkCircle" /><span>{children}</span></div>
}

export function Loading({ label = 'Loading…' }) {
    return <Empty compact><span className="faint">{label}</span></Empty>
}

// ---------- Data table ----------
// columns: [{ key, label, render?(row), sort?(row) value, align: 'r', width }]
export function DataTable({ columns, rows, onRowClick, rowKey = 'id', empty, initialSort }) {
    const [sort, setSort] = useState(initialSort || null) // { key, dir }
    const sorted = useMemo(() => {
        if (!sort) return rows
        const col = columns.find(c => c.key === sort.key)
        if (!col?.sort) return rows
        const dir = sort.dir === 'desc' ? -1 : 1
        return [...rows].sort((a, b) => {
            const va = col.sort(a), vb = col.sort(b)
            if (va == null && vb == null) return 0
            if (va == null) return 1
            if (vb == null) return -1
            return (typeof va === 'string' ? va.localeCompare(vb, undefined, { numeric: true }) : va - vb) * dir
        })
    }, [rows, sort, columns])

    if (!rows.length) return empty || <Empty compact>Nothing to show.</Empty>
    return (
        <div className="table-wrap">
            <table className="table">
                <thead>
                    <tr>
                        {columns.map(c => (
                            <th key={c.key} className={`${c.align === 'r' ? 'r' : ''} ${c.sort ? 'sortable' : ''}`} style={c.width ? { width: c.width } : undefined}
                                onClick={c.sort ? () => setSort(s => s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' }) : undefined}>
                                {c.label}{sort?.key === c.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {sorted.map(row => (
                        <tr key={typeof rowKey === 'function' ? rowKey(row) : row[rowKey]} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                            {columns.map(c => (
                                <td key={c.key} className={c.align === 'r' ? 'r' : ''}>{c.render ? c.render(row) : (row[c.key] ?? '—')}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

// ---------- Key/value ----------
export function KV({ items }) {
    return (
        <dl className="kv">
            {items.filter(Boolean).map(([k, v], i) => (
                <div key={i} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>
            ))}
        </dl>
    )
}
