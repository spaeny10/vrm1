import { useEffect, useRef } from 'react'

function GaugeChart({ value = 0, max = 100, label = '', size = 100, thickness = 10 }) {
    const canvasRef = useRef(null)

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        const dpr = window.devicePixelRatio || 1
        canvas.width = size * dpr
        canvas.height = size * dpr
        ctx.scale(dpr, dpr)
        canvas.style.width = size + 'px'
        canvas.style.height = size + 'px'

        const cx = size / 2
        const cy = size / 2
        const radius = (size - thickness) / 2 - 4

        // Clamp value
        const pct = Math.max(0, Math.min(100, (value / max) * 100))

        // Background arc
        ctx.clearRect(0, 0, size, size)
        ctx.beginPath()
        ctx.arc(cx, cy, radius, 0.75 * Math.PI, 2.25 * Math.PI)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
        ctx.lineWidth = thickness
        ctx.lineCap = 'round'
        ctx.stroke()

        // Value arc
        const startAngle = 0.75 * Math.PI
        const totalAngle = 1.5 * Math.PI
        const endAngle = startAngle + (pct / 100) * totalAngle

        // Color based on percentage
        let color
        if (pct >= 60) color = '#2ecc71'
        else if (pct >= 30) color = '#f39c12'
        else color = '#e74c3c'

        ctx.beginPath()
        ctx.arc(cx, cy, radius, startAngle, endAngle)
        ctx.strokeStyle = color
        ctx.lineWidth = thickness
        ctx.lineCap = 'round'
        ctx.stroke()

        // Center text
        ctx.fillStyle = '#ecf0f1'
        ctx.font = `700 ${size * 0.22}px Inter, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${Math.round(pct)}%`, cx, cy - 4)

        // Label
        if (label) {
            ctx.fillStyle = 'rgba(255,255,255,0.5)'
            ctx.font = `400 ${size * 0.1}px Inter, sans-serif`
            ctx.fillText(label, cx, cy + size * 0.16)
        }
    }, [value, max, label, size, thickness])

    return (
        <canvas
            ref={canvasRef}
            className="gauge-chart"
        />
    )
}

export default GaugeChart
