import { Component } from 'react'

export default class ErrorBoundary extends Component {
    constructor(props) {
        super(props)
        this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
        return { error }
    }

    componentDidCatch(error, info) {
        console.error('ErrorBoundary caught:', error, info)
    }

    render() {
        if (!this.state.error) return this.props.children
        return (
            <div className="card" style={{ maxWidth: 520, margin: '60px auto' }}>
                <div className="card-body" style={{ textAlign: 'center', padding: 32 }}>
                    <h2 style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong on this page</h2>
                    <p className="muted" style={{ marginBottom: 18 }}>{this.state.error.message || 'An unexpected error occurred.'}</p>
                    <button className="btn primary" onClick={() => window.location.reload()}>Reload page</button>
                </div>
            </div>
        )
    }
}
