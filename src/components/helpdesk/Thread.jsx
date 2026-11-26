import { Badge } from '../../ui'
import { fmtAgo, fmtDateTime } from '../../ui/format'

// A request's conversation. `viewer` decides whose messages are "ours":
// on the desk our replies are tinted, in the portal BIGView's are.
export default function Thread({ messages, viewer = 'staff', empty }) {
    if (!messages?.length) return <p className="faint" style={{ fontSize: 13 }}>{empty || 'No messages yet.'}</p>
    return (
        <div className="thread">
            {messages.map(m => {
                const role = m.author_role ?? m.role
                const author = m.author_name ?? m.author
                if (role === 'system') {
                    return <div key={m.id} className="msg-system" title={fmtDateTime(m.created_at)}>{m.body} · {fmtAgo(m.created_at)}</div>
                }
                const kind = m.internal ? 'internal' : role === 'staff' ? 'ours' : ''
                return (
                    <div key={m.id} className={`msg ${kind}`}>
                        <div className="msg-head">
                            <b>{author || (role === 'customer' ? 'Customer' : 'BIGView')}</b>
                            {viewer === 'staff' && role === 'customer' && <Badge tone="plain">Customer</Badge>}
                            {m.internal && <Badge tone="warn">Internal note</Badge>}
                            {viewer === 'staff' && role === 'staff' && !m.internal && <Badge tone="info">Sent to customer</Badge>}
                            <span className="when" title={fmtDateTime(m.created_at)}>{fmtAgo(m.created_at)}</span>
                        </div>
                        <div className="msg-body">{m.body}</div>
                    </div>
                )
            })}
        </div>
    )
}
