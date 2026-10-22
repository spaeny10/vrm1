import { useCallback, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useAuth } from '../components/AuthProvider'
import { useWorkspace } from '../components/WorkspaceProvider'
import {
    fetchBoardTrailers, fetchDiagnostics, fetchAlarms, fetchSystemOverview, fetchFleetNetwork, fetchTrailerIntelligence,
} from '../api/vrm'
import { Page, Stats, Stat, Tabs, HealthBadge, Signal, Icon, Empty, Loading } from '../ui'
import { fmtAgo, fmtDateTime, fmtKwh, fmtPct, fmtWatts, socTone } from '../ui/format'
import ReportPanel from '../components/ReportPanel'
import TrailerFormModal from '../components/TrailerFormModal'
import { parseDiagnostics, plainDiagnosis, tempLabel, tempTone, STALE_MS, fmtMB } from '../components/trailer/telemetry'
import AiDrawer from '../components/trailer/AiDrawer'
import OverviewTab from '../components/trailer/OverviewTab'
import HistoryTab from '../components/trailer/HistoryTab'
import NetworkTab from '../components/trailer/NetworkTab'
import RentalTab from '../components/trailer/RentalTab'
import ServiceTab from '../components/trailer/ServiceTab'
import NotesTab from '../components/trailer/NotesTab'
import HardwareTab from '../components/trailer/HardwareTab'

const none = () => Promise.resolve(null)

// One trailer: what's wrong (header + diagnosis), the handful of numbers
// that matter, and everything else organized into tabs.
export default function TrailerDetail() {
    const { id } = useParams()
    const siteId = Number(id)
    const isVrm = siteId > 0
    const { user } = useAuth()
    const { workspace } = useWorkspace()
    const canEdit = user?.role === 'admin' || user?.role === 'technician'
    const [params, setParams] = useSearchParams()
    const [showReport, setShowReport] = useState(false)
    const [showAi, setShowAi] = useState(false)
    const [editAsset, setEditAsset] = useState(false)

    const boardFn = useCallback(() => fetchBoardTrailers(), [])
    const diagFn = useCallback(() => (isVrm ? fetchDiagnostics(siteId) : none()), [siteId, isVrm])
    const alarmsFn = useCallback(() => (isVrm ? fetchAlarms(siteId) : none()), [siteId, isVrm])
    const systemFn = useCallback(() => (isVrm ? fetchSystemOverview(siteId) : none()), [siteId, isVrm])
    const netFn = useCallback(() => fetchFleetNetwork(), [])

    const { data: board, loading: boardLoading, refetch: refetchBoard } = useApiPolling(boardFn, 60000)
    const { data: diagData } = useApiPolling(diagFn, 30000)
    const { data: alarmsData } = useApiPolling(alarmsFn, 60000)
    const { data: systemData } = useApiPolling(systemFn, 300000)
    const { data: netData } = useApiPolling(netFn, 60000)

    const row = useMemo(() => (board?.trailers || []).find(t => String(t.site_id) === String(id)) || null, [board, id])
    const systemName = systemData?.records?.name || null
    const device = useMemo(() => {
        const list = netData?.records || []
        return list.find(d => (row?.unit && d.name === row.unit) || (systemName && d.name === systemName) || (!isVrm && d.id === -siteId)) || null
    }, [netData, row, systemName, isVrm, siteId])

    const d = useMemo(() => parseDiagnostics(diagData?.records || []), [diagData])
    const alarms = alarmsData?.records || []
    const unit = row?.unit || systemName || device?.name || (isVrm ? `Trailer ${id}` : 'Router-only unit')

    // Freshness
    const lastData = d.lastData || row?.last_seen || null
    const stale = isVrm && (!lastData || Date.now() - lastData > STALE_MS)
    const routerOnline = !!device?.online
    const health = row?.health || (stale ? 'offline' : 'unknown')

    // Intelligence needs live VRM data (the server 404s for stale units)
    const liveVrm = isVrm && !!diagData && !stale
    const intelFn = useCallback(() => (liveVrm ? fetchTrailerIntelligence(siteId) : none()), [siteId, liveVrm])
    const { data: intelData } = useApiPolling(intelFn, 120000)
    const intel = intelData?.intelligence || null

    // Metrics: live diagnostics first, board row as fallback
    const soc = d.soc ?? row?.soc
    const solarW = d.solarW ?? row?.solar_w
    const yieldToday = d.yieldToday ?? row?.yield_today_kwh
    const expected = row?.expected_yield_kwh ?? (intel ? intel.location.expected_daily_yield_wh / 1000 : null)
    const loadW = d.loadW ?? row?.load_w
    const temp = d.temp ?? row?.battery_temp
    const rsrp = device?.cellular?.signal?.rsrp ?? row?.rsrp
    const bars = device?.cellular?.signal_bar ?? row?.signal_bars

    const tab = TAB_KEYS.includes(params.get('tab')) ? params.get('tab') : 'overview'
    const setTab = (k) => setParams(k === 'overview' ? {} : { tab: k }, { replace: true })

    if (boardLoading && !board) return <Loading label="Loading trailer…" />
    if (board && !row && !device && !(diagData?.records || []).length) {
        return (
            <Page title="Trailer not found" crumbs={[{ label: 'Trailers', to: '/trailers' }, { label: id }]}>
                <Empty title="We couldn't find this trailer">
                    No trailer reports under ID {id}. <Link to="/trailers" className="link">Back to all trailers</Link>
                </Empty>
            </Page>
        )
    }

    const findings = plainDiagnosis(row?.diagnosis)
    const diagnosisLine = findings.length ? findings.join(' · ') : health === 'good' ? 'All systems normal.' : health === 'offline' ? 'Not reporting.' : 'No telemetry linked.'
    const lastHint = stale ? `Last known · ${fmtAgo(lastData)}` : null
    const site = row?.site
    const customer = row?.customer

    const tabs = [
        { key: 'overview', label: 'Overview', count: alarms.length || null },
        { key: 'history', label: 'History' },
        { key: 'network', label: 'Network' },
        { key: 'rental', label: 'Rental' },
        { key: 'service', label: 'Service' },
        { key: 'notes', label: 'Notes' },
        { key: 'hardware', label: 'Hardware' },
    ].filter(t => isVrm || !VRM_ONLY_TABS.includes(t.key))

    return (
        <Page
            crumbs={[{ label: 'Trailers', to: '/trailers' }, ...(site ? [{ label: site.name, to: `/site/${site.id}` }] : []), { label: unit }]}
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>{unit}<HealthBadge health={health} /></span>}
            sub={
                <div style={{ display: 'grid', gap: 4 }}>
                    <div style={{ color: 'var(--text)', fontWeight: 500 }}>{diagnosisLine}</div>
                    <div className="faint" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        {site ? <Link to={`/site/${site.id}`} className="link">{site.name}</Link> : <span>Unassigned</span>}
                        {customer && <><span>·</span><span className="muted">{customer.name}</span></>}
                        <span>·</span>
                        <span>{lastData ? `Last data ${fmtAgo(lastData)}` : 'No data yet'}</span>
                    </div>
                </div>
            }
            actions={<>
                {isVrm && <button className="btn" onClick={() => setShowReport(true)}><Icon name="doc" />Report</button>}
                {isVrm && <button className="btn" onClick={() => setShowAi(true)}><Icon name="sparkle" />AI analysis</button>}
                {canEdit && row?.trailer_id && <button className="btn ghost" onClick={() => setEditAsset(true)}><Icon name="edit" />Edit asset</button>}
            </>}
        >
            <FreshnessCallout isVrm={isVrm} stale={stale} lastData={lastData} routerOnline={routerOnline} hasDevice={!!device} />

            {isVrm ? (
                <Stats>
                    <Stat label="Battery" value={soc != null ? fmtPct(soc) : '—'} tone={stale ? null : soc != null ? toneOf(socTone(soc)) : null}
                        hint={lastHint || [d.voltage != null && `${Number(d.voltage).toFixed(1)} V`, d.current != null && `${d.current > 0 ? 'charging' : d.current < 0 ? 'discharging' : 'idle'} ${Math.abs(d.current).toFixed(1)} A`].filter(Boolean).join(' · ') || null} />
                    <Stat label="Solar now" value={solarW != null ? fmtWatts(solarW) : '—'} hint={lastHint || d.chargeState || null} />
                    <Stat label="Solar today" value={yieldToday != null ? Number(yieldToday).toFixed(1) : '—'} unit={yieldToday != null ? 'kWh' : null}
                        hint={lastHint || (expected ? `of ${fmtKwh(expected)} expected` : null)} />
                    <Stat label="DC load" value={loadW != null ? fmtWatts(loadW) : '—'} hint={lastHint || (d.timeToGo ? `${d.timeToGo} to empty` : 'Cameras and router')} />
                    <Stat label="Battery temp" value={temp != null ? `${Number(temp).toFixed(0)}°C` : '—'} tone={stale ? null : tempTone(temp)} hint={lastHint || tempLabel(temp)} />
                    <SignalStat device={device} rsrp={rsrp} bars={bars} />
                </Stats>
            ) : (
                <Stats>
                    <SignalStat device={device} rsrp={rsrp} bars={bars} />
                    <Stat label="Clients" value={device?.client_count ?? '—'} hint="Connected devices" />
                    <Stat label="Data today" value={fmtMB(device?.usage_mb)} hint={device?.cellular?.carrier || null} />
                </Stats>
            )}

            <div>
                <Tabs tabs={tabs} value={tab} onChange={setTab} />
                {tab === 'overview' && <OverviewTab siteId={siteId} intel={intel} alarms={alarms} stale={stale} d={d} />}
                {tab === 'history' && <HistoryTab siteId={siteId} />}
                {tab === 'network' && <NetworkTab device={device} />}
                {tab === 'rental' && <RentalTab siteId={siteId} row={row} workspace={workspace} role={user?.role} onChanged={refetchBoard} />}
                {tab === 'service' && <ServiceTab siteId={siteId} jobSiteId={site?.id} canEdit={canEdit} />}
                {tab === 'notes' && <NotesTab siteId={siteId} site={site} />}
                {tab === 'hardware' && <HardwareTab system={systemData?.records} d={d} device={device} row={row} />}
            </div>

            {showReport && <ReportPanel type="trailer" id={siteId} onClose={() => setShowReport(false)} />}
            {showAi && <AiDrawer siteId={siteId} unit={unit} onClose={() => setShowAi(false)} />}
            {editAsset && <TrailerFormModal trailerId={row.trailer_id} onSaved={refetchBoard} onClose={() => setEditAsset(false)} />}
        </Page>
    )
}

const TAB_KEYS = ['overview', 'history', 'network', 'rental', 'service', 'notes', 'hardware']
const VRM_ONLY_TABS = ['overview', 'history', 'hardware']

function toneOf(t) {
    return t === 'crit' || t === 'warn' ? t : null
}

function SignalStat({ device, rsrp, bars }) {
    if (!device) return <Stat label="Signal" value="—" hint="No router linked" />
    if (!device.online) return <Stat label="Signal" value="Offline" hint={device.offline_since ? `Router offline since ${fmtDateTime(device.offline_since)}` : 'Router not responding'} />
    const tech = [device.cellular?.carrier, device.cellular?.technology].filter(Boolean).join(' ')
    return (
        <Stat label={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>Signal <Signal bars={bars} online /></span>}
            value={rsrp ?? '—'} unit={rsrp != null ? 'dBm' : null} tone={bars != null && bars <= 1 ? 'warn' : null}
            hint={[bars != null && `${bars}/5 bars`, tech].filter(Boolean).join(' · ') || null} />
    )
}

function FreshnessCallout({ isVrm, stale, lastData, routerOnline, hasDevice }) {
    if (!isVrm) {
        return (
            <div className="callout">
                <Icon name="signal" size={18} />
                <div><b>Router-only unit.</b> No Victron battery or solar monitor is linked to this unit, so only network data is available.</div>
            </div>
        )
    }
    if (!stale) return null
    const when = lastData ? `${fmtDateTime(lastData)} (${fmtAgo(lastData)})` : null
    if (routerOnline) {
        return (
            <div className="callout warn">
                <Icon name="alert" size={18} />
                <div>
                    <b>Battery data is stale.</b> The router is online, but the Victron Cerbo GX {when ? `last reported ${when}` : 'has never reported'}.
                    {' '}Check the Cerbo's power and its network cable to the router. Readings below are the last values received.
                </div>
            </div>
        )
    }
    return (
        <div className="callout warn">
            <Icon name="alert" size={18} />
            <div>
                <b>Trailer offline.</b> {when ? `No data since ${when}.` : 'This trailer has never reported.'}
                {' '}{hasDevice ? 'Both the router and the Victron Cerbo are silent' : 'The Victron Cerbo is silent'}, which usually means the trailer lost power or cellular coverage.
                {when && ' Readings below are the last values received.'}
            </div>
        </div>
    )
}
