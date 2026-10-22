import { Link } from 'react-router-dom'

export default function NotFound() {
    return (
        <div className="card" style={{ maxWidth: 460, margin: '60px auto' }}>
            <div className="card-body" style={{ textAlign: 'center', padding: 32 }}>
                <h2 style={{ fontSize: 20, marginBottom: 6 }}>Page not found</h2>
                <p className="muted" style={{ marginBottom: 18 }}>That address doesn't exist — it may have moved in the redesign.</p>
                <Link to="/" className="btn primary">Go home</Link>
            </div>
        </div>
    )
}
