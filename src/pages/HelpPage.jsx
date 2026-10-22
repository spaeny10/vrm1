import { useState } from 'react'
import { useWorkspace } from '../components/WorkspaceProvider'
import { Page, Card, Tabs, Badge } from '../ui'

const GUIDES = {
    fleet: {
        who: 'Fleet Manager',
        summary: 'Moves trailers, handles customer schedules, schedules field service, and approves relocations.',
        daily: [
            ['Start on Home', 'Moves due (deliveries, pickups, in transit), relocation decisions, field service this week, and trailers needing a site visit.'],
            ['Deliver / pick up', 'Use the buttons on the move cards. Log the hotshot company and cost; it’s tracked as an internal expense.'],
            ['Customer calls off a unit', 'Open the site (Sites) or the trailer and press Call off. Billing gets an alert to stop billing per the contract.'],
            ['Relocations', 'When a trailer’s GPS moves more than 1 km, Home asks you to approve or dismiss the new site assignment.'],
            ['Field service', 'Schedule on-site work from Field service or from any trailer or site page (Schedule service).'],
        ],
    },
    billing: {
        who: 'Billing Manager',
        summary: 'Owns the commercial side: rentals, rates, starting and stopping billing, statements, and customers.',
        daily: [
            ['Start on Home', '“Fix these” lists every place billing and the fleet disagree, each with a one-click fix.'],
            ['New rental', 'Rentals → New rental. Pick the trailer, customer, site and commitment term. Pricing comes from the rate card.'],
            ['Start / stop billing', 'Billing is a separate switch from delivery. Start it per the contract; stop it after a call-off.'],
            ['Month end', 'Statements → pick the month → PDF or CSV per customer.'],
            ['New customer or site', 'Customers → New customer, then add contacts and sites from the customer’s page.'],
        ],
    },
    tech: {
        who: 'Technical Manager',
        summary: 'Monitors trailer health remotely and diagnoses problems. No billing data is shown here.',
        daily: [
            ['Start on Home', 'Trailers that need attention or are offline, sorted by urgency, each with a plain-English diagnosis.'],
            ['Dig in', 'Open a trailer for history charts, network detail, alarms, connected devices, and AI analysis.'],
            ['Insights', 'Energy deficits (with throttled days explained), fleet trends, and router health.'],
            ['Hand off', 'When a trailer needs hands on site, leave a note on its site or ask the Fleet Manager to schedule service.'],
        ],
    },
}

const TERMS = [
    ['Needs attention', 'Critical battery (under 20%), battery over 45°C, an alarm, a 5+ day energy deficit, or a battery projected to go critical within 3 days.'],
    ['Watch', 'Low battery (20–40%), a warm battery, a 2–4 day energy deficit, or a steady decline.'],
    ['Offline', 'Neither the router nor the battery system has reported recently.'],
    ['Energy deficit', 'A day where the trailer used more energy than the sun provided. Days where the battery was full and the charger deliberately throttled solar don’t count. That’s healthy.'],
    ['Solar score', 'Yesterday’s solar output compared to what the weather at that location should have produced.'],
    ['Health grade', 'A–F blend of battery, solar performance, autonomy, network, and maintenance history.'],
    ['Commitment term', 'Monthly (billed per calendar month), 6-month or 1-year (billed every 28 days). Ending a commitment early re-prices the used period at the shorter-term rate (roll-back).'],
    ['Volume tier', 'Customers with 10+, 25+ or 50+ units on rent get Bronze, Silver or Gold discounts, recalculated each billing cycle.'],
]

export default function HelpPage() {
    const { workspace } = useWorkspace()
    const [tab, setTab] = useState(workspace || 'fleet')
    const g = GUIDES[tab]
    return (
        <Page title="Help" sub="How the app is organized and what the labels mean">
            <Card>
                <p className="muted">
                    Use the switcher at the top of the sidebar to choose a workspace. Each one shows only what that job needs.
                    Your permissions don’t change; switch any time.
                </p>
            </Card>
            <div>
                <Tabs value={tab} onChange={setTab} tabs={[{ key: 'fleet', label: 'Fleet' }, { key: 'billing', label: 'Billing' }, { key: 'tech', label: 'Tech' }]} />
                <Card title={`${g.who} workspace`} flush>
                    <div className="list-row"><div className="main"><div className="desc">{g.summary}</div></div></div>
                    <div className="list">
                        {g.daily.map(([k, v]) => (
                            <div key={k} className="list-row"><div className="main"><div className="title">{k}</div><div className="desc">{v}</div></div></div>
                        ))}
                    </div>
                </Card>
            </div>
            <Card title="What the labels mean" flush>
                <div className="list">
                    {TERMS.map(([k, v]) => (
                        <div key={k} className="list-row" style={{ alignItems: 'flex-start' }}>
                            <div style={{ width: 150, flexShrink: 0 }}><Badge tone="plain">{k}</Badge></div>
                            <div className="main"><div className="desc" style={{ marginTop: 0 }}>{v}</div></div>
                        </div>
                    ))}
                </div>
            </Card>
            <Card title="Ask the fleet">
                <p className="muted">Use “Ask the fleet” in the sidebar to ask questions in plain English, like “Which trailers are below 30% battery?” or “How many units does Acme have on rent?”</p>
            </Card>
        </Page>
    )
}
