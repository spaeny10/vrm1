import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApiPolling } from '../../hooks/useApiPolling'
import { fetchTrailerNotes, fetchReplies } from '../../api/vrm'
import { Card, Badge, Empty, Loading } from '../../ui'
import { fmtAgo, fmtDateTime } from '../../ui/format'

function parseList(v) {
    if (!v) return []
    if (Array.isArray(v)) return v
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : [] } catch { return [] }
}

// Notes: site notes tagged with this trailer. Read-only here; people
// post and reply on the site page so the conversation stays in one place.
export default function NotesTab({ siteId, site }) {
    const fn = useCallback(() => fetchTrailerNotes(siteId, 50, 0), [siteId])
    const { data, loading, error } = useApiPolling(fn, 120000)
    const [open, setOpen] = useState({}) // noteId -> replies[] | 'loading'
    const notes = data?.notes || []

    const toggle = async (n) => {
        if (open[n.id]) { setOpen(o => { const c = { ...o }; delete c[n.id]; return c }); return }
        setOpen(o => ({ ...o, [n.id]: 'loading' }))
        try {
            const r = await fetchReplies(n.job_site_id, n.id)
            setOpen(o => ({ ...o, [n.id]: r?.replies || [] }))
        } catch {
            setOpen(o => ({ ...o, [n.id]: [] }))
        }
    }

    return (
        <Card title="Notes tagged with this trailer" meta={data?.total ? data.total : null}
            actions={site && <Link to={`/site/${site.id}`} className="btn sm">Add a note on {site.name}</Link>}>
            {loading && !data ? <Loading /> : error && !data ? <Empty compact title="Couldn't load notes">{error}</Empty> : notes.length === 0 ? (
                <Empty compact title="No notes yet">
                    Notes on a site that tag this trailer show up here.{site && <> Post one from <Link to={`/site/${site.id}`} className="link">{site.name}</Link>.</>}
                </Empty>
            ) : (
                <div>
                    {notes.map(n => {
                        const tags = parseList(n.tags).filter(t => !(t.type === 'trailer' && Number(t.id) === siteId))
                        const replies = Number(n.reply_count) || 0
                        const thread = open[n.id]
                        return (
                            <div key={n.id} className="note">
                                <div className="note-head">
                                    <b>{n.author || 'System'}</b>
                                    <span title={fmtDateTime(Number(n.created_at))}>{fmtAgo(Number(n.created_at))}</span>
                                    {n.job_site_name && <><span>·</span><Link to={`/site/${n.job_site_id}`} className="link">{n.job_site_name}</Link></>}
                                    {n.pinned && <Badge tone="info">Pinned</Badge>}
                                </div>
                                <div className="note-body">{n.note}</div>
                                {tags.length > 0 && (
                                    <div className="btn-row" style={{ marginTop: 6 }}>
                                        {tags.map((t, i) => t.type === 'trailer'
                                            ? <Link key={i} to={`/trailer/${t.id}`}><Badge tone="plain">{t.label}</Badge></Link>
                                            : <Badge key={i} tone="plain">{t.label}</Badge>)}
                                    </div>
                                )}
                                {replies > 0 && (
                                    <button className="btn ghost sm" style={{ marginTop: 6, paddingLeft: 0 }} onClick={() => toggle(n)}>
                                        {thread ? 'Hide replies' : `${replies} ${replies === 1 ? 'reply' : 'replies'}`}
                                    </button>
                                )}
                                {thread === 'loading' && <div className="faint" style={{ fontSize: 12.5, marginLeft: 16 }}>Loading…</div>}
                                {Array.isArray(thread) && (
                                    <div style={{ marginLeft: 16, paddingLeft: 12, borderLeft: '2px solid var(--border)' }}>
                                        {thread.length === 0 ? <div className="faint" style={{ fontSize: 12.5, padding: '6px 0' }}>No replies found.</div> : thread.map(r => (
                                            <div key={r.id} className="note">
                                                <div className="note-head"><b>{r.author || 'System'}</b><span>{fmtAgo(Number(r.created_at))}</span></div>
                                                <div className="note-body">{r.note}</div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </Card>
    )
}
