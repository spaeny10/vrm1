import { useCallback, useEffect, useState } from 'react'
import { analyzeTrailer } from '../../api/vrm'
import { Drawer, Empty, Icon } from '../../ui'
import { fmtDateTime } from '../../ui/format'

// Runs the AI analysis for one trailer and shows the result in a drawer.
export default function AiDrawer({ siteId, unit, onClose }) {
    const [state, setState] = useState({ loading: true })

    const run = useCallback(() => {
        setState({ loading: true })
        analyzeTrailer(siteId)
            .then(r => setState({ result: r }))
            .catch(err => setState({ error: err.message, notConfigured: /not configured|501/i.test(err.message) }))
    }, [siteId])

    useEffect(() => { run() }, [run])

    return (
        <Drawer title="AI analysis" sub={unit} onClose={onClose}
            actions={!state.loading && !state.notConfigured && <button className="btn sm" onClick={run}><Icon name="refresh" />Run again</button>}>
            {state.loading ? (
                <Empty compact title="Analyzing…">Reviewing live readings, energy history, alarms and network data. This can take up to a minute.</Empty>
            ) : state.notConfigured ? (
                <Empty title="AI assistant not configured">AI analysis needs an Anthropic API key on the server. Ask an administrator to add one; every other part of this page works without it.</Empty>
            ) : state.error ? (
                <Empty title="Analysis failed">{state.error}</Empty>
            ) : (
                <div>
                    <div className="faint" style={{ fontSize: 12.5, marginBottom: 12 }}>Generated {fmtDateTime(state.result.generated_at)}</div>
                    <Markdown text={state.result.analysis || ''} />
                </div>
            )}
        </Drawer>
    )
}

// Minimal, safe markdown: headings, bullets, numbered lists, **bold**.
function inline(text) {
    const parts = String(text).split(/(\*\*[^*]+\*\*)/g)
    return parts.map((p, i) => p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p)
}

function Markdown({ text }) {
    const blocks = []
    let list = null
    const flush = () => { if (list) { blocks.push(list); list = null } }
    text.split('\n').forEach((raw, i) => {
        const line = raw.trimEnd()
        const h = line.match(/^#{1,4}\s+(.*)/)
        const b = line.match(/^\s*[-*•]\s+(.*)/)
        const n = line.match(/^\s*\d+[.)]\s+(.*)/)
        if (h) { flush(); blocks.push(<h4 key={i} style={{ fontSize: 14, fontWeight: 650, margin: '14px 0 6px' }}>{inline(h[1])}</h4>) }
        else if (b || n) {
            const type = b ? 'ul' : 'ol'
            if (!list || list.type !== type) { flush(); list = { type, key: i, items: [] } }
            list.items.push(<li key={i} style={{ marginBottom: 4 }}>{inline((b || n)[1])}</li>)
        } else if (!line.trim()) { flush() }
        else { flush(); blocks.push(<p key={i} style={{ margin: '0 0 8px' }}>{inline(line)}</p>) }
    })
    flush()
    return (
        <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
            {blocks.map(bk => bk.type === 'ul' ? <ul key={bk.key} style={{ margin: '0 0 8px', paddingLeft: 20 }}>{bk.items}</ul>
                : bk.type === 'ol' ? <ol key={bk.key} style={{ margin: '0 0 8px', paddingLeft: 20 }}>{bk.items}</ol> : bk)}
        </div>
    )
}
