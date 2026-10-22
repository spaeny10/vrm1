import { useCallback, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useToast } from '../components/ToastProvider'
import { fetchPortalSiteDetail, apiGet, apiPost } from '../api/vrm'
import { Page, Card, Stats, Stat, DataTable, Badge, Soc, Empty, Loading } from '../ui'
import { fmtAgo, fmtKwh, fmtWatts } from '../ui/format'

// Customer view of one site: unit status and a message thread with
// BIGView (only notes shared with the customer appear here).
export default function PortalSiteDetail() {
    const { id } = useParams()
    const toast = useToast()
    const siteFn = useCallback(() => fetchPortalSiteDetail(id), [id])
    const notesFn = useCallback(() => apiGet(`/portal/site/${id}/notes`), [id])
    const { data, loading } = useApiPolling(siteFn, 60000)
    const { data: notesData, refetch: refetchNotes } = useApiPolling(notesFn, 30000)
    const [message, setMessage] = useState('')
    const [sending, setSending] = useState(false)

    const site = data?.site
    const notes = notesData?.notes || []

    const send = async (e) => {
        e.preventDefault()
        if (!message.trim()) return
        setSending(true)
        try {
            await apiPost(`/portal/site/${id}/notes`, { note: message.trim() })
            setMessage('')
            refetchNotes()
            toast.success('Message sent to BIGView')
        } catch (err) { toast.error(err.message) } finally { setSending(false) }
    }

    if (loading && !data) return <Loading />
    if (!site) return <Empty title="Site not available">You may not have access to this site.</Empty>

    const columns = [
        { key: 'unit', label: 'Unit', render: t => <span className="primary">{t.site_name}</span> },
        { key: 'status', label: 'Status', render: t => t.online ? <Badge tone="ok" dot>Online</Badge> : <Badge tone="off" dot>Offline</Badge> },
        { key: 'soc', label: 'Battery', render: t => <Soc value={t.battery_soc} /> },
        { key: 'solar', label: 'Solar now', align: 'r', render: t => <span className="num">{fmtWatts(t.solar_watts)}</span> },
        { key: 'yield', label: 'Solar today', align: 'r', render: t => <span className="num">{fmtKwh(t.solar_yield_today)}</span> },
    ]

    return (
        <Page title={site.name} sub={site.address} crumbs={[{ label: 'My sites', to: '/' }, { label: site.name }]}>
            <Stats>
                <Stat label="Units" value={site.trailer_count} />
                <Stat label="Online" value={`${site.trailers_online} / ${site.trailer_count}`} dot={site.trailers_online < site.trailer_count ? 'warn' : 'ok'} />
                <Stat label="Average battery" value={site.avg_soc != null ? `${site.avg_soc}%` : '—'} />
            </Stats>
            <div className="grid-main">
                <Card title="Units on this site" flush>
                    <DataTable columns={columns} rows={site.trailers || []} rowKey="site_id" empty={<Empty compact>No units on this site right now.</Empty>} />
                </Card>
                <div className="stack">
                    {site.primary_contact_name && (
                        <Card title="Site contact">
                            <div style={{ fontWeight: 600 }}>{site.primary_contact_name}</div>
                            {site.primary_contact_phone && <a className="link" href={`tel:${site.primary_contact_phone}`}>{site.primary_contact_phone}</a>}
                        </Card>
                    )}
                    <Card title="Messages">
                        <form onSubmit={send} className="form" style={{ marginBottom: 8 }}>
                            <textarea className="textarea" rows={3} value={message} onChange={e => setMessage(e.target.value)} placeholder="Send a message to the BIGView team about this site…" maxLength={4000} />
                            <button className="btn primary" disabled={sending || !message.trim()}>{sending ? 'Sending…' : 'Send'}</button>
                        </form>
                        {notes.length === 0 ? <p className="faint" style={{ fontSize: 13 }}>No messages yet.</p> : notes.map(n => (
                            <div key={n.id} className="note">
                                <div className="note-head"><b>{n.author}</b><span>{fmtAgo(n.created_at)}</span></div>
                                <div className="note-body">{n.note}</div>
                            </div>
                        ))}
                    </Card>
                </div>
            </div>
        </Page>
    )
}
