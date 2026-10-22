// Helpers shared by the trailer detail page and its tabs: reading VRM
// diagnostics, plain-English labels, and network/value formatting.
import { isoDate } from '../../ui/format'

export const STALE_MS = 30 * 60 * 1000

export const RANGES = {
    '24h': 24 * 3600 * 1000,
    '7d': 7 * 24 * 3600 * 1000,
    '30d': 30 * 24 * 3600 * 1000,
}
export const RANGE_OPTIONS = [{ key: '24h', label: '24h' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }]

// First non-gateway diagnostic record for a VRM code
function diagRecord(records, code) {
    return records.find(r => r.code === code && r.Device !== 'Gateway')
}

export function diagValue(records, code) {
    const r = diagRecord(records, code)
    if (!r || r.rawValue == null || r.rawValue === '') return null
    const n = Number(r.rawValue)
    return isNaN(n) ? r.rawValue : n
}

export function diagText(records, code) {
    return diagRecord(records, code)?.formattedValue || null
}

// Victron charger states (VE.Direct "CS" / VRM "ScS" / snapshot charge_state)
const CHARGE_STATES = {
    0: 'Off', 1: 'Low power', 2: 'Fault', 3: 'Bulk charging', 4: 'Absorption', 5: 'Float', 6: 'Storage',
    7: 'Equalizing', 9: 'Inverting', 11: 'Power supply', 245: 'Starting up', 246: 'Repeated absorption',
    247: 'Auto equalize', 248: 'BatterySafe', 252: 'External control',
}
export function chargeStateLabel(v) {
    if (v == null || v === '') return null
    const n = Number(v)
    if (!isNaN(n)) return CHARGE_STATES[n] || `State ${n}`
    return String(v)
}

// Parse the live diagnostics feed into the values the page shows
export function parseDiagnostics(records = []) {
    let ts = 0
    for (const r of records) if (r.timestamp && r.timestamp > ts) ts = r.timestamp
    const gw = records.find(r => r.Device === 'Gateway' && r.code === 'FW')
    return {
        lastData: ts ? ts * 1000 : null,
        soc: diagValue(records, 'SOC') ?? diagValue(records, 'bs'),
        voltage: diagValue(records, 'V') ?? diagValue(records, 'bv'),
        current: diagValue(records, 'I') ?? diagValue(records, 'bc'),
        temp: diagValue(records, 'BT') ?? diagValue(records, 'bT'),
        consumedAh: diagValue(records, 'CE'),
        timeToGo: diagText(records, 'TTG'),
        minCell: diagValue(records, 'mcV'),
        maxCell: diagValue(records, 'McV'),
        solarW: diagValue(records, 'ScW') ?? diagValue(records, 'Pdc'),
        pvVoltage: diagValue(records, 'ScV') ?? diagValue(records, 'PVV'),
        yieldToday: diagValue(records, 'YT'),
        yieldYesterday: diagValue(records, 'YY'),
        chargeState: diagText(records, 'ScS') || chargeStateLabel(diagValue(records, 'ScS')),
        lifetimeYield: diagValue(records, 'H19'),
        loadW: diagValue(records, 'Pc'),
        alarmReason: diagText(records, 'AR') || (diagValue(records, 'AR') ? String(diagValue(records, 'AR')) : null),
        errorCode: diagText(records, 'ERR'),
        firmware: gw?.formattedValue || gw?.rawValue || null,
    }
}

export function tempTone(t) {
    if (t == null) return null
    return t > 45 ? 'crit' : t > 35 ? 'warn' : t < 5 ? 'warn' : null
}
export function tempLabel(t) {
    if (t == null) return null
    return t > 45 ? 'Too hot' : t > 35 ? 'Warm' : t < 5 ? 'Cold' : 'Normal'
}

// Cellular signal quality in words
export function rsrpQuality(v) {
    if (v == null) return null
    return v >= -80 ? { label: 'Excellent', tone: 'ok' } : v >= -90 ? { label: 'Good', tone: 'ok' } : v >= -100 ? { label: 'Fair', tone: 'warn' } : { label: 'Poor', tone: 'crit' }
}
export function sinrQuality(v) {
    if (v == null) return null
    return v >= 20 ? { label: 'Excellent', tone: 'ok' } : v >= 13 ? { label: 'Good', tone: 'ok' } : v >= 0 ? { label: 'Fair', tone: 'warn' } : { label: 'Poor', tone: 'crit' }
}

export function fmtUptime(sec) {
    if (sec == null || isNaN(Number(sec))) return '—'
    const s = Number(sec)
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
    if (d > 0) return `${d}d ${h}h`
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
}

export function fmtMB(mb) {
    if (mb == null || isNaN(Number(mb))) return '—'
    const n = Number(mb)
    return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`
}

export function fmtWh(wh) {
    if (wh == null || isNaN(Number(wh))) return '—'
    const n = Number(wh)
    return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)} kWh` : `${Math.round(n)} Wh`
}

// Component dates are BIGINT epoch ms. The form stores calendar dates at
// UTC midnight; read those back as the same calendar day in any timezone.
export function epochToISODate(v) {
    if (v == null || v === '') return ''
    const n = Number(v)
    if (isNaN(n)) return ''
    const d = new Date(n)
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) return d.toISOString().slice(0, 10)
    return isoDate(d)
}
export function isoDateToEpoch(s) {
    if (!s) return null
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
}

// Server diagnosis codes -> plain English, one entry per finding.
// "Critical SOC: 12%; Energy deficit: 6 day streak" ->
// ["Battery critically low: 12%", "Using more power than solar provides: 6 days running"]
const DIAG_RULES = [
    [/^Critical SOC:\s*(.+)$/i, (m) => `Battery critically low: ${m[1]}`],
    [/^Low SOC:\s*(.+)$/i, (m) => `Battery low: ${m[1]}`],
    [/^Energy deficit:\s*(\d+) day streak$/i, (m) => `Using more power than solar provides: ${m[1]} days running`],
    [/^SOC declining ([\d.]+)%\/day\s*[—-]\s*critical in ~(\d+)d$/i, (m) => `Battery draining ${m[1]}% a day, critical in about ${m[2]} days`],
    [/^SOC declining ([\d.]+)%\/day$/i, (m) => `Battery draining ${m[1]}% a day`],
    [/^Network-only trailer, Pepwave online$/i, () => 'Router online; no battery monitor linked'],
]
export function plainDiagnosis(text) {
    if (!text) return []
    return String(text).split(/;\s*/).filter(Boolean).map(part => {
        for (const [re, fn] of DIAG_RULES) {
            const m = part.match(re)
            if (m) return fn(m)
        }
        return part
    })
}

// Turn a time series into Chart.js {x, y} points
export function points(rows, field, scale = 1) {
    const out = []
    for (const r of rows) {
        const y = r[field]
        if (y == null || y === '') continue
        out.push({ x: Number(r.timestamp), y: Number(y) * scale })
    }
    return out
}
