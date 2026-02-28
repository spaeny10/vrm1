export function signalQuality(rsrp) {
    if (rsrp === null || rsrp === undefined) return { label: 'Unknown', color: '#888' }
    if (rsrp >= -80) return { label: 'Excellent', color: '#2ecc71' }
    if (rsrp >= -90) return { label: 'Good', color: '#27ae60' }
    if (rsrp >= -100) return { label: 'Fair', color: '#f1c40f' }
    if (rsrp >= -110) return { label: 'Poor', color: '#e67e22' }
    return { label: 'Weak', color: '#e74c3c' }
}

export function formatUptime(seconds) {
    if (!seconds) return '—'
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    if (d > 0) return `${d}d ${h}h`
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h ${m}m`
}

export function formatMB(mb) {
    if (!mb && mb !== 0) return '—'
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
    return `${Math.round(mb)} MB`
}

export function formatDuration(ms) {
    if (!ms) return '—'
    const totalMin = Math.floor(ms / 60000)
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    if (h >= 24) {
        const d = Math.floor(h / 24)
        return `${d}d ${h % 24}h`
    }
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
}
