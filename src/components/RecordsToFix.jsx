import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, Dot } from '../ui'
import { plural } from '../ui/format'

const TITLES = {
    no_telemetry: 'Can’t be monitored',
    duplicate_registry: 'Two registry entries',
    duplicate_vrm: 'Two VRM installations',
    duplicate_router: 'Two routers',
    same_name: 'Two trailers share a name',
    link_mismatch: 'Names don’t match',
    unplaced: 'No site or rental',
    shop_by_name: 'Out of service by name only',
    no_hq: 'No headquarters site',
}

// Places where the registry, VRM and InControl disagree and the app had to
// guess. Each one says what it assumed and how to make the records right.
// Renders nothing when the records are clean.
export default function RecordsToFix({ issues = [], limit = 3 }) {
    const [all, setAll] = useState(false)
    if (!issues.length) return null
    const sorted = [...issues].sort((a, b) => Number(!!a.minor) - Number(!!b.minor))
    const shown = all ? sorted : sorted.slice(0, limit)
    const major = issues.filter(i => !i.minor).length

    return (
        <Card title="Records to fix" meta={issues.length} flush
            actions={issues.length > limit && <button className="btn sm ghost" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${issues.length}`}</button>}
            foot={major ? null : 'Nothing here hides a problem. These are assumptions worth confirming.'}>
            <div className="list">
                {shown.map((i, n) => {
                    const body = (
                        <>
                            <Dot tone={i.minor ? 'off' : 'warn'} />
                            <div className="main">
                                <div className="title">{i.unit || 'Setup'} <span className="faint" style={{ fontWeight: 400 }}>{TITLES[i.type] || ''}</span></div>
                                <div className="desc">{i.detail}</div>
                                <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>{i.fix}</div>
                            </div>
                        </>
                    )
                    return i.site_id != null
                        ? <Link key={n} to={`/trailer/${i.site_id}`} className="list-row">{body}</Link>
                        : <div key={n} className="list-row">{body}</div>
                })}
            </div>
            {!all && issues.length > limit && (
                <div className="faint" style={{ padding: '10px 18px', fontSize: 12.5, borderTop: '1px solid var(--border)' }}>
                    {plural(issues.length - limit, 'more record')} to review.
                </div>
            )}
        </Card>
    )
}
