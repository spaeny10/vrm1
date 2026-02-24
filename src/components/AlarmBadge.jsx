function AlarmBadge({ level }) {
    const classes = {
        alarm: 'alarm-badge alarm-critical',
        warning: 'alarm-badge alarm-warning',
        ok: 'alarm-badge alarm-ok',
        offline: 'alarm-badge alarm-offline',
    }

    const labels = {
        alarm: 'ALARM',
        warning: 'WARNING',
        ok: 'OK',
        offline: 'OFFLINE',
    }

    return (
        <span className={classes[level] || classes.ok}>
            {labels[level] || level}
        </span>
    )
}

export default AlarmBadge
