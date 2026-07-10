import { createContext, useContext, useState, useEffect } from 'react'

// ============================================================
// Workspaces tailor the app to the job at hand without changing
// permissions: the same login can switch between Fleet (operations),
// Billing (money), and Tech (health & service) views. The choice
// persists per browser. Customers never see workspaces — they get
// the portal.
// ============================================================

export const WORKSPACES = {
    fleet: { key: 'fleet', label: 'Fleet', description: 'Dispatch, rentals, and asset operations' },
    billing: { key: 'billing', label: 'Billing', description: 'Revenue, statements, and billing health' },
    tech: { key: 'tech', label: 'Tech', description: 'Trailer health, alerts, and service work' },
}

const WorkspaceContext = createContext({ workspace: 'fleet', setWorkspace: () => { } })

export function WorkspaceProvider({ children }) {
    const [workspace, setWorkspaceState] = useState(() => {
        const saved = localStorage.getItem('vrm_workspace')
        return WORKSPACES[saved] ? saved : 'fleet'
    })

    useEffect(() => {
        localStorage.setItem('vrm_workspace', workspace)
    }, [workspace])

    const setWorkspace = (key) => {
        if (WORKSPACES[key]) setWorkspaceState(key)
    }

    return (
        <WorkspaceContext.Provider value={{ workspace, setWorkspace }}>
            {children}
        </WorkspaceContext.Provider>
    )
}

export function useWorkspace() {
    return useContext(WorkspaceContext)
}
