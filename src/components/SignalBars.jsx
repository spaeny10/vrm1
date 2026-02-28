function SignalBars({ bars, size = 20 }) {
    const maxBars = 5
    const barWidth = Math.floor(size / 7)
    const gap = 1
    return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            {Array.from({ length: maxBars }, (_, i) => {
                const h = ((i + 1) / maxBars) * (size - 2) + 2
                const x = i * (barWidth + gap)
                const y = size - h
                const active = i < (bars ?? 0)
                return (
                    <rect
                        key={i}
                        x={x}
                        y={y}
                        width={barWidth}
                        height={h}
                        rx={1}
                        fill={active
                            ? (bars >= 4 ? '#2ecc71' : bars >= 2 ? '#f1c40f' : '#e74c3c')
                            : 'rgba(255,255,255,0.08)'}
                    />
                )
            })}
        </svg>
    )
}

export default SignalBars
