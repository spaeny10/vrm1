import { useState } from 'react'

export default function MobileHeader({ onToggleSidebar }) {
    return (
        <div className="mobile-header">
            <button className="mobile-hamburger" onClick={onToggleSidebar} aria-label="Toggle menu">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 12h18M3 6h18M3 18h18" />
                </svg>
            </button>
            <div className="mobile-brand">
                <img src="/logo.webp" alt="BIGView" className="mobile-logo" />
                <span className="brand-omni" style={{ fontSize: 18 }}>OMNI</span>
            </div>
        </div>
    )
}
