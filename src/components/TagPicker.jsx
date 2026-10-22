import { useState, useRef, useEffect } from 'react'
import { Icon } from '../ui'

export const NOTE_CATEGORIES = ['battery', 'solar', 'network', 'maintenance', 'security', 'general']

// Tags are stored on notes as [{ type: 'trailer', id, label } | { type: 'category', label }]
export function parseTags(tags) {
    if (!tags) return []
    if (typeof tags === 'string') {
        try { return JSON.parse(tags) || [] } catch { return [] }
    }
    return Array.isArray(tags) ? tags : []
}

const same = (a, b) => a.type === b.type && (a.type === 'trailer' ? a.id === b.id : a.label === b.label)

// Tag a note with trailers on the site and/or a category.
// trailers: [{ site_id, label }] (label falls back to unit / site_name)
export default function TagPicker({ trailers = [], selectedTags = [], onTagsChange }) {
    const [open, setOpen] = useState(false)
    const ref = useRef(null)

    useEffect(() => {
        if (!open) return
        const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
        const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', esc, true)
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc, true) }
    }, [open])

    const isOn = tag => selectedTags.some(t => same(t, tag))
    const toggle = tag => onTagsChange(isOn(tag) ? selectedTags.filter(t => !same(t, tag)) : [...selectedTags, tag])

    const trailerTags = trailers.map(t => ({ type: 'trailer', id: t.site_id, label: t.label || t.unit || t.site_name || String(t.site_id) }))
    const categoryTags = NOTE_CATEGORIES.map(c => ({ type: 'category', label: c }))

    return (
        <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn sm" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <Icon name="plus" />Tag{selectedTags.length > 0 && <span className="faint">({selectedTags.length})</span>}
            </button>
            {selectedTags.map(tag => (
                <button key={`${tag.type}-${tag.id ?? tag.label}`} type="button" className={`badge ${tag.type === 'trailer' ? 'info' : 'plain'}`}
                    style={{ border: 0, cursor: 'pointer' }} onClick={() => toggle(tag)} title="Remove tag">
                    {tag.label}<Icon name="x" size={11} />
                </button>
            ))}
            {open && (
                <div style={{
                    position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 120, width: 280,
                    background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)',
                    boxShadow: 'var(--shadow)', padding: 12, display: 'grid', gap: 12,
                }}>
                    {trailerTags.length > 0 && <TagGroup title="Trailers" tags={trailerTags} isOn={isOn} toggle={toggle} />}
                    <TagGroup title="Topic" tags={categoryTags} isOn={isOn} toggle={toggle} />
                </div>
            )}
        </div>
    )
}

function TagGroup({ title, tags, isOn, toggle }) {
    return (
        <div>
            <div className="faint" style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{title}</div>
            <div className="chips">
                {tags.map(tag => (
                    <button key={tag.id ?? tag.label} type="button" className={`chip ${isOn(tag) ? 'on' : ''}`} style={{ height: 26, fontSize: 12.5 }} onClick={() => toggle(tag)}>
                        {isOn(tag) && <Icon name="check" size={12} />}{tag.label}
                    </button>
                ))}
            </div>
        </div>
    )
}
