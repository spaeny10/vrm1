import { useEffect, useState } from 'react'
import { Icon } from '../ui'

export function storedTheme() {
    try { return localStorage.getItem('vrm_theme') || 'dark' } catch { return 'dark' }
}

export default function ThemeToggle() {
    const [theme, setTheme] = useState(storedTheme)

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme)
        try { localStorage.setItem('vrm_theme', theme) } catch { /* private mode */ }
    }, [theme])

    return (
        <button className="icon-btn" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme" title="Toggle light/dark">
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
    )
}
