import { useState } from 'react'
import { fetchQuery, semanticSearch } from '../api/vrm'

export default function QueryBar() {
    const [query, setQuery] = useState('')
    const [result, setResult] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [searchMode, setSearchMode] = useState('semantic') // 'semantic' or 'sql'

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (!query.trim()) return

        setLoading(true)
        setError(null)
        setResult(null)

        try {
            const data = searchMode === 'semantic'
                ? await semanticSearch(query)
                : await fetchQuery(query)
            setResult(data)
        } catch (err) {
            console.error('Query failed:', err)
            setError(err.message || 'Failed to get answer. Please try again.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="query-bar-container">
            <form onSubmit={handleSubmit} className="query-form">
                <div className="query-mode-toggle" style={{ marginBottom: '10px', display: 'flex', gap: '10px', justifyContent: 'center' }}>
                    <button
                        type="button"
                        className={searchMode === 'semantic' ? 'mode-btn active' : 'mode-btn'}
                        onClick={() => setSearchMode('semantic')}
                        style={{
                            padding: '6px 16px',
                            borderRadius: '6px',
                            border: '1px solid #444',
                            background: searchMode === 'semantic' ? '#4a9eff' : '#2a2a2a',
                            color: '#fff',
                            cursor: 'pointer',
                            fontSize: '13px',
                            fontWeight: searchMode === 'semantic' ? '600' : '400'
                        }}
                    >
                        🔍 Semantic Search
                    </button>
                    <button
                        type="button"
                        className={searchMode === 'sql' ? 'mode-btn active' : 'mode-btn'}
                        onClick={() => setSearchMode('sql')}
                        style={{
                            padding: '6px 16px',
                            borderRadius: '6px',
                            border: '1px solid #444',
                            background: searchMode === 'sql' ? '#4a9eff' : '#2a2a2a',
                            color: '#fff',
                            cursor: 'pointer',
                            fontSize: '13px',
                            fontWeight: searchMode === 'sql' ? '600' : '400'
                        }}
                    >
                        💾 SQL Query
                    </button>
                </div>
                <div className="query-input-wrapper">
                    <span className="query-icon">✨</span>
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={searchMode === 'semantic'
                            ? "Search: 'trailers offline', 'weak signal', 'low battery'..."
                            : "Ask: 'which trailers have low battery?'"}
                        className="query-input"
                        disabled={loading}
                    />
                    <button type="submit" className="query-submit" disabled={loading || !query.trim()}>
                        {loading ? 'Searching...' : searchMode === 'semantic' ? 'Search' : 'Ask Claude'}
                    </button>
                </div>
            </form>

            {(result || error) && (
                <div className="query-result-card animate-in">
                    {error ? (
                        <div className="query-error">{error}</div>
                    ) : (
                        <>
                            <div className="query-answer" style={{ whiteSpace: 'pre-wrap' }}>
                                {result.answer}
                            </div>

                            {/* Semantic search results */}
                            {searchMode === 'semantic' && result.results && result.results.length > 0 && (
                                <div className="semantic-results" style={{ marginTop: '16px' }}>
                                    <div style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>
                                        Found {result.count} matching result{result.count !== 1 ? 's' : ''}
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                        {result.results.slice(0, 5).map((item, i) => (
                                            <div key={i} style={{
                                                padding: '10px',
                                                background: '#2a2a2a',
                                                borderRadius: '6px',
                                                fontSize: '13px',
                                                borderLeft: '3px solid #4a9eff'
                                            }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                                    <span style={{ fontWeight: '600', color: '#4a9eff' }}>
                                                        {item.type === 'site' ? '⚡ Site' : item.type === 'device' ? '📡 Device' : '⚠️ Alert'}
                                                    </span>
                                                    <span style={{ fontSize: '11px', color: '#666' }}>
                                                        {(item.similarity * 100).toFixed(0)}% match
                                                    </span>
                                                </div>
                                                <div style={{ color: '#ddd' }}>{item.text}</div>
                                            </div>
                                        ))}
                                        {result.count > 5 && (
                                            <div style={{ fontSize: '12px', color: '#666', textAlign: 'center', marginTop: '4px' }}>
                                                + {result.count - 5} more results
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* SQL query results (table) */}
                            {searchMode === 'sql' && result.data && result.data.length > 0 && (
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
