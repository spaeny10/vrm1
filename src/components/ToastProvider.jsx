import { createContext, useContext, useState, useCallback, useRef } from 'react'

const ToastContext = createContext(null)

export function useToast() {
    return useContext(ToastContext)
}

let toastId = 0

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
        const duration = type === 'error' ? 5000 : 3000
        setToasts(prev => [...prev, { id, message, type }])
        timersRef.current[id] = setTimeout(() => removeToast(id), duration)
        return id
    }, [removeToast])

    const toast = {
        success: (msg) => addToast(msg, 'success'),
        error: (msg) => addToast(msg, 'error'),
        info: (msg) => addToast(msg, 'info'),
    }

    return (
        <ToastContext.Provider value={toast}>
            {children}
            <div className="toast-container">
                {toasts.map(t => (
                    <div key={t.id} className={`toast toast-${t.type}`} onClick={() => removeToast(t.id)}>
                        <span className="toast-icon">
                            {t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : 'ℹ'}
                        </span>
                        <span className="toast-message">{t.message}</span>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    )
}
