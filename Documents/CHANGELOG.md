# Changelog

All notable changes to BIGView OMNI.

---

## [1.3.0] — 2026-03-01

### Added
- **Google SSO** — "Sign in with Google" on the login page using Google Identity Services. Restricted to `@jetstreamsys.com` domain. New Google users are auto-provisioned with `viewer` role. Existing password login remains as fallback.
- **Role-Based Access Control (RBAC)** — Backend `requireRole` middleware now enforces permissions on all mutation endpoints. Three roles: `admin` (full access), `technician` (field operations), `viewer` (read-only).
- **Fleet Deployment Management** — Full deployment lifecycle tracking (Deliver → Active → Call-off → Pickup) with 4 date columns per job site, HQ exclusion from KPIs, deployment KPI row on dashboard, and deployment status filters on the map.
- **Clickable Deployment KPIs** — Dashboard deployment status cards (Actively Billing, Standby, Available at HQ, Awaiting Pickup) filter the site list when clicked.

### Changed
- **Viewer role restricted** — Viewers can no longer modify job sites, maintenance logs, components, GPS settings, action queue acknowledgments, or system settings. Edit controls are hidden in the UI and blocked by backend middleware.
- **Admin-only operations** — Data retention, purge, GPS re-clustering, analytics backfill, and embedding generation now require `admin` role.
- **Action Queue collapsed by default** — Action Queue section on the dashboard starts folded.

### Security
- 15 backend endpoints now enforce `requireRole` (was 9 before). All mutation endpoints are protected.
- Frontend edit controls (buttons, dropdowns, date pickers, forms) are hidden or disabled for viewers across Settings, Dashboard, Maintenance, TrailerDetail, and JobSiteDetail pages.
- Google ID tokens verified server-side via `google-auth-library` with domain restriction.
- Users table extended with `google_id` and `email` columns for SSO account linking.

---

## [1.2.0] — 2026-02-28

### Added
- **IC2 Device ID Binding** — Persistent GPS binding using IC2 `dev.id` instead of fragile name matching. Stored in `ic2_device_id` column on `trailer_assignments`. Auto-persists on first successful name match.
- **GPS Resolver** — `resolveIc2DeviceToSiteId()` function checks stored linkage first, falls back to name match, and auto-persists the binding for future polls.
- **Manual IC2 Linking** — Settings → GPS Verification now shows IC2 Device column with "Link" button for unlinked devices. Dropdown lets you bind any unlinked IC2 device to a trailer.
- **Unlinked Devices Endpoint** — `GET /api/gps/unlinked-devices` returns IC2 devices not yet linked to a trailer.
- **Link Device Endpoint** — `POST /api/gps/link-device` manually binds an IC2 device to a VRM site.
- **Intelligence Tooltips** — All column headers in the Intelligence table now have explanatory tooltips describing what each metric measures.
- **Geographic Query Guidance** — FLEET_SCHEMA updated with instructions to use `job_sites.address` for state/location filtering instead of site names. Added note that HQ is in Kansas.

### Changed
- **Rebranded to BIGView OMNI** — App name changed to "BIGView OMNI — Fleet Management" throughout (sidebar, login, loading screen, page title, package.json).
- **Official BIGView Logo** — Mountain logo replaced with official BIGView company logo.
- **Intelligence Tab Default** — Intelligence tab moved to first position in Fleet Details and set as the default active tab.
- **IC2 as Sole GPS Authority** — VRM poll no longer writes GPS coordinates. IC2 Peplink is the exclusive source of GPS data. VRM only seeds GPS cache if IC2 hasn't provided coordinates yet.
- **Dashboard Spacing** — Increased gaps between KPI cards (20px), action queue padding (20px 24px), site grid gap (20px), and fleet controls margin.
- **Action Queue Badges** — Fixed summary badges ("3 critical", "0 acknowledged") that were clipped by the 26px fixed width of circular priority badges. Added `width: auto` and `white-space: nowrap`.
- **Fleet Stats Updated** — FLEET_SCHEMA corrected from "~63 trailers across ~15 sites" to "~110 trailers across ~53 sites".

### Fixed
- **GPS Data Accuracy** — VRM was overwriting accurate IC2 GPS with stale VRM coordinates every 30s. IC2 now has exclusive GPS authority.
- **Geographic Query Accuracy** — "How many trailers are in Colorado?" incorrectly included "Big View HQ" (in Kansas) because the AI was matching on site names instead of addresses.
- **Action Queue Badge Overflow** — Summary pill badges inherited a fixed 26px width from circular list badges, causing text to be clipped.

---

## [1.1.0] — 2026-02-26

### Added
- **Map View** — Interactive Leaflet map showing all trailer locations with GPS coordinates
- **Maintenance Page** — Drag-and-drop maintenance task management with checklists, costs, and scheduling
- **Job Site Detail** — Per-site view grouping trailers by GPS proximity into job sites
- **Trailer Detail** — Per-trailer view with battery/solar gauges, historical charts, and system intelligence
- **GPS Verification** — Settings page section for verifying and refreshing GPS data from IC2
- **Authentication** — JWT-based login with role-based access control (admin/viewer)
- **Network Analytics** — Pepwave signal strength, carrier tracking, and data usage monitoring
- **Solar Score** — Location-aware solar performance scoring using Open-Meteo weather data
- **Energy Analysis** — Daily yield vs consumption comparison with bar charts
- **Action Queue** — Priority-sorted energy deficit alerts with acknowledgment tracking

---

## [1.0.0] — 2026-02-23

### Added
- **Fleet Overview** — Dashboard showing all Victron VRM sites with KPI cards (SOC, voltage, solar, yield), search, sort, and filter controls
- **Site Detail** — Per-site view with battery/solar gauges, historical charts (SOC, voltage, solar), alarms list, and connected devices table
- **Energy Analysis** — Daily solar yield vs consumption comparison with grouped bar chart, site selector, and fleet-wide energy summary table
- **Deficit Alerts** — Automatic detection of sites where consumption exceeds solar yield for 2+ consecutive days, with severity levels (caution/warning/critical)
- **Settings** — Database status display, data retention period selector, and manual purge controls
- **PostgreSQL Backend** — Persistent data storage via Railway's PostgreSQL plugin, with in-memory cache fallback for local development
- **VRM API Integration** — Diagnostics-based polling (1 API call per site every 30s), rate-limited batch processing
- **Dark Flat Design** — Professional dark theme with responsive layout, Inter font, and mobile sidebar collapse

### Technical Details
- React 18 + Vite 6 frontend
- Express 4 backend with VRM API proxy
- Chart.js for data visualization
- PostgreSQL via `pg` package (Railway) with `JSONB` storage
- In-memory snapshot cache + daily energy tracker (14-day retention)
- Background polling with rate limit compliance

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
