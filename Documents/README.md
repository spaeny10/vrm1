# VRM Fleet Dashboard

A real-time fleet monitoring dashboard for Victron Energy solar systems and Pepwave cellular routers. Features AI-powered natural language queries using Claude.

## Features

### 📊 Real-Time Monitoring
- **Victron VRM Integration**: Monitor battery SOC, voltage, solar power, charge state, and temperature
- **Pepwave InControl2 Integration**: Track device status, signal strength, data usage, and connectivity
- **Live Status Cards**: Visual overview of fleet health, battery levels, and energy production
- **Interactive Site Details**: Click any trailer for detailed metrics and historical charts

### 🤖 AI-Powered Natural Language Queries
Ask questions about your fleet in plain English:
- "How much data have we used?"
- "Which trailers are offline?"
- "Show me average signal strength by carrier"
- "What's the battery SOC distribution?"

Claude converts your questions to SQL, executes them against live data, and presents formatted results with explanations.

### 📡 Network Analytics
- Signal strength monitoring (RSRP, RSRQ, signal bars)
- Carrier and technology tracking (4G/5G)
- Data usage analytics per device
- Online/offline status with last-seen timestamps

### 📈 Historical Tracking
- Battery SOC trends over time
- Solar production history
- Energy deficit alerts (consecutive days of net energy loss)
- Pepwave signal strength and data usage history
- Daily usage aggregation

### ⚡ Energy Alerts
Automatic detection of energy deficit streaks:
- Warning: 2+ consecutive days of deficit
- Danger: 5+ consecutive days of deficit
- Critical: 10+ consecutive days of deficit

## Tech Stack

**Frontend:**
- React + Vite
- Chart.js for historical visualizations
- Responsive design with dark theme

**Backend:**
- Node.js + Express
- PostgreSQL for data storage and historical tracking
- Background polling (5-minute intervals)

**APIs:**
- Victron VRM API for solar system data
- Pepwave InControl2 OAuth API for network data
- Anthropic Claude API for natural language queries

## Setup

### Prerequisites
- Node.js 18+ and npm
- PostgreSQL database
- API credentials:
  - Victron VRM API token
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

4. **Get API credentials**

   **Victron VRM:**
   - Log in to https://vrm.victronenergy.com
   - Go to Settings → API Access
   - Generate an API token
   - Your User ID is in the URL: `vrm.victronenergy.com/users/{USER_ID}`

   **Pepwave InControl2:**
   - Log in to https://incontrol2.peplink.com
   - Go to Organization → API Management
   - Create a new API client
   - Save your Client ID and Client Secret

   **Anthropic Claude:**
   - Sign up at https://console.anthropic.com
   - Go to API Keys section
   - Create a new API key

5. **Initialize the database**

   The database schema is created automatically on first run. Tables include:
   - `site_snapshots` - Historical VRM data
   - `pepwave_snapshots` - Historical Pepwave data
   - `pepwave_daily_usage` - Daily data usage aggregation
   - `energy_alerts` - Energy deficit tracking

6. **Start the development server**
   ```bash
   npm run dev
   ```

   This starts both the backend server (port 3001) and Vite dev server (port 5173):
   - Frontend: http://localhost:5173
   - Backend API: http://localhost:3001

## Usage

### Dashboard Overview

The main dashboard displays:
- **Total Sites**: Number of monitored trailers
- **Online**: Count of sites currently reporting data
- **Low Battery**: Sites below 50% SOC
- **Average SOC**: Fleet-wide battery state of charge
- **Total Yield**: Combined solar energy production (kWh)

### Natural Language Queries

Use the search bar at the top to ask questions about your fleet:

**Battery & Solar Queries:**
- "Which sites have low battery?"
- "Show me solar production for the last week"
- "What's the average battery voltage?"
- "Which trailers are in bulk charging mode?"

**Network Queries:**
- "Show me all offline devices"
- "Which carriers have the best signal strength?"
- "How much data has trailer 5001 used?"
- "List devices with weak signal (under 2 bars)"

**Historical Queries:**
- "Show me battery trends for the last 30 days"
- "What's the total data usage this month?"
- "Which sites have energy deficit alerts?"

### Site Details

Click any site card to view:
- Current battery, solar, and load metrics
- Charge state and controller status
- Historical battery SOC chart
- Network connectivity status (if Pepwave-equipped)
- Signal strength, carrier, and data usage
- Recent diagnostics and alarms

## API Endpoints

### VRM Data
- `GET /api/sites` - All sites with latest snapshot
- `GET /api/sites/:id` - Site details with diagnostics
- `GET /api/sites/:id/history?days=7` - Historical battery data

### Pepwave Data
- `GET /api/pepwave/devices` - All devices with latest snapshot
- `GET /api/pepwave/devices/:name/history?days=7` - Historical signal/usage data
- `GET /api/pepwave/devices/:name/daily-usage?days=30` - Daily usage aggregation

### Natural Language Query
- `POST /api/query` - Claude-powered natural language to SQL
  ```json
  {
    "query": "How much data have we used?"
  }
  ```

  Returns:
  ```json
  {
    "success": true,
    "answer": "Your fleet has used 145.3 GB total...",
    "sql": "SELECT SUM(usage_mb) / 1024 AS total_gb FROM pepwave_snapshots",
    "data": [{ "total_gb": 145.3 }]
  }
  ```

### Alerts
- `GET /api/energy-alerts` - Current energy deficit alerts

## Architecture

### Data Flow

1. **Background Polling** (every 5 minutes):
   - Fetch latest data from VRM and InControl2 APIs
   - Store snapshots in PostgreSQL
   - Calculate daily usage aggregations
   - Detect energy deficit streaks
   - Update in-memory cache

2. **Frontend Requests**:
   - Initial load fetches cached data (instant response)
   - Site details fetch historical data on demand
   - Natural language queries execute real-time SQL

3. **Natural Language Queries**:
   - User enters plain English question
   - Sent to Claude API with database schema context
   - Claude generates SQL query
   - Backend validates and executes query (read-only)
   - Results formatted and returned with AI explanation

### Database Schema

**site_snapshots** - VRM historical data
```sql
CREATE TABLE site_snapshots (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL,
  site_name TEXT,
  battery_soc REAL,
  battery_voltage REAL,
  solar_watts REAL,
  load_watts REAL,
  charge_state TEXT,
  battery_temp REAL,
  timestamp BIGINT NOT NULL
);
```

**pepwave_snapshots** - Pepwave historical data
```sql
CREATE TABLE pepwave_snapshots (
  id SERIAL PRIMARY KEY,
  device_name TEXT NOT NULL,
  online BOOLEAN,
  signal_bar INTEGER,
  rsrp REAL,
  rsrq REAL,
  sinr REAL,
  carrier TEXT,
  technology TEXT,
  usage_mb REAL,
  timestamp BIGINT NOT NULL
);
```

**energy_alerts** - Energy deficit tracking
```sql
CREATE TABLE energy_alerts (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL,
  site_name TEXT,
  severity TEXT, -- 'warning', 'danger', 'critical'
  streak_days INTEGER,
  deficit_days JSONB,
  updated_at BIGINT NOT NULL
);
```

## Configuration

### Polling Interval

Edit `server/server.js` to change update frequency:
```javascript
// Change from 5 minutes to custom interval
const POLL_INTERVAL = 5 * 60 * 1000; // milliseconds
```

### Alert Thresholds

Edit alert severity thresholds in `server/server.js`:
```javascript
function getSeverity(streakDays) {
    if (streakDays >= 10) return 'critical';
    if (streakDays >= 5) return 'danger';
    if (streakDays >= 2) return 'warning';
    return null;
}
```

### Claude Model

The natural language query feature uses `claude-sonnet-4-5-20250929`. To change models, edit `server/server.js`:
```javascript
const MODEL_NAME = 'claude-sonnet-4-5-20250929';
```

## Troubleshooting

### "API error" when using natural language queries
- Check your `ANTHROPIC_API_KEY` is valid
- Verify you have API credits available
- Check server logs for detailed error messages

### Pepwave devices not appearing
- Verify `IC2_CLIENT_ID` and `IC2_CLIENT_SECRET` are correct
- Check InControl2 API client has proper permissions
- Look for "IC2 token obtained" message in server logs

### VRM sites not updating
- Confirm `VRM_API_TOKEN` and `VRM_USER_ID` are correct
- Check VRM API token hasn't expired
- Verify sites are accessible in your VRM account

### Database connection errors
- Ensure PostgreSQL is running
- Verify `DATABASE_URL` connection string is correct
- Check database user has CREATE TABLE permissions

## Performance

With 110 devices and 5-minute polling:
- **Backend memory**: ~150MB
- **Database size**: ~50MB/month (with 5-min snapshots)
- **Poll duration**: 30-35 seconds (VRM + IC2 combined)
- **Query response**: <100ms (cached data)
- **Historical queries**: 200-500ms (depends on date range)

## Security

- All API keys stored in `.env` (never committed to git)
- SQL queries validated for read-only operations (SELECT/WITH only)
- PostgreSQL connections use SSL for remote databases
- CORS enabled for frontend access
- Token refresh handles automatic re-authentication

## Development

### Project Structure
```
VRM1/
├── server/
│   ├── server.js         # Main backend server
│   ├── db.js             # Database connection
│   └── embeddings.js     # Embedding utilities (unused)
├── src/
│   ├── components/       # React components
│   │   ├── Dashboard.jsx
│   │   ├── SiteCard.jsx
│   │   ├── SiteDetail.jsx
│   │   └── QueryBar.jsx
│   ├── api/
│   │   └── vrm.js        # API client functions
│   └── App.jsx
├── .env                  # Environment variables (not committed)
└── package.json
```

### Adding New Features

To add a new data field:
1. Add to relevant snapshot table schema
2. Update polling function to capture the field
3. Update frontend components to display it
4. Add to Claude's schema context (FLEET_SCHEMA in server.js)

## Contributing

This is an internal fleet management tool. For bugs or feature requests, contact the development team.

## License

Proprietary - Antigravity Inc.

## Support

For issues or questions:
- Check server logs: `npm run dev` output
- Verify API credentials in `.env`
- Test with simple queries first
- Review this documentation

---

**Built with ❤️ using Claude Code**
