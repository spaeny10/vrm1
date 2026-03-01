# BVIM Dashboard

A real-time fleet monitoring dashboard for Victron Energy solar systems and Pepwave cellular routers. Features AI-powered natural language queries, GPS tracking via IC2 Peplink, and fleet intelligence analytics.

## Features

### Dashboard (Fleet Overview)
- **KPI Cards**: Total sites, online count, low battery count, average SOC, total yield
- **Action Queue**: Energy deficit alerts with severity badges (caution/warning/critical) and acknowledgment tracking
- **Site Cards**: Visual overview of each job site with trailer count, battery levels, and status
- **Search, Sort & Filter**: Find trailers by name, sort by SOC/name/status, filter by state

### Map View
- **Interactive Map**: Leaflet-based map showing all trailer locations via GPS
- **GPS Data Source**: Coordinates pulled from IC2 Peplink routers (sole authoritative source)
- **Reverse Geocoding**: Job site addresses from OpenStreetMap Nominatim API
- **Clickable Markers**: Click any trailer for quick status overlay

### Fleet Details (Tabbed View)
Three sub-tabs for detailed analysis:

- **Intelligence** (default tab): Fleet-wide analytics table with Solar Score, 7-day average, panel performance, days of autonomy, energy balance, and charge time. Column headers include explanatory tooltips. KPI cards show fleet averages and underperforming trailer counts.
- **Energy**: Daily solar yield vs consumption comparison with grouped bar charts, site selector, and fleet-wide energy summary
- **Network**: Signal strength monitoring (RSRP, RSRQ, signal bars), carrier/technology tracking, data usage analytics, online/offline status

### Maintenance
- Drag-and-drop task management for fleet maintenance tracking
- Task cards with priority, status, and assignment

### Settings
- **Database Status**: Connection info, snapshot count, retention period configuration
- **GPS Verification**: Table showing all trailers with GPS coordinates, job site assignments, and IC2 device linkage status. Includes "Refresh from IC2" button and manual IC2 device linking.
- **Data Purge**: Manual purge controls for old snapshots

### AI-Powered Natural Language Queries
Ask questions about your fleet in plain English:
- "How many trailers are in Colorado?"
- "Which trailers are offline?"
- "Show me average signal strength by carrier"
- "What's the battery SOC distribution?"

Claude converts questions to SQL, executes against live data, and returns formatted results. Geographic queries use `job_sites.address` for accurate state/location filtering.

### Energy Alerts
Automatic detection of energy deficit streaks:
- Caution: 2 consecutive days of deficit
- Warning: 3-4 consecutive days of deficit
- Critical: 5+ consecutive days of deficit

## Tech Stack

**Frontend:**
- React 18 + Vite 6
- React Router for navigation
- Chart.js for data visualization
- Leaflet for interactive maps
- Dark theme with Inter font

**Backend:**
- Node.js + Express
- PostgreSQL for data storage and historical tracking
- Background polling (VRM every 30s, IC2 every 60s)
- JWT authentication with role-based access

**APIs:**
- Victron VRM API for solar system data
- Pepwave InControl2 OAuth API for network data and GPS
- Anthropic Claude API for natural language queries
- Open-Meteo API for solar radiation data (Solar Score calculation)
- OpenStreetMap Nominatim for reverse geocoding

## GPS Architecture

### IC2 Peplink as GPS Authority

GPS coordinates come exclusively from IC2 Peplink routers installed on each trailer. VRM does **not** write GPS data — it only seeds the cache if IC2 hasn't provided coordinates yet.

### IC2 Device ID Binding

Each IC2 Peplink router has a persistent `dev.id`. The system uses this ID as the primary identifier for linking IC2 devices to VRM trailer installations:

1. **Stored linkage** (`ic2_device_id` column in `trailer_assignments`): Checked first
2. **Name match fallback**: If no stored linkage, matches `dev.name` to VRM site name
3. **Auto-persist**: On successful name match, the `ic2_device_id` is saved for future polls
4. **Manual linking**: Settings > GPS Verification allows manual linking of unlinked IC2 devices

This replaces fragile exact-name matching with a persistent identifier that survives device renames.

### GPS Data Flow
```
IC2 Peplink Router (on trailer)
    → IC2 API poll (every 60s)
    → resolveIc2DeviceToSiteId() matches device to VRM site
    → GPS coordinates stored in gpsCache + database
    → Nominatim reverse geocodes to street address
    → Frontend displays on map + GPS Verification table
```

## Setup

### Prerequisites
- Node.js 18+ and npm
- PostgreSQL database
- API credentials:
  - Victron VRM API token and user ID
  - Pepwave InControl2 client ID and secret
  - Anthropic API key (for natural language queries)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd VRM1
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**

   Create a `.env` file in the root directory:
   ```bash
   # Victron VRM API
   VRM_API_TOKEN=your_vrm_token_here
   VRM_USER_ID=your_user_id_here

   # InControl2 (Pepwave) API
   IC2_CLIENT_ID=your_ic2_client_id
   IC2_CLIENT_SECRET=your_ic2_client_secret

   # PostgreSQL Database
   DATABASE_URL=postgresql://user:password@host:port/database

   # Claude API for natural language queries
   ANTHROPIC_API_KEY=sk-ant-api03-your_key_here

   # Server Port (optional, defaults to 3001)
   PORT=3001
   ```

4. **Initialize the database**

   The database schema is created automatically on first run. Key tables:
   - `site_snapshots` — Historical VRM data
   - `pepwave_snapshots` — Historical Pepwave data
   - `pepwave_daily_usage` — Daily data usage aggregation
   - `energy_alerts` — Energy deficit tracking
   - `trailer_assignments` — GPS coordinates, job site links, and IC2 device bindings
   - `job_sites` — Job site locations with addresses
   - `users` — Authentication (JWT-based)

5. **Start the development server**
   ```bash
   npm run dev
   ```

   This starts both the backend server (port 3001) and Vite dev server (port 5173):
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3001

## Navigation

The sidebar provides access to five main pages:

| Page | Route | Description |
|------|-------|-------------|
| Dashboard | `/` | Fleet overview with KPI cards, action queue, and site cards |
| Map | `/map` | Interactive map with GPS-based trailer locations |
| Fleet Details | `/fleet` | Intelligence, Energy, and Network sub-tabs |
| Maintenance | `/maintenance` | Drag-and-drop maintenance task management |
| Settings | `/settings` | Database config, GPS verification, data purge |

Clicking a site card navigates to the Job Site Detail view. Clicking a trailer within a job site navigates to the Trailer Detail view with battery/solar gauges, historical charts, and system intelligence.

## Project Structure
```
VRM1/
├── server/
│   ├── server.js         # Main backend server (polling, API routes, GPS resolver)
│   └── db.js             # Database connection, schema, upsert functions
├── src/
│   ├── components/
│   │   ├── Sidebar.jsx       # Navigation sidebar with BVIM branding
│   │   ├── AuthProvider.jsx  # JWT auth context
│   │   ├── ErrorBoundary.jsx # React error boundary
│   │   └── QueryBar.jsx      # AI-powered natural language search
│   ├── pages/
│   │   ├── FleetOverview.jsx    # Dashboard with KPI cards + site grid
│   │   ├── FleetDetailsPage.jsx # Tabbed view (Intelligence/Energy/Network)
│   │   ├── AnalyticsPage.jsx    # Intelligence table + tooltips
│   │   ├── EnergyPage.jsx       # Energy analysis charts
│   │   ├── NetworkPage.jsx      # Network analytics
│   │   ├── MapView.jsx          # Leaflet map
│   │   ├── JobSiteDetail.jsx    # Per-site detail view
│   │   ├── TrailerDetail.jsx    # Per-trailer detail view
│   │   ├── MaintenancePage.jsx  # Maintenance task board
│   │   ├── Settings.jsx         # Settings + GPS verification
│   │   ├── LoginPage.jsx        # Login with BVIM branding
│   │   └── NotFound.jsx         # 404 page
│   ├── hooks/
│   │   └── useApiPolling.js  # Polling hook for real-time data
│   ├── api/
│   │   └── vrm.js            # API client functions
│   ├── App.jsx               # Route definitions
│   ├── main.jsx              # React entry point
│   └── index.css             # Global styles (dark theme)
├── Documents/
│   ├── README.md             # This file
│   ├── API.md                # API endpoint reference
│   ├── DEPLOYMENT.md         # Railway deployment guide
│   ├── CHANGELOG.md          # Version history
│   └── SOLAR-SCORE.md        # Solar Score calculation detail
├── .env                      # Environment variables (not committed)
├── index.html                # HTML entry point
└── package.json              # Dependencies and scripts
```

## Configuration

### Polling Intervals
- **VRM**: Every 30 seconds (`VRM_POLL_INTERVAL`)
- **IC2**: Every 60 seconds (`IC2_POLL_INTERVAL`)

### Alert Thresholds
Edit alert severity thresholds in `server/server.js`:
```javascript
function getSeverity(streakDays) {
    if (streakDays >= 5) return 'critical';
    if (streakDays >= 3) return 'warning';
    if (streakDays >= 2) return 'caution';
    return null;
}
```

### Claude Model
The natural language query feature uses `claude-sonnet-4-5-20250929`. To change models, edit `server/server.js`:
```javascript
const MODEL_NAME = 'claude-sonnet-4-5-20250929';
```

## Troubleshooting

### GPS coordinates not updating
- Verify IC2 credentials (`IC2_CLIENT_ID`, `IC2_CLIENT_SECRET`) are valid
- Check Settings > GPS Verification for IC2 device linkage status
- Use "Refresh from IC2" to force a GPS update
- For unlinked devices, manually link via the dropdown in the IC2 Device column

### "API error" when using natural language queries
- Check your `ANTHROPIC_API_KEY` is valid
- Verify you have API credits available
- Check server logs for detailed error messages

### Geographic queries returning wrong results
- Verify job site addresses are correct (derived from GPS coordinates via reverse geocoding)
- Bad GPS = wrong addresses = wrong query results
- Use Settings > GPS Verification to check and fix GPS data

### Pepwave devices not appearing
- Verify `IC2_CLIENT_ID` and `IC2_CLIENT_SECRET` are correct
- Check InControl2 API client has proper permissions
- Look for "IC2 token obtained" message in server logs

### VRM sites not updating
- Confirm `VRM_API_TOKEN` and `VRM_USER_ID` are correct
- Check VRM API token hasn't expired
- Verify sites are accessible in your VRM account

## Performance

With ~110 trailers across ~53 sites and current polling intervals:
- **Backend memory**: ~150MB
- **Database size**: ~50MB/month (with snapshots)
- **VRM poll**: ~15-20 seconds per cycle
- **IC2 poll**: ~10-15 seconds per cycle
- **Query response**: <100ms (cached data)
- **Historical queries**: 200-500ms (depends on date range)

## Security

- All API keys stored in `.env` (never committed to git)
- JWT-based authentication with role-based access control
- SQL queries validated for read-only operations (SELECT/WITH only)
- PostgreSQL connections use SSL for remote databases
- CORS enabled for frontend access
- IC2 OAuth token refresh handles automatic re-authentication

## License

Proprietary - Antigravity Inc.

---

**Built with Claude Code**
