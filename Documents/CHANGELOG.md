# Changelog

All notable changes to BIGView OMNI.

---

## [1.5.0] — 2026-03-06

### Added
- **Enhanced Morning Digest** — Complete redesign of daily email digest with 5 actionable sections: Yesterday's Fleet Performance (complete 24-hour metrics from DB), Current Status (real-time online count + avg SOC), Needs Attention (Critical vs Watch priorities), Performance Highlights (top/bottom performers), and Network Summary (signal + high usage).
- **User Digest Subscriptions** — System users can now opt-in to daily digest emails via checkbox in Settings → User Management. New `digest_enabled` column in users table. Recipients merged with environment variable recipients and deduplicated.
- **SendGrid Configuration Status** — Settings page now displays SendGrid API key status (configured/not configured) with visual indicator showing API key prefix and recipient count.
- **Test Email Endpoint** — `POST /api/test-email` with `type` parameter (alert/digest/geofence) allows admins to test email delivery with sample data.
- **IC2-Only Trailer Counting** — Digest now includes IC2-only trailers (network hardware without VRM) in fleet size breakdown (e.g., "91 trailers: 87 VRM + 4 IC2-only"). Counts pepwaveCache devices not in snapshotCache and not at HQ.
- **Digest Preview Modal** — Settings page digest section now shows preview in a popup modal instead of inline accordion.

### Changed
- **Yesterday's Complete Metrics** — Digest shifted from current snapshot data to yesterday's complete 24-hour metrics queried from `daily_energy_summary` and `pepwave_snapshots` tables. Shows EOD SOC, total yield, data usage with "Yesterday's Fleet Performance" heading.
- **Priority-Based Action Items** — Digest separates Critical items (dispatch now: SOC <20%, active alarms, offline 24h+) from Watch items (monitor today: SOC 20-40%, energy deficits 5+ days) for clearer urgency signaling.
- **Performance Insights** — Added top performers (>100% yield) and underperformers (<70% yield) sections with yield percentage calculations from `daily_energy_summary`.
- **Digest Subject Line** — Changed from "Daily Digest" to "Morning Digest for [date]" for clarity.
- **Deployed Trailer Counting** — Digest fleet size now queries `trailer_assignments` table with HQ exclusion filter instead of counting snapshotCache entries (was showing 39 instead of 91).

### Technical Details
- **buildDigestData() Rebuild** (`server/server.js` line 4388):
  ```javascript
  // Query yesterday's complete energy data
  const energyResult = await db.query(`
      SELECT
          AVG(soc_start_of_day) as avg_soc,
          SUM(yield_wh) / 1000.0 as total_yield_kwh,
          COUNT(*) as trailer_count
      FROM daily_energy_summary
      WHERE date = $1
  `, [yesterdayStr]);

  // Count IC2-only trailers
  let ic2OnlyCount = 0;
  for (const [deviceName, pw] of pepwaveCache) {
      if (!snapshotCache.has(pw.site_id || deviceName)) {
          const jobSiteId = trailerJobSites.get(pw.site_id);
          if (!jobSiteId || !hqJobSiteIds.has(jobSiteId)) {
              ic2OnlyCount++;
          }
      }
  }

  // Query top/bottom performers
  const perfResult = await db.query(`
      SELECT site_name, yield_wh / 1000.0 as yield_kwh,
             expected_yield_wh / 1000.0 as expected_kwh,
             CASE WHEN expected_yield_wh > 0
                  THEN (yield_wh::float / expected_yield_wh * 100)
                  ELSE 0 END as percent
      FROM daily_energy_summary
      WHERE date = $1 AND expected_yield_wh > 0
      ORDER BY percent DESC
  `, [yesterdayStr]);
  ```
- **Email Template Sections** (`server/email.js` line 233):
  - Yesterday's Performance: 4 metrics (fleet size breakdown, avg EOD SOC, total yield, data usage)
  - Current Status: Online count, current avg SOC
  - Needs Attention: Critical table (dispatch now) + Watch table (monitor today)
  - Performance Highlights: Top performers >100%, Underperformers <70%
  - Network Summary: Avg signal, high usage >500MB
- **User Subscriptions**: `digest_enabled` column added to users table, Settings page checkbox requires email address, `scheduleDigest()` queries subscribed users and merges with env recipients

---

## [1.4.0] — 2026-03-05

### Added
- **DC Load Monitoring** — Real-time DC load power tracking across all trailers with V×I derivation when direct measurement unavailable. 3-tier fallback: VRM `Pc` diagnostic → `solar - (V×I)` → `IL×V`. Displayed in Load column (FleetOverview), DC Load chart (TrailerDetail), total load KPI (JobSiteDetail), and trailer mini-cards.
- **Tech Status System** — Separate 3-state actionable status (Good/Watch/Needs Attention) for field techs alongside Intelligence grades. Triggers: critical SOC, active alarms, energy deficit streaks, SOC decline rate, offline detection. Summary bar with clickable filter cards on FleetOverview.
- **VRM Diagnostic Dashboard** — Promoted 10 diagnostic fields from JSONB to dedicated DB columns: `dc_load_watts`, `load_current`, `consumed_ah`, `mppt_state`, `lifetime_yield_kwh`, `alarm_reason`, `error_code`, `inverter_mode`, `load_state`, `time_to_go_min`. Surfaced in TrailerDetail gauges, alarms banner, and DC Load chart.
- **Slim Stat Bars** — Replaced large Fleet KPI cards with compact single-line stat bars (e.g., "53 sites · 62/111 online · 83.6% avg SOC · 95.0 kWh yield · 1 at risk"). Deployment status inline with colored dots and clickable filters. Saves ~120px vertical space.
- **Deployed Only Toggle** — "Deployed only" checkbox in All Trailers view to hide HQ trailers (defaults to checked). Uses job site assignment data to identify HQ vs deployed trailers.

### Changed
- **List View Default** — Fleet dashboard now defaults to list view instead of grid for faster scanning.
- **Consolidated Table** — Fleet table reduced from 13 to 8 columns (Status, Trailer, Job Site, SOC, Solar, Load, Network, Grade) for cleaner reading.
- **Deployment Stats** — Deployment bar now shows "92 trailers on 53 sites" instead of just site counts.
- **Battery Power Derivation** — `battery_power` snapshot field now uses V×I derivation when `P` diagnostic unavailable (was incorrectly falling back to `Pdc` solar power). Fixes AI analysis context and DB accuracy.
- **IC2-only Device Handling** — IC2-only Pepwave devices now count as "online" when their router is reachable (was deflating online/total ratio). Tech status map keys changed from `pw:DeviceName` to negative device ID (`-dev.id`) to match `/api/sites` format.

### Fixed
- **DC Load Column Empty** — Trailers lacked BMV/SmartShunt, so VRM `Pc` and `P` diagnostics were unavailable. Derivation now uses BMS current (`I`/`bc`) × voltage from CANBUS data. Verified against VRM dashboard (84W shown = 87W calculated).
- **Tech Status Filter Mismatch** — "9 need attention" but filter showed only 2. IC2-only devices used incompatible map keys preventing frontend lookup.
- **Trailers Online Count** — Was 62/111 (excluding IC2-only devices). Now correctly counts IC2-only devices as online when Pepwave is reachable.

### Technical Details
- **V×I Derivation Logic** (`server/server.js` lines 2591-2606):
  ```javascript
  // Battery power: P (from BMV) or derive from V × I
  const solarW = extractDiagValue(records, 'ScW') ?? extractDiagValue(records, 'Pdc');
  let battPower = extractDiagValue(records, 'P');
  if (battPower === null && batteryVoltage !== null) {
      const battCurrent = extractDiagValue(records, 'I') ?? extractDiagValue(records, 'bc');
      if (battCurrent !== null) battPower = Math.round(batteryVoltage * battCurrent);
  }
  // DC load = solar - battery_power
  if (solarW !== null && battPower !== null) {
      dcLoadW = Math.round(Math.max(0, solarW - battPower));
  }
  ```
- **Hardware Note**: Trailers use LiFePO4 BMS → CANBUS → Cerbo GX pipeline. No BMV/SmartShunt means `P` (battery power) and `Pc` (DC load) diagnostics unavailable from VRM. Current (`I`/`bc`) and voltage (`V`/`bv`) provided by BMS over CANBUS.
- **Tech Status Computation** (`computeTechStatus` in `server/server.js`): SOC thresholds, alarm/error presence, energy deficit streaks (from `computeAlerts`), SOC trend analysis (3-day regression), offline detection.
- **Frontend Null Handling**: All dc_load_watts displays use `snapshot?.dc_load_watts != null ? value : '—'` pattern across FleetOverview, TrailerDetail, JobSiteDetail, TrailerCard.

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
