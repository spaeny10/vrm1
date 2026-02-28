import { useState, useEffect } from 'react'

function formatAgo(ts) {
    if (!ts) return null
    const diff = Math.floor((Date.now() - ts) / 1000)
    if (diff < 10) return 'just now'
    if (diff < 60) return `${diff}s ago`
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    return `${Math.floor(diff / 3600)}h ago`
}

export default function DataFreshness({ lastUpdated, refetch }) {
    const [, setTick] = useState(0)
    const [refreshing, setRefreshing] = useState(false)

    useEffect(() => {
        const timer = setInterval(() => setTick(t => t + 1), 5000)
        return () => clearInterval(timer)
    }, [])

    if (!lastUpdated) return null

    const ago = formatAgo(lastUpdated)
    const isRefreshing = refreshing || Date.now() - lastUpdated < 2000

    const handleRefresh = async () => {
        if (!refetch || refreshing) return
        setRefreshing(true)
        try {
            await refetch()
        } finally {
            setRefreshing(false)
        }
    }

    return (
        <div className={`data-freshness ${isRefreshing ? 'freshness-pulse' : ''}`}>
            <span className="freshness-dot" />
            <span className="freshness-text">Updated {ago}</span>
            {refetch && (
                <button
                    className={`freshness-refresh-btn ${refreshing ? 'spinning' : ''}`}
                    onClick={handleRefresh}
                    title="Refresh now"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M23 4v6h-6M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                </button>
            )}
        </div>
    )
}
