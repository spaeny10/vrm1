# Railway Deployment Guide

## Step-by-Step

### 1. Create Railway Project
1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project** → **Deploy from GitHub repo**
3. Select the `spaeny10/vrm1` repository
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
                                          Polls VRM every 5 min
                                                    ↓
                                          Stores snapshots in PostgreSQL
```

- `npm run build` compiles React frontend into `dist/`
- `npm start` runs `node server/server.js` which serves the built frontend AND the API
- The server connects to PostgreSQL via `DATABASE_URL` (auto-set by Railway)
- Background polling starts 3s after boot, then every 5 minutes

## Monitoring

- Check Railway logs for poll status: `Poll complete: 63 ok, 0 errors in 28s`
- Database connection: `PostgreSQL database connected`
- Energy alerts: `energy alerts: N` in each poll log line

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `PostgreSQL not available` | Verify DATABASE_URL is set and PostgreSQL plugin is running |
| `VRM API 401` | Check VRM_API_TOKEN is valid and not expired |
| `Poll errors on many sites` | May be rate-limited — the 3-per-batch with 1.2s delay should handle this |
| Blank dashboard | Wait 30s for first poll to complete after deploy |
