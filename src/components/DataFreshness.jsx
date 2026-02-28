import { useState, useEffect } from 'react'

function formatAgo(ts) {
    if (!ts) return null
    const diff = Math.floor((Date.now() - ts) / 1000)
    if (diff < 10) return 'just now'
    if (diff < 60) return `${diff}s ago`
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    return `${Math.floor(diff / 3600)}h ago`
}

export default function DataFreshness({ lastUpdated, intervalMs }) {
    const [, setTick] = useState(0)

    useEffect(() => {
        const timer = setInterval(() => setTick(t => t + 1), 5000)
        return () => clearInterval(timer)
    }, [])

    if (!lastUpdated) return null

    const ago = formatAgo(lastUpdated)
    const isRefreshing = Date.now() - lastUpdated < 2000

    return (
        <div className={`data-freshness ${isRefreshing ? 'freshness-pulse' : ''}`}>
            <span className="freshness-dot" />
            <span className="freshness-text">Updated {ago}</span>
        </div>
    )
}
