import { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react'

const ToastContext = createContext(null)

export function useToast() {
    return useContext(ToastContext)
}

let toastId = 0
const TONE = { success: 'ok', error: 'crit', info: 'info' }

export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([])
    const timersRef = useRef({})

    const removeToast = useCallback((id) => {
        clearTimeout(timersRef.current[id])
        delete timersRef.current[id]
        setToasts(prev => prev.filter(t => t.id !== id))
    }, [])

    const addToast = useCallback((message, type = 'success') => {
        const id = ++toastId
        setToasts(prev => [...prev.slice(-3), { id, message, type }])
        timersRef.current[id] = setTimeout(() => removeToast(id), type === 'error' ? 6000 : 3500)
        return id
    }, [removeToast])

    // Stable identity so pages can safely use `toast` in effect dependencies
    const toast = useMemo(() => ({
        success: (msg) => addToast(msg, 'success'),
        error: (msg) => addToast(msg, 'error'),
        info: (msg) => addToast(msg, 'info'),
    }), [addToast])

    return (
        <ToastContext.Provider value={toast}>
            {children}
            <div className="toasts" role="status" aria-live="polite">
                {toasts.map(t => (
                    <div key={t.id} className="toast" onClick={() => removeToast(t.id)}>
                        <span className={`dot ${TONE[t.type] || 'info'}`} />
                        <span>{t.message}</span>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    )
}
