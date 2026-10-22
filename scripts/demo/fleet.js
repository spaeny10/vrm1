// ============================================================
// Demo fleet definition shared by the telemetry simulator and the
// demo database seeder. Each trailer has a VRM installation id, an
// InControl2 device id (same name, so the app links them by name),
// a home site, and a scenario that drives its simulated telemetry.
// ============================================================

export const HQ = { key: 'hq', name: 'Big View HQ', lat: 37.6872, lon: -97.3301, address: 'Wichita, KS', company: null, hq: true }

export const COMPANIES = [
    { key: 'acme', name: 'Acme Construction', city: 'Dallas', state: 'TX', contact: { name: 'Dana Ruiz', title: 'Project Manager', email: 'dana.ruiz@acme-construction.example', phone: '214-555-0142' } },
    { key: 'skyline', name: 'Skyline Builders', city: 'Denver', state: 'CO', contact: { name: 'Marcus Lee', title: 'Site Superintendent', email: 'mlee@skylinebuilders.example', phone: '303-555-0188' } },
    { key: 'summit', name: 'Summit Energy', city: 'Midland', state: 'TX', contact: { name: 'Priya Natarajan', title: 'Field Ops Lead', email: 'pnatarajan@summit-energy.example', phone: '432-555-0117' } },
    { key: 'heartland', name: 'Heartland DOT Contractors', city: 'Oklahoma City', state: 'OK', contact: { name: 'Earl Whitaker', title: 'Safety Director', email: 'ewhitaker@heartland-dot.example', phone: '405-555-0163' } },
    { key: 'desert', name: 'Desert Sun Developers', city: 'Phoenix', state: 'AZ', contact: { name: 'Lena Ortiz', title: 'Construction Manager', email: 'lortiz@desertsun.example', phone: '602-555-0129' } },
]

export const SITES = [
    HQ,
    { key: 'dallas', name: 'Dallas Substation Expansion', lat: 32.7767, lon: -96.7970, address: 'Dallas, TX', company: 'acme' },
    { key: 'fortworth', name: 'Fort Worth Medical Campus', lat: 32.7555, lon: -97.3308, address: 'Fort Worth, TX', company: 'acme' },
    { key: 'dtc', name: 'Denver Tech Center Tower', lat: 39.6100, lon: -104.8900, address: 'Greenwood Village, CO', company: 'skyline' },
    { key: 'aurora', name: 'Aurora Logistics Park', lat: 39.7294, lon: -104.8319, address: 'Aurora, CO', company: 'skyline' },
    { key: 'permian', name: 'Permian Basin Pad 7', lat: 31.9973, lon: -102.0779, address: 'Midland, TX', company: 'summit' },
    { key: 'okc', name: 'I-35 Bridge Replacement', lat: 35.4676, lon: -97.5164, address: 'Oklahoma City, OK', company: 'heartland' },
    { key: 'phoenix', name: 'Phoenix Data Center', lat: 33.4484, lon: -112.0740, address: 'Phoenix, AZ', company: 'desert' },
]

// Scenarios:
//   normal        healthy unit
//   throttled     battery full, MPPT in float: low yield but healthy (must NOT alert)
//   low_battery   critical SOC with a multi-day energy deficit
//   dirty_panels  solar output ~40% of expected, moderate deficit
//   offline       router offline, VRM data stale for two days
//   hot_battery   battery temperature above 45°C
//   weak_signal   poor cellular signal
// rental: billing | delivered (not billing yet) | reserved | called_off | none
export const TRAILERS = [
    { unit: 'BV-101', site: 'dallas', scenario: 'normal', rental: 'billing', term: '1_year' },
    { unit: 'BV-102', site: 'dallas', scenario: 'normal', rental: 'billing', term: '1_year' },
    { unit: 'BV-103', site: 'dallas', scenario: 'throttled', rental: 'billing', term: '1_year' },
    { unit: 'BV-104', site: 'fortworth', scenario: 'normal', rental: 'billing', term: '6_month' },
    { unit: 'BV-105', site: 'fortworth', scenario: 'normal', rental: 'called_off', term: '6_month' },
    { unit: 'BV-106', site: 'dtc', scenario: 'normal', rental: 'billing', term: 'monthly' },
    { unit: 'BV-107', site: 'dtc', scenario: 'low_battery', rental: 'billing', term: 'monthly' },
    { unit: 'BV-108', site: 'dtc', scenario: 'normal', rental: 'billing', term: 'monthly' },
    { unit: 'BV-109', site: 'aurora', scenario: 'normal', rental: 'billing', term: '6_month' },
    { unit: 'BV-110', site: 'aurora', scenario: 'normal', rental: 'delivered', term: '6_month' },
    { unit: 'BV-111', site: 'permian', scenario: 'normal', rental: 'billing', term: '1_year' },
    { unit: 'BV-112', site: 'permian', scenario: 'dirty_panels', rental: 'billing', term: '1_year' },
    { unit: 'BV-113', site: 'permian', scenario: 'normal', rental: 'billing', term: '1_year' },
    { unit: 'BV-114', site: 'okc', scenario: 'normal', rental: 'billing', term: 'monthly' },
    { unit: 'BV-115', site: 'okc', scenario: 'offline', rental: 'billing', term: 'monthly' },
    { unit: 'BV-116', site: 'okc', scenario: 'normal', rental: 'billing', term: 'monthly' },
    { unit: 'BV-117', site: 'phoenix', scenario: 'normal', rental: 'billing', term: '6_month' },
    { unit: 'BV-118', site: 'phoenix', scenario: 'hot_battery', rental: 'billing', term: '6_month' },
    { unit: 'BV-119', site: 'phoenix', scenario: 'normal', rental: 'none', term: null },  // deployed with no rental: revenue leak
    { unit: 'BV-120', site: 'phoenix', scenario: 'weak_signal', rental: 'billing', term: '6_month' },
    { unit: 'BV-121', site: 'hq', scenario: 'normal', rental: 'reserved', term: 'monthly' },
    { unit: 'BV-122', site: 'hq', scenario: 'normal', rental: 'none', term: null },
    { unit: 'BV-123', site: 'hq', scenario: 'normal', rental: 'none', term: null },
    { unit: 'BV-124', site: 'hq', scenario: 'normal', rental: 'none', term: null },
].map((t, i) => ({
    ...t,
    vrmId: 300101 + i,
    ic2Id: 9101 + i,
    // Stable per-unit variation so the fleet doesn't look cloned
    seed: (i * 37 + 11) % 100 / 100,
}))

export function siteByKey(key) {
    return SITES.find(s => s.key === key)
}

// Deterministic small GPS offset (<120 m) so units on a site cluster tightly
export function trailerPosition(t) {
    const site = siteByKey(t.site)
    const angle = t.seed * Math.PI * 2
    const dist = 0.0004 + t.seed * 0.0006 // degrees, ~40–110 m
    return { lat: site.lat + Math.sin(angle) * dist, lon: site.lon + Math.cos(angle) * dist }
}

// ---------------- Telemetry model ----------------

const PANEL_W = 1305
const DC_LOAD_W = 58 // cameras + router + lighting controller, roughly constant

// Local solar hour from UTC + longitude
function solarHour(lon, when = new Date()) {
    const utc = when.getUTCHours() + when.getUTCMinutes() / 60
    return (utc + lon / 15 + 24) % 24
}

// Fraction of panel rating produced at a given solar hour (0 at night)
function solarCurve(h) {
    if (h < 6 || h > 18) return 0
    return Math.sin(Math.PI * (h - 6) / 12)
}

// Energy (kWh) produced so far today along the curve
function yieldSoFarKwh(h, efficiency) {
    if (h <= 6) return 0
    const end = Math.min(h, 18)
    // integral of sin over [6, end] hours, scaled by panel watts
    const integral = (12 / Math.PI) * (1 - Math.cos(Math.PI * (end - 6) / 12))
    return (PANEL_W * efficiency * integral) / 1000
}

// Current telemetry for a trailer
export function telemetry(t, when = new Date()) {
    const site = siteByKey(t.site)
    const h = solarHour(site.lon, when)
    const curve = solarCurve(h)

    let efficiency = 0.62 + t.seed * 0.08          // panel/derating factor
    let soc = 62 + t.seed * 30 + 6 * Math.sin(Math.PI * (h - 9) / 12)
    let temp = 24 + t.seed * 8 + 6 * curve
    let mppt = curve > 0.05 ? (soc > 96 ? 5 : soc > 90 ? 4 : 3) : 0
    let load = DC_LOAD_W + Math.round(t.seed * 14)
    let stale = false

    switch (t.scenario) {
        case 'throttled':
            soc = 100; mppt = curve > 0.05 ? 5 : 0; efficiency = 0.18
            break
        case 'low_battery':
            soc = 11 + 2 * curve; efficiency = 0.24; load = 96
            break
        case 'dirty_panels':
            efficiency = 0.27; soc = 38 + 4 * curve
            break
        case 'offline':
            stale = true
            break
        case 'hot_battery':
            temp = 46.5 + 2 * curve
            break
    }

    soc = Math.max(0, Math.min(100, soc))
    const solarW = Math.round(PANEL_W * efficiency * curve)
    const voltage = +(25.2 + (soc / 100) * 1.6).toFixed(2)
    const battPower = solarW - load
    const current = +(battPower / voltage).toFixed(2)
    const yieldToday = +yieldSoFarKwh(h, efficiency).toFixed(2)
    // Yesterday: a full day along the curve (with scenario efficiency)
    const yieldYesterday = +yieldSoFarKwh(18, efficiency).toFixed(2)
    // Consumed Ah since the last full charge (Victron reports it negative)
    const consumedAh = soc >= 99.5 ? 0 : -Math.round((100 - soc) * 4.6)

    const ts = Math.floor((stale ? when.getTime() - 2 * 86400000 : when.getTime()) / 1000)

    return {
        ts, soc: +soc.toFixed(1), voltage, current, battPower, temp: +temp.toFixed(1),
        solarW, yieldToday, yieldYesterday, consumedAh, load, mppt,
        lifetimeKwh: +(1800 + t.seed * 900).toFixed(1),
    }
}

// Cellular radio state
export function cellular(t) {
    const weak = t.scenario === 'weak_signal'
    return {
        online: t.scenario !== 'offline',
        signal_bar: weak ? 1 : 3 + Math.round(t.seed * 2),
        rsrp: weak ? -118 : Math.round(-82 - t.seed * 18),
        rsrq: weak ? -17 : Math.round(-8 - t.seed * 5),
        sinr: weak ? -2 : Math.round(9 + t.seed * 10),
        rssi: weak ? -97 : Math.round(-60 - t.seed * 15),
        carrier: ['Verizon', 'AT&T', 'T-Mobile'][Math.floor(t.seed * 3) % 3],
        usageMbToday: Math.round(180 + t.seed * 420),
    }
}
