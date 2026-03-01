# Railway Deployment Guide

## Step-by-Step

### 1. Create Railway Project
1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project** → **Deploy from GitHub repo**
3. Select the repository
4. Railway will auto-detect Node.js

### 2. Add PostgreSQL
1. In your Railway project, click **+ New** → **Database** → **PostgreSQL**
2. Railway auto-sets the `DATABASE_URL` env var — no manual config needed

### 3. Set Environment Variables
In the service settings → **Variables**, add:

| Variable | Value |
|----------|-------|
| `VRM_API_TOKEN` | Your VRM API token |
| `VRM_USER_ID` | Your VRM user ID |
| `IC2_CLIENT_ID` | Your Pepwave InControl2 client ID |
| `IC2_CLIENT_SECRET` | Your Pepwave InControl2 client secret |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `JWT_SECRET` | A random secret string for JWT signing |

### 4. Configure Build & Start
Railway should auto-detect these, but verify in settings:

| Setting | Value |
|---------|-------|
| Build Command | `npm run build` |
| Start Command | `npm start` |

### 5. Deploy
Railway will build and deploy automatically on push to `main`.

## How It Works on Railway

```
GitHub Push → Railway Build (npm run build) → Railway Start (npm start)
                                                    ↓
                                          Express serves dist/ + API
                                                    ↓
                                          Polls VRM every 30s, IC2 every 60s
                                                    ↓
                                          Stores snapshots in PostgreSQL
                                                    ↓
                                          GPS from IC2 Peplink → gpsCache + DB
```

- `npm run build` compiles React frontend into `dist/`
- `npm start` runs `node server/server.js` which serves the built frontend AND the API
- The server connects to PostgreSQL via `DATABASE_URL` (auto-set by Railway)
- Background polling starts 3s after boot
- IC2 device linkages are loaded from DB on startup (prints "Loaded N IC2 device linkages")

## Monitoring

- Check Railway logs for poll status: `Poll complete: 110 ok, 0 errors in 28s`
- Database connection: `PostgreSQL database connected`
- IC2 linkages: `Loaded N IC2 device linkages`
- Energy alerts: `energy alerts: N` in each poll log line
- IC2 GPS: Look for `IC2 GPS updated` messages

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `PostgreSQL not available` | Verify DATABASE_URL is set and PostgreSQL plugin is running |
| `VRM API 401` | Check VRM_API_TOKEN is valid and not expired |
| `IC2 not configured` | Set IC2_CLIENT_ID and IC2_CLIENT_SECRET env vars |
| `Poll errors on many sites` | May be rate-limited — the batch processing with delay handles this |
| Blank dashboard | Wait 30s for first poll to complete after deploy |
| GPS not updating | Verify IC2 credentials; check Settings → GPS Verification |
| Wrong trailer locations | Use Settings → GPS Verification → "Refresh from IC2" |
