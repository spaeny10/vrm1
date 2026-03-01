# API Reference

Base URL: `http://localhost:3001/api` (dev) or `https://your-app.railway.app/api` (prod)

All endpoints (except `/api/auth/login`) require a valid JWT token in the `Authorization: Bearer <token>` header.

---

## Authentication

### POST `/api/auth/login`
Authenticate a user and receive a JWT token.

**Body:** `{ "username": "admin", "password": "password" }`

**Response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": { "id": 1, "username": "admin", "display_name": "Admin", "role": "admin" }
}
```

### GET `/api/auth/me`
Get the authenticated user's profile.

### POST `/api/auth/change-password`
Change the authenticated user's password.

**Body:** `{ "current_password": "old", "new_password": "new" }`

---

## Fleet Endpoints

### GET `/api/sites`
Returns all VRM installations for the configured user. Cached in memory.

**Response:** VRM installations array with `idSite`, `name`, `identifier`, etc.

### GET `/api/fleet/latest`
Latest snapshot for every site (from PostgreSQL or in-memory cache).

**Response:**
```json
{
  "success": true,
  "records": [
    {
      "site_id": 903924,
      "site_name": "Trailer 603",
      "timestamp": 1771599326000,
      "battery_soc": 99,
      "battery_voltage": 28,
      "battery_current": 17.3,
      "battery_temp": 2,
      "solar_watts": 551,
      "solar_yield_today": 1.8,
      "charge_state": 4
    }
  ]
}
```

### GET `/api/fleet/energy`
Daily solar yield vs consumption for all sites (up to 14 days).

**Response:**
```json
{
  "success": true,
  "records": [
    {
      "site_id": 903924,
      "site_name": "Trailer 603",
      "days": [
        { "date": "2026-02-23", "yield_wh": 5160, "consumed_wh": 3200 }
      ]
    }
  ]
}
```

### GET `/api/fleet/alerts`
Sites where daily consumption exceeded yield for 2+ consecutive days.

**Response:**
```json
{
  "success": true,
  "alerts": [
    {
      "site_id": 903924,
      "site_name": "Trailer 603",
      "streak_days": 3,
      "severity": "warning",
      "deficit_days": [
        { "date": "2026-02-22", "yield_wh": 1000, "consumed_wh": 2500, "deficit_wh": 1500 }
      ]
    }
  ]
}
```

**Severity levels:** `caution` (2 days), `warning` (3-4 days), `critical` (5+ days)

---

## Site Endpoints

### GET `/api/sites/:id/diagnostics`
Live VRM diagnostic attributes for a site (voltage, current, SOC, solar, alarms, etc.).

### GET `/api/sites/:id/alarms`
Active and recent alarms for a site.

### GET `/api/sites/:id/system`
System overview with connected device info.

### GET `/api/sites/:id/stats`
VRM historical statistics. Query params: `start`, `end` (Unix timestamps).

### GET `/api/history/:id`
Local PostgreSQL history for a site. Query params: `start`, `end` (ms timestamps).

---

## GPS Endpoints

### GET `/api/gps/trailers`
Returns all trailer assignments with GPS data, job site info, and IC2 device linkage.

**Response:**
```json
{
  "success": true,
  "trailers": [
    {
      "site_id": 903924,
      "site_name": "Trailer 603",
      "latitude": 38.5,
      "longitude": -105.2,
      "job_site_id": 12,
      "job_site_name": "Job Site Alpha",
      "job_site_address": "123 Main St, Colorado Springs, CO",
      "ic2_device_id": 45678,
      "pepwave_online": true,
      "signal_bar": 4,
      "carrier": "T-Mobile"
    }
  ]
}
```

### POST `/api/gps/refresh`
Force a GPS data refresh from IC2 Peplink routers. Polls IC2 API and updates all device coordinates.

**Response:** `{ "success": true, "updated": 53 }`

### GET `/api/gps/unlinked-devices`
Returns IC2 devices not currently linked to any trailer assignment. Used by the Settings UI for manual linking.

**Response:**
```json
{
  "success": true,
  "devices": [
    { "id": 78901, "name": "Pepwave-NewTrailer", "sn": "ABC123" }
  ]
}
```

### POST `/api/gps/link-device`
Manually link an IC2 device to a VRM trailer site. Persists the `ic2_device_id` for future GPS polls.

**Body:** `{ "site_id": 903924, "ic2_device_id": 78901 }`

**Response:** `{ "success": true }`

---

## Settings Endpoints

### GET `/api/settings`
Returns retention period, database size, snapshot count, and connection status.

### PUT `/api/settings`
Update retention period. Body: `{ "retention_days": 90 }`

### POST `/api/settings/purge`
Delete snapshots older than the retention period.

---

## Maintenance Endpoints

### GET `/api/maintenance`
List maintenance logs. Optional query params: `job_site_id`, `status`, `visit_type`.

### GET `/api/maintenance/stats`
Aggregate maintenance statistics (total visits, costs, open tasks).

### GET `/api/maintenance/costs-by-site`
Maintenance costs grouped by job site. Query param: `days` (default 30).

### GET `/api/maintenance/upcoming`
Upcoming scheduled maintenance. Query param: `days` (default 30).

### GET `/api/maintenance/calendar`
Calendar view of maintenance events. Query params: `start`, `end` (ms timestamps).

### GET `/api/maintenance/:id`
Get a specific maintenance log by ID.

### POST `/api/maintenance`
Create a new maintenance log. Body: `{ "visit_type": "repair", "title": "Replace panel", ... }`

### PUT `/api/maintenance/:id`
Update a maintenance log. Body contains fields to update.

### DELETE `/api/maintenance/:id`
Delete a maintenance log.

### GET `/api/maintenance/:id/checklists`
Get completed checklists for a maintenance log.

### POST `/api/maintenance/:id/checklists`
Save a completed checklist for a maintenance log.

---

## Natural Language Query

### POST `/api/query`
Claude-powered natural language to SQL. Converts plain English questions to SQL queries, executes them, and returns formatted results.

**Body:**
```json
{
  "query": "How many trailers are in Colorado?"
}
```

**Response:**
```json
{
  "success": true,
  "answer": "There are 15 trailers currently in Colorado...",
  "sql": "SELECT COUNT(*) FROM trailer_assignments ta JOIN job_sites js ON ... WHERE js.address ILIKE '%Colorado%'",
  "data": [{ "count": 15 }]
}
```

The query engine uses `job_sites.address` for geographic/state filtering (not site names). Only read-only SQL (SELECT/WITH) is allowed.
