import { useState, useRef, useEffect, useCallback } from 'react'
import { fetchMentionableUsers } from '../api/vrm'

export default function MentionInput({ value, onChange, onSubmit, disabled, placeholder }) {
    const [users, setUsers] = useState([])
    const [showDropdown, setShowDropdown] = useState(false)
    const [mentionQuery, setMentionQuery] = useState('')
    const [mentionStart, setMentionStart] = useState(-1)
    const [selectedIdx, setSelectedIdx] = useState(0)
    const inputRef = useRef(null)
    const dropdownRef = useRef(null)

    // Load mentionable users once
    useEffect(() => {
        fetchMentionableUsers()
            .then(res => setUsers(res.users || []))
            .catch(() => { })
    }, [])

    const filteredUsers = users.filter(u =>
        u.display_name.toLowerCase().includes(mentionQuery.toLowerCase())
    )

    const handleChange = useCallback((e) => {
        const val = e.target.value
        const cursor = e.target.selectionStart
        onChange(val)

        // Detect if we're in a @mention context
        const textBefore = val.slice(0, cursor)
        const atIdx = textBefore.lastIndexOf('@')

        if (atIdx >= 0 && (atIdx === 0 || textBefore[atIdx - 1] === ' ')) {
            const query = textBefore.slice(atIdx + 1)
            // Only show dropdown if no space after @
            if (!query.includes(' ')) {
                setMentionStart(atIdx)
                setMentionQuery(query)
                setShowDropdown(true)
                setSelectedIdx(0)
                return
            }
        }

        setShowDropdown(false)
        setMentionQuery('')
        setMentionStart(-1)
    }, [onChange])

    const insertMention = useCallback((user) => {
        const before = value.slice(0, mentionStart)
        const afterCursor = inputRef.current?.selectionStart || (mentionStart + mentionQuery.length + 1)
        const after = value.slice(afterCursor)
        const newVal = `${before}@${user.display_name} ${after}`
        onChange(newVal)
        setShowDropdown(false)
        setMentionQuery('')
        setMentionStart(-1)

        // Refocus and place cursor after mention
        setTimeout(() => {
            const pos = before.length + user.display_name.length + 2
            inputRef.current?.focus()
            inputRef.current?.setSelectionRange(pos, pos)
        }, 0)
    }, [value, mentionStart, mentionQuery, onChange])

    const handleKeyDown = useCallback((e) => {
        if (!showDropdown || filteredUsers.length === 0) {
            if (e.key === 'Enter') {
                e.preventDefault()
                onSubmit?.(e)
            }
            return
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSelectedIdx(i => Math.min(i + 1, filteredUsers.length - 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSelectedIdx(i => Math.max(i - 1, 0))
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            insertMention(filteredUsers[selectedIdx])
        } else if (e.key === 'Escape') {
            setShowDropdown(false)
        }
    }, [showDropdown, filteredUsers, selectedIdx, insertMention, onSubmit])

    // Extract mentioned user IDs from text
    const extractMentions = useCallback((text) => {
        const mentions = []
        const mentionRegex = /@([\w\s]+?)(?=\s@|\s*$|[.,!?])/g
        let match
        while ((match = mentionRegex.exec(text)) !== null) {
            const name = match[1].trim()
            const user = users.find(u => u.display_name.toLowerCase() === name.toLowerCase())
            if (user) mentions.push({ id: user.id, display_name: user.display_name })
        }
        return mentions
    }, [users])

    return (
        <div style={{ position: 'relative', flex: 1 }}>
            <input
                ref={inputRef}
                type="text"
                className="input"
                style={{ width: '100%' }}
                placeholder={placeholder || 'Type a note... Use @name to mention'}
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                disabled={disabled}
            />
            {showDropdown && filteredUsers.length > 0 && (
                <div
                    ref={dropdownRef}
                    style={{
                        position: 'absolute',
                        bottom: '100%',
                        left: 0,
                        right: 0,
                        background: 'var(--bg-card, #1e1e2e)',
                        border: '1px solid var(--border-color, #333)',
                        borderRadius: '8px',
                        boxShadow: '0 -4px 16px rgba(0,0,0,0.3)',
                        maxHeight: '180px',
                        overflowY: 'auto',
                        zIndex: 100,
                        marginBottom: '4px',
                    }}
                >
                    {filteredUsers.map((user, i) => (
                        <div
                            key={user.id}
                            onMouseDown={(e) => { e.preventDefault(); insertMention(user) }}
                            style={{
                                padding: '8px 12px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                background: i === selectedIdx ? 'var(--bg-hover, rgba(255,255,255,0.08))' : 'transparent',
                                fontSize: '14px',
                                borderBottom: i < filteredUsers.length - 1 ? '1px solid var(--border-color, #333)' : 'none',
                            }}
                            onMouseEnter={() => setSelectedIdx(i)}
                        >
                            <span style={{
                                width: '24px', height: '24px',
                                borderRadius: '50%',
                                background: 'var(--accent, #6366f1)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '11px', fontWeight: 700, color: '#fff',
                                flexShrink: 0,
                            }}>
                                {user.display_name.charAt(0).toUpperCase()}
                            </span>
                            <span style={{ fontWeight: 500 }}>{user.display_name}</span>
                            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginLeft: 'auto' }}>{user.role}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

// Helper to render note text with highlighted @mentions
export function renderNoteWithMentions(text) {
    if (!text) return text
    const parts = text.split(/(@[\w\s]+?)(?=\s@|\s*$|[.,!?])/g)
    return parts.map((part, i) => {
        if (part.startsWith('@')) {
            return (
                <span key={i} style={{
                    color: 'var(--accent, #6366f1)',
                    fontWeight: 600,
                    background: 'rgba(99, 102, 241, 0.12)',
                    borderRadius: '3px',
                    padding: '0 3px',
                }}>
                    {part}
                </span>
            )
        }
        return part
    })
}
