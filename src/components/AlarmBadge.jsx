import { Badge } from '../ui'

const LEVELS = {
    alarm: { tone: 'crit', label: 'Alarm' },
    warning: { tone: 'warn', label: 'Warning' },
    ok: { tone: 'ok', label: 'OK' },
    offline: { tone: 'off', label: 'Offline' },
}

// Severity pill for a Victron alarm record (level: alarm | warning | ok | offline)
export default function AlarmBadge({ level }) {
    const l = LEVELS[level] || { tone: 'plain', label: level || 'Unknown' }
    return <Badge tone={l.tone}>{l.label}</Badge>
}
