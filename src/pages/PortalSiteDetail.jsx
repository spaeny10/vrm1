import { useCallback, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchPortalSiteDetail, apiGet } from '../api/vrm'
import { Page, Card, Stats, Stat, DataTable, Badge, Soc, Empty, Loading, Icon } from '../ui'
import { fmtAgo, fmtKwh, fmtWatts } from '../ui/format'
import ReportProblemModal from '../components/helpdesk/ReportProblemModal'
import { RequestList } from './PortalRequests'

// Customer view of one site: unit status, the requests open for it, and
// any updates BIGView has shared. Asking for help always goes through a
// request, so every message has an owner and a status.
export default function PortalSiteDetail() {
    const { id } = useParams()
    const navigate = useNavigate()
    const siteFn = useCallback(() => fetchPortalSiteDetail(id), [id])
    const notesFn = useCallback(() => apiGet(`/portal/site/${id}/notes`), [id])
    const reqFn = useCallback(() => apiGet('/portal/tickets'), [])
    const { data, loading } = useApiPolling(siteFn, 60000)
    const { data: notesData } = useApiPolling(notesFn, 60000)
    const { data: reqData } = useApiPolling(reqFn, 30000)
    const [reporting, setReporting] = useState(null)   // null | { unit }

    const site = data?.site
    const notes = notesData?.notes || []
    const requests = (reqData?.tickets || []).filter(t => String(t.job_site_id) === String(id) && t.status !== 'resolved')

    if (loading && !data) return <Loading />
    if (!site) return <Empty title="Site not available">You may not have access to this site.</Empty>

    const columns = [
        { key: 'unit', label: 'Unit', render: t => <span className="primary">{t.site_name}</span> },
        { key: 'status', label: 'Status', render: t => t.online ? <Badge tone="ok" dot>Online</Badge> : t.monitored === false ? <Badge tone="plain">No live data</Badge> : <Badge tone="off" dot>Offline</Badge> },
        { key: 'soc', label: 'Battery', render: t => <Soc value={t.battery_soc} /> },
        { key: 'solar', label: 'Solar now', align: 'r', render: t => <span className="num">{fmtWatts(t.solar_watts)}</span> },
        { key: 'yield', label: 'Solar today', align: 'r', render: t => <span className="num">{fmtKwh(t.solar_yield_today)}</span> },
        { key: 'help', label: '', align: 'r', render: t => <button className="btn ghost sm" onClick={() => setReporting({ unit: t.site_id })}>Report a problem</button> },
    ]

    return (
        <Page title={site.name} sub={site.address} crumbs={[{ label: 'My sites', to: '/' }, { label: site.name }]}
            actions={<button className="btn primary" onClick={() => setReporting({})}><Icon name="plus" />Report a problem</button>}>
            <Stats>
                <Stat label="Units" value={site.trailer_count} />
                <Stat label="Online" value={`${site.trailers_online} / ${site.trailers_monitored ?? site.trailer_count}`} dot={site.trailers_online < (site.trailers_monitored ?? site.trailer_count) ? 'warn' : 'ok'} />
                <Stat label="Average battery" value={site.avg_soc != null ? `${site.avg_soc}%` : '—'} />
            </Stats>
            <div className="grid-main">
                <Card title="Units on this site" flush>
                    <DataTable columns={columns} rows={site.trailers || []} rowKey="site_id" empty={<Empty compact>No units on this site right now.</Empty>} />
                </Card>
                <div className="stack">
                    <Card title="Open requests" meta={requests.length || null} flush>
                        {requests.length === 0
                            ? <Empty compact>Nothing open for this site. If something isn’t right, report it and we’ll take a look.</Empty>
                            : <RequestList tickets={requests} />}
                    </Card>
                    {site.primary_contact_name && (
                        <Card title="Site contact">
                            <div style={{ fontWeight: 600 }}>{site.primary_contact_name}</div>
                            {site.primary_contact_phone && <a className="link" href={`tel:${site.primary_contact_phone}`}>{site.primary_contact_phone}</a>}
                        </Card>
                    )}
                    {notes.length > 0 && (
                        <Card title="Updates">
                            {notes.map(n => (
                                <div key={n.id} className="note">
                                    <div className="note-head"><b>{n.author}</b><span>{fmtAgo(n.created_at)}</span></div>
                                    <div className="note-body">{n.note}</div>
                                </div>
                            ))}
                        </Card>
                    )}
                </div>
            </div>
            {reporting && (
                <ReportProblemModal sites={[site]} initial={{ siteId: site.id, unit: reporting.unit }}
                    onClose={() => setReporting(null)}
                    onCreated={(t) => navigate(`/requests/${t.id}`)} />
            )}
        </Page>
    )
}
