import { useCallback, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApiPolling } from '../hooks/useApiPolling'
import { fetchPortalSiteDetail, fetchSiteNotes, addSiteNote, fetchMentionableUsers } from '../api/vrm'
import MentionInput, { renderNoteWithMentions } from '../components/MentionInput'

export default function PortalSiteDetail() {
    const { id } = useParams()
    const navigate = useNavigate()
    const [newNote, setNewNote] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [mentionableUsers, setMentionableUsers] = useState([])
    const mentionInputRef = useRef(null)

    const fetchDetailFn = useCallback(() => fetchPortalSiteDetail(id), [id])
    const { data: detailData, loading: detailLoading } = useApiPolling(fetchDetailFn, 30000)

    const fetchNotesFn = useCallback(async () => {
        const res = await fetchSiteNotes(id)
        return res.notes || []
    }, [id])
    const { data: notesData, refetch: refreshNotes } = useApiPolling(fetchNotesFn, 15000)

    const site = detailData?.site
    const notes = notesData || []

    const handleAddNote = async (e) => {
        if (e) e.preventDefault()
        if (!newNote.trim()) return
        setIsSubmitting(true)
        try {
            // Extract @mentions from note text
            const mentionRegex = /@([\w\s]+?)(?=\s@|\s*$|[.,!?])/g
            const mentions = []
            let match
            while ((match = mentionRegex.exec(newNote)) !== null) {
                const name = match[1].trim()
                // We'll just store the display names; the backend can resolve IDs if needed
                mentions.push(name)
            }
            await addSiteNote(id, newNote, mentions)
            setNewNote('')
            await refreshNotes()
        } catch (err) {
            console.error('Failed to add note', err)
        } finally {
            setIsSubmitting(false)
        }
    }

    if (detailLoading && !site) {
        return <div className="page-loading"><div className="spinner" /></div>
    }
    if (!site) return <div className="page-empty">Site not found</div>

    return (
        <div className="fleet-overview">
            <div className="page-header">
                <button className="btn btn-secondary btn-sm" onClick={() => navigate('/')}>← Back</button>
                <h1>{site.name}</h1>
                {site.uid && <span style={{ marginLeft: '12px', fontSize: '14px', color: 'var(--text-secondary)' }}>UID: {site.uid}</span>}
            </div>

            <div style={{ display: 'flex', gap: '32px', marginBottom: '24px' }}>
                <div style={{ flex: 1 }}>
                    <h3 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>Site Location</h3>
                    {site.address ? <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{site.address}</p> : <p style={{ color: 'var(--text-secondary)', margin: 0 }}>No address specified</p>}
                </div>
                <div style={{ flex: 1 }}>
                    <h3 style={{ margin: '0 0 8px 0', fontSize: '16px' }}>Site Contact</h3>
                    <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
                        {site.primary_contact_name ? `${site.primary_contact_name} ` : ''}
                        {site.primary_contact_phone ? `(${site.primary_contact_phone})` : 'No contact specified'}
                    </p>
                </div>
            </div>

            <div className="kpi-row">
                <div className="kpi-card kpi-green"><div><div className="kpi-label">Trailers Online</div><div className="kpi-value">{site.trailers_online}/{site.trailer_count}</div></div></div>
                <div className="kpi-card kpi-teal"><div><div className="kpi-label">Avg SOC</div><div className="kpi-value">{site.avg_soc != null ? `${site.avg_soc}% ` : '—'}</div></div></div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px', marginTop: 24, alignItems: 'start' }}>
                <div>
                    <h2>Trailers</h2>
                    <div className="maint-table-wrapper">
                        <table className="maint-table">
                            <thead>
                                <tr>
                                    <th>Name</th>
                                    <th>SOC</th>
                                    <th>Solar (W)</th>
                                    <th>Yield Today</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(site.trailers || []).map(t => (
                                    <tr key={t.site_id}>
                                        <td className="maint-title">{t.site_name}</td>
                                        <td>{t.battery_soc != null ? `${t.battery_soc}% ` : '—'}</td>
                                        <td>{t.solar_watts != null ? Math.round(t.solar_watts) : '—'}</td>
                                        <td>{t.solar_yield_today != null ? `${t.solar_yield_today.toFixed(2)} kWh` : '—'}</td>
                                        <td>
                                            <span className={`alarm-badge alarm-${t.battery_soc == null ? 'offline' : t.battery_soc < 20 ? 'critical' : t.battery_soc < 50 ? 'warning' : 'ok'}`}>
                                                {t.battery_soc == null ? 'OFFLINE' : t.battery_soc < 20 ? 'CRITICAL' : t.battery_soc < 50 ? 'WARNING' : 'OK'}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                                {(site.trailers || []).length === 0 && (
                                    <tr><td colSpan="5" style={{ textAlign: 'center', padding: '16px', color: 'var(--text-secondary)' }}>No trailers assigned</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="card">
                    <h2 style={{ margin: '0 0 16px 0', fontSize: '18px' }}>Communication & Notes</h2>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '400px', overflowY: 'auto', marginBottom: '16px', paddingRight: '4px' }}>
                        {notes.length === 0 ? (
                            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', fontStyle: 'italic', textAlign: 'center', margin: '24px 0' }}>No notes yet.</p>
                        ) : (
                            notes.map(note => (
                                <div key={note.id} style={{ background: 'var(--bg-secondary)', padding: '12px', borderRadius: '6px', fontSize: '14px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                                        <span style={{ fontWeight: 600 }}>{note.author}</span>
                                        <span>{new Date(Number(note.created_at)).toLocaleString()}</span>
                                    </div>
                                    <div style={{ whiteSpace: 'pre-wrap' }}>{renderNoteWithMentions(note.note)}</div>
                                </div>
                            ))
                        )}
                    </div>

                    <form onSubmit={handleAddNote} style={{ display: 'flex', gap: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                        <MentionInput
                            value={newNote}
                            onChange={setNewNote}
                            onSubmit={handleAddNote}
                            disabled={isSubmitting}
                            placeholder="Type a note... Use @name to mention"
                        />
                        <button type="submit" className="btn btn-primary" disabled={!newNote.trim() || isSubmitting}>
                            {isSubmitting ? '...' : 'Send'}
                        </button>
                    </form>
                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px', textAlign: 'center' }}>
                        Messages are shared with the fleet management team. You can also reply to SMS alerts directly.
                    </p>
                </div>
            </div>
        </div>
    )
}
