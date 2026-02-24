# Changelog

All notable changes to the VRM Fleet Dashboard.

---

## [1.0.0] — 2026-02-23

### Added
- **Fleet Overview** — Dashboard showing all 63 Victron VRM sites with KPI cards (SOC, voltage, solar, yield), search, sort, and filter controls
- **Site Detail** — Per-site view with battery/solar gauges, historical charts (SOC, voltage, solar), alarms list, and connected devices table
- **Energy Analysis** — Daily solar yield vs consumption comparison with grouped bar chart, site selector, and fleet-wide energy summary table
- **Deficit Alerts** — Automatic detection of sites where consumption exceeds solar yield for 2+ consecutive days, with severity levels (caution/warning/critical)
- **Settings** — Database status display, data retention period selector, and manual purge controls
- **PostgreSQL Backend** — Persistent data storage via Railway's PostgreSQL plugin, with in-memory cache fallback for local development
- **VRM API Integration** — Diagnostics-based polling (1 API call per site every 5 min), rate-limited batch processing for 63 sites
- **Dark Flat Design** — Professional dark theme with responsive layout, Inter font, and mobile sidebar collapse

### Technical Details
- React 18 + Vite 6 frontend
- Express 4 backend with VRM API proxy
- Chart.js for data visualization
- PostgreSQL via `pg` package (Railway) with `JSONB` storage
- In-memory snapshot cache + daily energy tracker (14-day retention)
- Background polling every 5 minutes with 3 req/s rate limit compliance

### VRM Data Sources
| Attribute | Code | Source |
|-----------|------|--------|
| Battery SOC | `SOC` / `bs` | Battery Monitor / System Overview |
| Battery Voltage | `V` / `bv` | Battery Monitor / System Overview |
| Battery Current | `I` / `bc` | Battery Monitor / System Overview |
| Battery Temp | `BT` / `bT` | Battery Monitor / System Overview |
| Solar Power | `ScW` / `Pdc` | Solar Charger / System Overview |
| Yield Today | `YT` | Solar Charger |
| Yield Yesterday | `YY` | Solar Charger |
| Charge State | `ScS` | Solar Charger |
| Consumed Ah | `CE` | Battery Monitor |
