# API Reference

Base URL: `http://localhost:3001/api` (dev) or `https://your-app.railway.app/api` (prod)

---

## Fleet Endpoints

### GET `/api/sites`
Returns all VRM installations for the configured user. Cached for 5 minutes.

**Response:** VRM installations array with `idSite`, `name`, `identifier`, etc.

---

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

---

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

---

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

## Settings Endpoints

### GET `/api/settings`
Returns retention period, database size, snapshot count, and connection status.

### PUT `/api/settings`
Update retention period. Body: `{ "retention_days": 90 }`

### POST `/api/settings/purge`
Delete snapshots older than the retention period.
