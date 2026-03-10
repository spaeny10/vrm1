import { useState, useRef, useEffect } from 'react'

const CATEGORIES = ['battery', 'solar', 'network', 'maintenance', 'security', 'general']

export default function TagPicker({ trailers = [], selectedTags = [], onTagsChange }) {
    const [open, setOpen] = useState(false)
    const ref = useRef(null)

    useEffect(() => {
        const handleClick = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false)
        }
        document.addEventListener('mousedown', handleClick)
        return () => document.removeEventListener('mousedown', handleClick)
    }, [])

    const isSelected = (tag) => {
        if (tag.type === 'trailer') return selectedTags.some(t => t.type === 'trailer' && t.id === tag.id)
        return selectedTags.some(t => t.type === 'category' && t.label === tag.label)
    }

    const toggle = (tag) => {
        if (isSelected(tag)) {
            onTagsChange(selectedTags.filter(t =>
                tag.type === 'trailer'
                    ? !(t.type === 'trailer' && t.id === tag.id)
                    : !(t.type === 'category' && t.label === tag.label)
            ))
        } else {
            onTagsChange([...selectedTags, tag])
        }
    }

    return (
        <div className="tag-picker" ref={ref}>
            <button type="button" className="tag-picker-btn" onClick={() => setOpen(!open)}>
                Tags{selectedTags.length > 0 && ` (${selectedTags.length})`}
            </button>

            {open && (
                <div className="tag-picker-dropdown">
                    {trailers.length > 0 && (
                        <div className="tag-picker-section">
                            <div className="tag-picker-section-title">Trailers</div>
                            {trailers.map(t => {
                                const tag = { type: 'trailer', id: t.site_id, label: t.site_name }
                                return (
                                    <label key={t.site_id} className="tag-picker-item">
                                        <input type="checkbox" checked={isSelected(tag)} onChange={() => toggle(tag)} />
                                        <span>{t.site_name}</span>
                                    </label>
                                )
                            })}
                        </div>
                    )}
                    <div className="tag-picker-section">
                        <div className="tag-picker-section-title">Categories</div>
                        {CATEGORIES.map(cat => {
                            const tag = { type: 'category', label: cat }
                            return (
                                <label key={cat} className="tag-picker-item">
                                    <input type="checkbox" checked={isSelected(tag)} onChange={() => toggle(tag)} />
                                    <span>{cat}</span>
                                </label>
                            )
                        })}
                    </div>
                </div>
            )}

            {selectedTags.length > 0 && (
                <div className="tag-picker-selected">
                    {selectedTags.map((tag, i) => (
                        <span key={i} className={`tag-chip tag-chip-${tag.type}`} onClick={() => toggle(tag)}>
                            {tag.label}
                            <span className="tag-chip-remove">&times;</span>
                        </span>
                    ))}
                </div>
            )}
        </div>
    )
}
