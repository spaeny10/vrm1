# VRM Fleet Dashboard

Real-time monitoring dashboard for 63+ Victron Energy VRM solar/battery trailer sites.

## Features

- **Fleet Overview** — Grid of all sites with live SOC, voltage, solar power, and yield
- **Site Detail** — Per-site gauges, historical charts, alarms, and device info
- **Energy Analysis** — Daily solar yield vs consumption with deficit alerts
- **Settings** — Data retention and database management

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite 6, Chart.js |
| Backend | Express 4, Node.js |
| Database | PostgreSQL (Railway) |
| API | Victron VRM API v2 |

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL (optional for local dev — uses in-memory cache without it)
- VRM API token and user ID

### Setup

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your VRM credentials
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VRM_API_TOKEN` | Yes | Your VRM API bearer token |
| `VRM_USER_ID` | Yes | Your VRM user ID |
| `DATABASE_URL` | No | PostgreSQL connection string (Railway auto-sets this) |
| `PORT` | No | Server port (default: 3001) |

### Run Locally

```bash
# Development (frontend + backend together)
npm run dev

# Frontend: http://localhost:5173
# Backend:  http://localhost:3001
```

### Build for Production

```bash
npm run build    # Build frontend to dist/
npm start        # Start production server (serves dist/ + API)
```

## Project Structure

```
VRM1/
├── server/
│   ├── server.js      # Express API proxy + background polling
│   └── db.js          # PostgreSQL data layer
├── src/
│   ├── api/vrm.js     # Frontend API client
│   ├── components/    # Sidebar, KpiCard, GaugeChart, SiteCard, AlarmBadge
│   ├── hooks/         # useApiPolling custom hook
│   └── pages/         # FleetOverview, SiteDetail, EnergyPage, Settings
├── Documents/         # Project documentation
├── .env               # Environment variables (not committed)
└── package.json
```

## Polling & Rate Limits

- **63 sites** polled every 5 minutes via VRM `/diagnostics` endpoint
- Batched in groups of 3 with 1.2s delay = ~30s per full poll cycle
- Well under VRM's 3 requests/second rate limit
- Data stored in both PostgreSQL (persistent) and in-memory cache (instant access)

## License

Private — Antigravity internal use.
