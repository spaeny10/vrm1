import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ToastProvider } from './components/ToastProvider.jsx'
import { AuthProvider } from './components/AuthProvider.jsx'
import App from './App.jsx'
import { storedTheme } from './components/ThemeToggle.jsx'
import 'leaflet/dist/leaflet.css'
import './ui/ui.css'

document.documentElement.setAttribute('data-theme', storedTheme())

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <BrowserRouter>
            <AuthProvider>
                <ToastProvider>
                    <App />
                </ToastProvider>
            </AuthProvider>
        </BrowserRouter>
    </React.StrictMode>,
)
