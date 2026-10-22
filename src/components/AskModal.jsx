import { useState } from 'react'
import { fetchQuery } from '../api/vrm'
import { Modal, Icon } from '../ui'

const SUGGESTIONS = [
    'Which trailers are below 30% battery?',
    'How many trailers does Acme Construction have on rent?',
    'Which sites had the most maintenance cost this month?',
    'Which trailers used the most data yesterday?',
]

// JSON/array cells from SQL results must render as text, not React children
function cell(v) {
    if (v == null) return '—'
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
}

export default function AskModal({ onClose }) {
    const [question, setQuestion] = useState('')
    const [result, setResult] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)

    const ask = async (q) => {
        const text = (q ?? question).trim()
        if (!text) return
        setQuestion(text)
        setLoading(true); setError(null); setResult(null)
        try {
            setResult(await fetchQuery(text))
        } catch (err) {
            setError(err.message === 'Claude API key not configured' ? 'The AI assistant is not configured on this server.' : err.message)
        } finally {
            setLoading(false)
        }
    }

    const rows = result?.data || []
    const cols = rows.length ? Object.keys(rows[0]).slice(0, 6) : []

    return (
        <Modal title="Ask the fleet" onClose={onClose} wide>
            <form onSubmit={e => { e.preventDefault(); ask() }} style={{ display: 'flex', gap: 8 }}>
                <input className="input" autoFocus value={question} onChange={e => setQuestion(e.target.value)} placeholder="Ask anything about trailers, sites, rentals or maintenance…" disabled={loading} />
                <button className="btn primary" disabled={loading || !question.trim()}><Icon name="sparkle" />{loading ? 'Thinking…' : 'Ask'}</button>
            </form>

            {!result && !error && !loading && (
                <div className="chips" style={{ marginTop: 14 }}>
                    {SUGGESTIONS.map(s => <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>)}
                </div>
            )}

            {error && <div className="callout crit" style={{ marginTop: 14 }}>{error}</div>}

            {result && (
                <div className="ask-result">
                    {result.answer}
                    {rows.length > 0 && (
                        <div className="table-wrap card" style={{ marginTop: 12 }}>
                            <table className="table">
                                <thead><tr>{cols.map(c => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
                                <tbody>
                                    {rows.slice(0, 10).map((r, i) => <tr key={i}>{cols.map(c => <td key={c}>{cell(r[c])}</td>)}</tr>)}
                                </tbody>
                            </table>
                            {rows.length > 10 && <div className="card-foot">Showing 10 of {rows.length} rows</div>}
                        </div>
                    )}
                </div>
            )}
        </Modal>
    )
}
