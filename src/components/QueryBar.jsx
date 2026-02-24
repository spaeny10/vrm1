import { useState } from 'react'
import { fetchQuery } from '../api/vrm'

export default function QueryBar() {
    const [query, setQuery] = useState('')
    const [result, setResult] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (!query.trim()) return

        setLoading(true)
        setError(null)
        setResult(null)

        try {
            const data = await fetchQuery(query)
            setResult(data)
        } catch (err) {
            console.error('Query failed:', err)
            setError('Failed to get answer. Please try again.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="query-bar-container">
            <form onSubmit={handleSubmit} className="query-form">
                <div className="query-input-wrapper">
                    <span className="query-icon">✨</span>
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Ask anything about your fleet... (e.g. 'which trailers have low battery?')"
                        className="query-input"
                        disabled={loading}
                    />
                    <button type="submit" className="query-submit" disabled={loading || !query.trim()}>
                        {loading ? 'Thinking...' : 'Ask Claude'}
                    </button>
                </div>
            </form>

            {(result || error) && (
                <div className="query-result-card animate-in">
                    {error ? (
                        <div className="query-error">{error}</div>
                    ) : (
                        <>
                            <div className="query-answer">
                                {result.answer}
                            </div>
                            {result.data && result.data.length > 0 && (
                                <div className="query-data-table-wrapper">
                                    <table className="query-data-table">
                                        <thead>
                                            <tr>
                                                {Object.keys(result.data[0]).map(key => (
                                                    <th key={key}>{key.replace(/_/g, ' ')}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {result.data.slice(0, 5).map((row, i) => (
                                                <tr key={i}>
                                                    {Object.values(row).map((val, j) => (
                                                        <td key={j}>{typeof val === 'boolean' ? (val ? 'Yes' : 'No') : val}</td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {result.data.length > 5 && (
                                        <div className="query-data-more">
                                            And {result.data.length - 5} more rows...
                                        </div>
                                    )}
                                </div>
                            )}
                            <div className="query-footer">
                                <button className="query-clear" onClick={() => { setResult(null); setQuery(''); }}>Clear</button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}
