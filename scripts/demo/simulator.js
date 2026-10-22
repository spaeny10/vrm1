// ============================================================
// Fleet telemetry simulator: a local stand-in for the Victron VRM
// and Peplink InControl2 APIs, serving the demo fleet in fleet.js.
//
//   node scripts/demo/simulator.js            (listens on :4010)
//
// Point the app at it with:
//   VRM_API_BASE=http://localhost:4010/v2  VRM_API_TOKEN=demo  VRM_USER_ID=1
//   IC2_API_BASE=http://localhost:4010     IC2_CLIENT_ID=demo  IC2_CLIENT_SECRET=demo
// ============================================================
import express from 'express'
import { TRAILERS, telemetry, cellular, trailerPosition } from './fleet.js'

const PORT = process.env.SIM_PORT || 4010
const app = express()
app.use(express.urlencoded({ extended: false }))

const byVrmId = new Map(TRAILERS.map(t => [t.vrmId, t]))
const byIc2Id = new Map(TRAILERS.map(t => [t.ic2Id, t]))

// ---------- Victron VRM ----------

app.get('/v2/users/:userId/installations', (req, res) => {
    res.json({
        success: true,
        records: TRAILERS.map(t => ({ idSite: t.vrmId, name: t.unit, identifier: `sim-${t.vrmId}` })),
    })
})

app.get('/v2/installations/:id/diagnostics', (req, res) => {
    const t = byVrmId.get(parseInt(req.params.id))
    if (!t) return res.status(404).json({ success: false, errors: 'Unknown installation' })
    const v = telemetry(t)
    const rec = (Device, code, rawValue) => ({ idSite: t.vrmId, timestamp: v.ts, Device, code, rawValue })
    res.json({
        success: true,
        records: [
            rec('Battery Monitor', 'SOC', v.soc),
            rec('Battery Monitor', 'V', v.voltage),
            rec('Battery Monitor', 'I', v.current),
            rec('Battery Monitor', 'P', v.battPower),
            rec('Battery Monitor', 'BT', v.temp),
            rec('Battery Monitor', 'CE', v.consumedAh),
            rec('Solar Charger', 'ScW', v.solarW),
            rec('Solar Charger', 'YT', v.yieldToday),
            rec('Solar Charger', 'YY', v.yieldYesterday),
            rec('Solar Charger', 'MPPT', v.mppt),
            rec('Solar Charger', 'ScS', v.mppt),
            rec('Solar Charger', 'H19', v.lifetimeKwh),
            rec('System overview', 'Pc', v.load),
            rec('Gateway', 'FW', 'v3.40'),
        ],
    })
})

app.get('/v2/installations/:id/alarms', (req, res) => {
    const t = byVrmId.get(parseInt(req.params.id))
    if (!t) return res.status(404).json({ success: false })
    const now = Math.floor(Date.now() / 1000)
    const records = []
    if (t.scenario === 'hot_battery') records.push({ type: 'alarm', name: 'High battery temperature', device: 'Battery Monitor', started: now - 5400 })
    if (t.scenario === 'low_battery') records.push({ type: 'warning', name: 'Low state of charge', device: 'Battery Monitor', started: now - 86400 })
    res.json({ success: true, records })
})

app.get('/v2/installations/:id/system-overview', (req, res) => {
    const t = byVrmId.get(parseInt(req.params.id))
    if (!t) return res.status(404).json({ success: false })
    res.json({
        success: true,
        records: {
            name: t.unit,
            devices: [
                { name: 'Cerbo GX', productCode: 'C030', machineSerialNumber: `HQ22${t.vrmId}`, firmwareVersion: 'v3.40' },
                { name: 'SmartSolar MPPT 150/45', productCode: 'A06C', machineSerialNumber: `HQ21${t.vrmId}`, firmwareVersion: 'v1.61' },
                { name: 'Lynx Smart BMS 500', productCode: 'A3E5', machineSerialNumber: `HQ23${t.vrmId}`, firmwareVersion: 'v1.10' },
            ],
        },
    })
})

app.get('/v2/installations/:id/stats', (req, res) => {
    res.json({ success: true, records: {} })
})

// ---------- Peplink InControl2 ----------

app.post('/api/oauth2/token', (req, res) => {
    res.json({ access_token: 'sim-token', refresh_token: 'sim-refresh', expires_in: 86400 })
})

function device(t) {
    const c = cellular(t)
    const pos = trailerPosition(t)
    return {
        id: t.ic2Id,
        name: t.unit,
        sn: `1934-SIM-${t.ic2Id}`,
        status: c.online ? 'online' : 'offline',
        product_name: 'Peplink MAX BR1 Pro 5G',
        fw_ver: '8.4.1',
        client_count: c.online ? 3 + Math.round(t.seed * 3) : 0,
        uptime: c.online ? 86400 * (3 + Math.round(t.seed * 20)) : 0,
        last_online: c.online ? null : new Date(Date.now() - 2 * 86400000).toISOString(),
        gps_support: true,
        gps_exist: true,
        latitude: pos.lat,
        longitude: pos.lon,
        interfaces: [{
            id: 1,
            name: 'Cellular',
            type: 'gobi',
            virtualType: 'cellular',
            status: c.online ? 'Connected' : 'Disconnected',
            status_led: c.online ? 'green' : 'red',
            carrier_name: c.carrier,
            ip: c.online ? `10.${t.ic2Id % 250}.0.2` : null,
            gobi_data_tech: '5G NSA',
            gobi_band_class_name: 'n71',
            signal_bar: c.online ? c.signal_bar : 0,
            cellular_signals: c.online ? { rsrp: c.rsrp, rsrq: c.rsrq, rssi: c.rssi, sinr: c.sinr } : null,
            apn: 'vzwinternet',
            imei: `35${String(t.ic2Id).padStart(13, '0')}`,
            sims: [{ id: 1, simCardDetected: true, active: true, mtn: c.carrier, iccid: `8901${t.ic2Id}`, apn: 'vzwinternet' }],
        }],
    }
}

app.get('/rest/o/:org/g/:group/d', (req, res) => {
    res.json({ data: TRAILERS.map(device) })
})

app.get(['/rest/o/:org/g/:group/bandwidth_per_device', '/rest/o/:org/bandwidth_per_device'], (req, res) => {
    res.json({
        data: TRAILERS.filter(t => cellular(t).online).map(t => {
            const mb = cellular(t).usageMbToday
            const total = mb * 1024 * 1024
            return { id: t.ic2Id, name: t.unit, upload: Math.round(total * 0.7), download: Math.round(total * 0.3), total }
        }),
    })
})

app.get('/rest/o/:org/g/:group/d/:id/loc', (req, res) => {
    const t = byIc2Id.get(parseInt(req.params.id))
    if (!t) return res.status(404).json({ data: [] })
    const pos = trailerPosition(t)
    res.json({ data: [{ la: pos.lat, lo: pos.lon, ts: Math.floor(Date.now() / 1000) }] })
})

app.listen(PORT, () => {
    console.log(`Fleet simulator: ${TRAILERS.length} trailers on http://localhost:${PORT}`)
})
