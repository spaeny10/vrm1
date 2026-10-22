import { useState, useRef, useEffect, useMemo } from 'react'
import { fetchMentionableUsers } from '../api/vrm'

// ============================================================
// Text input with @mention autocomplete.
// Props: value, onChange(text), onSubmit(e), disabled, placeholder,
//   users     — optional [{id, display_name, role}]; fetched when omitted
//   multiline — textarea (Ctrl/Cmd+Enter submits) instead of one line (Enter submits)
//   autoFocus, rows
// ============================================================
export default function MentionInput({ value, onChange, onSubmit, disabled, placeholder, users: usersProp, multiline, autoFocus, rows = 3 }) {
    const [fetched, setFetched] = useState([])
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [start, setStart] = useState(-1)
    const [idx, setIdx] = useState(0)
    const ref = useRef(null)

    useEffect(() => {
        if (usersProp) return
        let alive = true
        fetchMentionableUsers()
            .then(res => { if (alive) setFetched(res?.users || []) })
            .catch(() => { })
        return () => { alive = false }
    }, [usersProp])

    const users = usersProp || fetched
    const matches = useMemo(() => {
        const q = query.toLowerCase()
        return users.filter(u => u.display_name?.toLowerCase().includes(q)).slice(0, 6)
    }, [users, query])

    const handleChange = (e) => {
        const val = e.target.value
        const cursor = e.target.selectionStart
        onChange(val)
        const before = val.slice(0, cursor)
        const at = before.lastIndexOf('@')
        if (at >= 0 && (at === 0 || /\s/.test(before[at - 1]))) {
            const q = before.slice(at + 1)
            // Allow one space so "Casey B" still narrows; stop at a newline or second space
            if (!/\n/.test(q) && (q.match(/ /g) || []).length <= 1) {
                setStart(at); setQuery(q); setIdx(0); setOpen(true)
                return
            }
        }
        setOpen(false)
    }

    const insert = (user) => {
        const cursor = ref.current?.selectionStart ?? (start + query.length + 1)
        const before = value.slice(0, start)
        const after = value.slice(cursor)
        onChange(`${before}@${user.display_name} ${after}`)
        setOpen(false)
        setTimeout(() => {
            const pos = before.length + user.display_name.length + 2
            ref.current?.focus()
            ref.current?.setSelectionRange(pos, pos)
        }, 0)
    }

    const handleKeyDown = (e) => {
        if (open && matches.length > 0) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, matches.length - 1)); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); return }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(matches[idx]); return }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return }
        }
        if (e.key === 'Enter') {
            if (!multiline && !e.shiftKey) { e.preventDefault(); onSubmit?.(e) }
            else if (multiline && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit?.(e) }
        }
    }

    const common = {
        ref, value, disabled, autoFocus,
        onChange: handleChange,
        onKeyDown: handleKeyDown,
        onBlur: () => setTimeout(() => setOpen(false), 150),
        placeholder: placeholder || 'Write a note… type @ to mention someone',
    }

    return (
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            {multiline
                ? <textarea className="textarea" rows={rows} {...common} />
                : <input type="text" className="input" {...common} />}
            {open && matches.length > 0 && (
                <div role="listbox" style={{
                    position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, zIndex: 120,
                    background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)',
                    boxShadow: 'var(--shadow)', overflow: 'hidden',
                }}>
                    {matches.map((u, i) => (
                        <div key={u.id} role="option" aria-selected={i === idx}
                            onMouseDown={e => { e.preventDefault(); insert(u) }}
                            onMouseEnter={() => setIdx(i)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', fontSize: 13.5,
                                background: i === idx ? 'var(--surface-3)' : 'transparent',
                            }}>
                            <span style={{
                                width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0,
                                background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 11, fontWeight: 700,
                            }}>{u.display_name.charAt(0).toUpperCase()}</span>
                            <span style={{ fontWeight: 550 }}>{u.display_name}</span>
                            <span className="faint" style={{ marginLeft: 'auto', fontSize: 12, textTransform: 'capitalize' }}>{u.role}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

// Names of known users that appear as "@Name" in the text (case-insensitive).
// Matching against the user list handles multi-word names reliably.
export function extractMentions(text, users = []) {
    if (!text) return []
    const lower = text.toLowerCase()
    const found = []
    for (const u of users) {
        const name = u.display_name
        if (name && lower.includes('@' + name.toLowerCase()) && !found.includes(name)) found.push(name)
    }
    return found
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Render note text with @mentions highlighted. Pass the note's mention
// names when known; otherwise single-word @handles are highlighted.
export function renderNoteWithMentions(text, names) {
    if (!text) return text
    const list = (names || []).filter(Boolean).sort((a, b) => b.length - a.length)
    const re = list.length
        ? new RegExp(`(@(?:${list.map(escapeRe).join('|')}))`, 'gi')
        : /(@[\w.-]+)/g
    return text.split(re).map((part, i) => (
        i % 2 === 1
            ? <span key={i} style={{ color: 'var(--accent)', fontWeight: 600 }}>{part}</span>
            : part
    ))
}
