import { useState } from 'react';

export default function ChecklistPanel({ template, onSubmit, onClose }) {
    const [items, setItems] = useState(
        (template?.items || []).map(item => ({
            text: item.text,
            required: item.required || false,
            checked: false,
            note: '',
        }))
    );
    const [submitting, setSubmitting] = useState(false);

    const toggleItem = (idx) => {
        setItems(prev => prev.map((item, i) => i === idx ? { ...item, checked: !item.checked } : item));
    };

    const updateNote = (idx, note) => {
        setItems(prev => prev.map((item, i) => i === idx ? { ...item, note } : item));
    };

    const allRequiredChecked = items.filter(i => i.required).every(i => i.checked);

    const handleSubmit = async () => {
        if (!allRequiredChecked) return;
        setSubmitting(true);
        try {
            await onSubmit({
                template_id: template.id,
                template_name: template.name,
                items,
            });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="maint-form-overlay" onClick={onClose}>
            <div className="checklist-panel" onClick={e => e.stopPropagation()}>
                <div className="checklist-header">
                    <h3>{template?.name || 'Checklist'}</h3>
                    <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
                </div>

                <div className="checklist-items">
                    {items.map((item, idx) => (
                        <div key={idx} className={`checklist-item ${item.checked ? 'checklist-item-done' : ''}`}>
                            <label className="checklist-label">
                                <input
                                    type="checkbox"
                                    checked={item.checked}
                                    onChange={() => toggleItem(idx)}
                                />
                                <span className="checklist-text">
                                    {item.text}
                                    {item.required && <span className="checklist-required">*</span>}
                                </span>
                            </label>
                            <input
                                type="text"
                                className="checklist-note"
                                placeholder="Notes..."
                                value={item.note}
                                onChange={e => updateNote(idx, e.target.value)}
                            />
                        </div>
                    ))}
                </div>

                <div className="checklist-footer">
                    <span className="checklist-progress">
                        {items.filter(i => i.checked).length} / {items.length} completed
                    </span>
                    <div className="checklist-actions">
                        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                        <button
                            className="btn btn-primary"
                            onClick={handleSubmit}
                            disabled={!allRequiredChecked || submitting}
                        >
                            {submitting ? 'Saving...' : 'Submit Checklist'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
