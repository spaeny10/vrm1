// Chart.js setup and theme shared by every chart in the app.
// Colors come from the CSS variables so charts follow light/dark mode.
import {
    Chart as ChartJS, CategoryScale, LinearScale, TimeScale, PointElement, LineElement,
    BarElement, Filler, Tooltip, Legend,
} from 'chart.js'
import 'chartjs-adapter-date-fns'

ChartJS.register(CategoryScale, LinearScale, TimeScale, PointElement, LineElement, BarElement, Filler, Tooltip, Legend)

export function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// Palette for series. Status colors are only for status-meaning series.
export function chartColors() {
    return {
        text: cssVar('--text-2'),
        faint: cssVar('--text-3'),
        grid: cssVar('--border'),
        accent: cssVar('--accent'),
        ok: cssVar('--ok'),
        warn: cssVar('--warn'),
        crit: cssVar('--crit'),
        series: [cssVar('--accent'), '#a78bfa', '#2dd4bf', cssVar('--warn'), '#f472b6', '#94a3b8'],
    }
}

// Translucent fill for an area under a line
export function alpha(hex, a) {
    const h = hex.replace('#', '')
    if (h.length !== 6) return hex
    const n = parseInt(h, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

// Base options: quiet axes, tabular tooltips, no legend unless asked.
// opts: { time: true|false, unit: 'hour'|'day', yMin, yMax, ySuffix, legend, stacked }
export function baseOptions(opts = {}) {
    const c = chartColors()
    const x = opts.time
        ? { type: 'time', time: { unit: opts.unit || 'day', tooltipFormat: opts.unit === 'hour' ? 'MMM d, h:mm a' : 'MMM d' } }
        : { type: 'category' }
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: opts.legend ? { display: true, position: 'bottom', labels: { color: c.text, boxWidth: 10, boxHeight: 10, usePointStyle: true } } : { display: false },
            tooltip: {
                backgroundColor: cssVar('--surface-3'), titleColor: cssVar('--text'), bodyColor: cssVar('--text-2'),
                borderColor: cssVar('--border-strong'), borderWidth: 1, padding: 10,
                callbacks: opts.ySuffix ? { label: (ctx) => `${ctx.dataset.label ? ctx.dataset.label + ': ' : ''}${ctx.formattedValue}${opts.ySuffix}` } : undefined,
            },
        },
        scales: {
            x: { ...x, stacked: !!opts.stacked, grid: { display: false }, ticks: { color: c.faint, maxRotation: 0, autoSkipPadding: 18 }, border: { color: c.grid } },
            y: {
                stacked: !!opts.stacked, min: opts.yMin, max: opts.yMax, grid: { color: c.grid }, border: { display: false },
                ticks: { color: c.faint, callback: opts.ySuffix ? (v) => `${v}${opts.ySuffix}` : undefined },
            },
        },
        elements: { point: { radius: 0, hoverRadius: 4 }, line: { borderWidth: 2, tension: 0.3 } },
    }
}

export { ChartJS }
