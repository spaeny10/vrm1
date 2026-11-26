import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { useToast } from '../components/ToastProvider'
import { apiGet, apiPost } from '../api/vrm'
import { Page, Card, Badge, Empty, Loading } from '../ui'
import { TICKET_STATUS, fmtDateTime } from '../ui/format'
import Thread from '../components/helpdesk/Thread'

// Customer portal: one request and its conversation with BIGView
export default function PortalRequestDetail() {
    const { id } = useParams()
    const toast = useToast()
    const fetchFn = useCallback(() => apiGet(`/portal/tickets/${id}`), [id])
    const { data, loading, refetch } = useApiPolling(fetchFn, 30000)
    const [body, setBody] = useState('')
    const [sending, setSending] = useState(false)

    if (loading && !data) return <Loading />
    if (!data?.ticket) {
        return (
            <Page title="Request not found" crumbs={[{ label: 'Requests', to: '/requests' }, { label: `#${id}` }]}>
                <Empty title="We couldn't find this request"><Link to="/requests" className="link">Back to your requests</Link></Empty>
            </Page>
        )
    }

    const { ticket: t, messages } = data
    const st = TICKET_STATUS[t.status] || TICKET_STATUS.open
    const resolved = t.status === 'resolved'

    const send = async (e) => {
        e.preventDefault()
        if (!body.trim()) return
        setSending(true)
        try {
            await apiPost(`/portal/tickets/${t.id}/messages`, { body: body.trim() })
            setBody('')
            await refetch()
            toast.success('Sent to BIGView')
        } catch (err) { toast.error(err.message) } finally { setSending(false) }
    }

    return (
        <Page
            crumbs={[{ label: 'Requests', to: '/requests' }, { label: `#${t.id}` }]}
            title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>{t.subject}<Badge tone={st.tone}>{st.customer}</Badge></span>}
            sub={[t.trailer_unit, t.job_site_name, `opened ${fmtDateTime(t.created_at)}`].filter(Boolean).join(' · ')}>
            {t.status === 'waiting' && <div className="callout warn"><div><b>We’re waiting on you.</b> Reply below so we can keep going.</div></div>}
            <Card title="Conversation">
                <Thread viewer="customer" messages={messages}
                    empty={t.source === 'portal' ? 'No messages yet.' : 'The BIGView team logged this for you. Updates will appear here.'} />
                <form className="composer" onSubmit={send}>
                    <textarea className="textarea" rows={3} value={body} onChange={e => setBody(e.target.value)} maxLength={4000}
                        placeholder={resolved ? 'Still not right? Reply to reopen this request…' : 'Add a message for the BIGView team…'} />
                    <div className="composer-foot">
                        <span className="hint">{resolved ? `Resolved ${fmtDateTime(t.resolved_at)}.` : 'We’ll reply here and by email.'}</span>
                        <button className="btn primary" disabled={sending || !body.trim()}>{sending ? 'Sending…' : resolved ? 'Reply and reopen' : 'Send'}</button>
                    </div>
                </form>
            </Card>
        </Page>
    )
}
