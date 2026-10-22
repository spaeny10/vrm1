// Inline checklist used when completing a field service visit.
// The parent owns the state so it can submit the checklist together
// with the completion (see MaintenancePage CompleteModal).

// Build editable checklist state from a checklist template.
export function checklistFromTemplate(template) {
    return (template?.items || []).map(item => ({
        text: item.text,
        required: !!item.required,
        checked: false,
        note: '',
    }))
}

export function missingRequired(items) {
    return items.filter(i => i.required && !i.checked).length
}

export default function ChecklistPanel({ title, items, onChange }) {
    const done = items.filter(i => i.checked).length
    const toggle = (idx) => onChange(items.map((it, i) => i === idx ? { ...it, checked: !it.checked } : it))

    return (
        <div className="field">
            <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>{title || 'Checklist'}</span>
                <span className="faint num">{done} of {items.length} done</span>
            </span>
            <div className="card" style={{ padding: '6px 12px' }}>
                {items.map((it, idx) => (
                    <label key={idx} className="check" style={{ padding: '6px 0', borderBottom: idx < items.length - 1 ? '1px solid var(--border)' : 0 }}>
                        <input type="checkbox" checked={it.checked} onChange={() => toggle(idx)} />
                        <span style={{ flex: 1, color: it.checked ? 'var(--text-2)' : 'var(--text)' }}>{it.text}</span>
                        {it.required && !it.checked && <span className="faint" style={{ fontSize: 12 }}>Required</span>}
                    </label>
                ))}
            </div>
        </div>
    )
}
