// Formatting helpers shared by every page.

// Date-only values ('YYYY-MM-DD') are calendar dates, not instants:
// parse them as local midnight so they never shift a day in US timezones.
export function toDate(v) {
    if (v == null || v === '') return null
    if (v instanceof Date) return v
    if (typeof v === 'number') return new Date(v)
    const s = String(v)
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split('-').map(Number)
        return new Date(y, m - 1, d)
    }
    if (/^\d+$/.test(s)) return new Date(Number(s))
    const d = new Date(s)
    return isNaN(d) ? null : d
}

export function fmtDate(v, opts = {}) {
    const d = toDate(v)
    if (!d) return '—'
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(opts.year === false ? {} : { year: 'numeric' }) })
}

export function fmtDateShort(v) {
    return fmtDate(v, { year: false })
}

export function fmtDateTime(v) {
    const d = toDate(v)
    if (!d) return '—'
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function fmtAgo(v) {
    const d = toDate(v)
    if (!d) return '—'
    const s = Math.round((Date.now() - d.getTime()) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    const days = Math.floor(s / 86400)
    return days === 1 ? 'yesterday' : `${days}d ago`
}

// Whole days between a date and today (positive = in the past)
export function daysSince(v) {
    const d = toDate(v)
    if (!d) return null
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const day = new Date(d); day.setHours(0, 0, 0, 0)
    return Math.round((today - day) / 86400000)
}

export function todayISO() {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function isoDate(v) {
    const d = toDate(v)
    if (!d) return ''
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function fmtMoney(v, { cents = true } = {}) {
    if (v == null || v === '' || isNaN(Number(v))) return '—'
    return Number(v).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })
}

export function fmtNum(v, digits = 0) {
    if (v == null || v === '' || isNaN(Number(v))) return '—'
    return Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function fmtPct(v, digits = 0) {
    if (v == null || isNaN(Number(v))) return '—'
    return `${Number(v).toFixed(digits)}%`
}

export function fmtKwh(v, digits = 1) {
    if (v == null || isNaN(Number(v))) return '—'
    return `${Number(v).toFixed(digits)} kWh`
}

export function fmtWatts(v) {
    if (v == null || isNaN(Number(v))) return '—'
    const n = Number(v)
    return n >= 1000 ? `${(n / 1000).toFixed(1)} kW` : `${Math.round(n)} W`
}

export function plural(n, word, pluralWord) {
    return `${n} ${n === 1 ? word : (pluralWord || word + 's')}`
}

export const HEALTH = {
    offline: { tone: 'off', label: 'Offline' },
    attention: { tone: 'crit', label: 'Needs attention' },
    watch: { tone: 'warn', label: 'Watch' },
    good: { tone: 'ok', label: 'Healthy' },
    unknown: { tone: 'off', label: 'No telemetry' },
}

export function socTone(soc) {
    if (soc == null) return 'off'
    return soc < 20 ? 'crit' : soc < 40 ? 'warn' : 'ok'
}
