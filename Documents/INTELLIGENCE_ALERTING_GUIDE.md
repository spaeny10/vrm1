# Intelligence Analysis & Alerting System Guide
## BIGView OMNI Fleet Management Platform

**Version:** 1.5.0+
**Last Updated:** March 8, 2026
**Audience:** Field Technicians, Operations Managers, Fleet Supervisors

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Tech Status System](#tech-status-system)
3. [Energy Deficit Detection](#energy-deficit-detection)
4. [Solar Performance Score](#solar-performance-score)
5. [Alert & Notification System](#alert--notification-system)
6. [Where Data is Displayed](#where-data-is-displayed)
7. [Daily Morning Digest](#daily-morning-digest)
8. [Action Queue](#action-queue)
9. [How to Interpret Intelligence Data](#how-to-interpret-intelligence-data)
10. [Common Scenarios & Troubleshooting](#common-scenarios--troubleshooting)

---

## System Overview

BIGView OMNI continuously monitors ~110 solar security trailers across ~53 construction job sites. The **Intelligence Analysis & Alerting System** automatically detects problems and prioritizes actions for field technicians.

### Key Components

| Component | Purpose |
|-----------|---------|
| **Tech Status** | 3-state actionable status (Good/Watch/Needs Attention) |
| **Energy Deficit Alerts** | Detects multi-day solar shortages (smart filtering for throttled days) |
| **Solar Score** | Location-aware solar performance rating (0-100%) |
| **Action Queue** | Priority-sorted task list on Dashboard |
| **Morning Digest** | Daily email with yesterday's metrics + action items |
| **Real-time Monitoring** | Battery SOC, solar power, DC load, network status |

### Data Sources

- **Victron VRM API** - Solar system data (MPPT, battery, inverter)
- **Pepwave InControl2** - Network device tracking (signal, data usage)
- **Open-Meteo Weather API** - Expected solar yield based on location
- **PostgreSQL Database** - Historical data, daily summaries, alert history

---

## Tech Status System

### What It Is

**Tech Status** is a separate 3-state actionable indicator for field technicians, distinct from the Intelligence grades (A-F).

### Three States

| Status | Badge Color | Meaning | Action Required |
|--------|-------------|---------|-----------------|
| **Good** | 🟢 Green | All systems nominal | Monitor normally |
| **Watch** | 🟡 Orange | Potential issue developing | Monitor closely |
| **Needs Attention** | 🔴 Red | Critical issue requiring dispatch | Dispatch technician immediately |

### Triggers

#### **Needs Attention (Critical - Dispatch Now)**

Triggered when ANY of these conditions are met:

1. **Critical SOC** - Battery below 20%
2. **Active VRM Alarm** - Alarm or error code present
3. **Energy Deficit Streak ≥5 days** - Consecutive real deficit days (see [Energy Deficit Detection](#energy-deficit-detection))
4. **SOC Declining Fast** - Projected to reach critical (<20%) within 3 days
5. **Offline 24+ hours** - No VRM or network data

**Example Reasons:**
- "Critical SOC: 18%"
- "Alarm: High battery temperature"
- "Energy deficit: 5 day streak"
- "SOC declining 4.2%/day — critical in ~2d"

#### **Watch (Monitor Today)**

Triggered when ANY of these conditions are met:

1. **Low SOC** - Battery 20-40%
2. **SOC Declining Moderately** - Declining >2%/day (but not critical-imminent)
3. **Energy Deficit Streak 2-4 days** - Short-term deficit pattern
4. **Offline <24 hours** - Recently lost connection

**Example Reasons:**
- "Low SOC: 32%"
- "SOC declining 2.8%/day"
- "Energy deficit: 3 day streak"

#### **Good (All Clear)**

No critical or watch conditions met. Trailer is operating normally.

### Where Tech Status Appears

- **Dashboard** - Tech Status summary bar (clickable filter cards)
- **Fleet Table** - Status column with colored dots
- **Trailer Cards** - Status dot in upper corner
- **Action Queue** - Critical items generate high-priority actions
- **Morning Digest** - "Needs Attention" section lists critical trailers

---

## Energy Deficit Detection

### What It Is

A **deficit** occurs when daily energy consumption exceeds solar generation (consumed_wh > yield_wh). The system tracks consecutive deficit days and generates alerts when patterns indicate potential energy shortage.

### Intelligent Deficit Classification (NEW)

**Problem:** Not all deficits indicate energy shortage. When batteries are full and MPPT enters Float/Storage mode, solar production is intentionally throttled — creating small deficits that are actually **good battery management**, not problems.

**Solution:** The system now distinguishes between two types of deficits:

#### **1. Real Deficit** ⚠️

Indicates actual energy shortage requiring attention.

**Criteria:** Deficit that does NOT meet all throttling conditions.

**Examples:**
- 2 kWh deficit with 70% EOD SOC, MPPT in Bulk mode
- 1.5 kWh deficit with 60% EOD SOC, MPPT in Absorption mode
- Large deficit (>1 kWh) even if batteries full

**Action:** Monitor and investigate. May need panel cleaning, load reduction, or battery servicing.

#### **2. Idle-Throttled Deficit** 🔋

Small deficit caused by MPPT throttling when batteries are full. **Not a problem.**

**Criteria:** ALL three conditions must be met:
- ✅ End-of-day SOC ≥88% (high battery)
- ✅ MPPT state: Float (5) or Storage (6)
- ✅ Deficit <1 kWh (small surplus/deficit)

**Examples:**
- 0.8 kWh deficit with 95% EOD SOC, MPPT Float
- 0.3 kWh deficit with 92% EOD SOC, MPPT Storage

**Action:** None. This is normal behavior when batteries are full and excess solar is throttled.

### Alert Thresholds

| Streak Length | Severity | Tech Status | Action |
|---------------|----------|-------------|--------|
| **≥5 real deficit days** | 🔴 Critical | Needs Attention | Dispatch immediately |
| **3-4 real deficit days** | 🟠 Warning | Watch | Monitor closely |
| **2 real deficit days** | 🟡 Caution | Watch | Monitor |
| **<2 days** | ✅ No alert | Good | Normal monitoring |

**Important:** Idle-throttled days **break** the deficit streak. Only consecutive **real** deficit days count toward alerts.

### Deficit Calculation Methods

The system uses a 3-tier fallback strategy to calculate daily consumption:

| Tier | Method | Source | Accuracy |
|------|--------|--------|----------|
| **1** | CE Diagnostic | Victron CE (Consumed Ah × Voltage) | Most accurate |
| **2** | DC Power Accumulation | DC load watts × elapsed time (Riemann sum) | High accuracy |
| **3** | SOC Delta Estimate | `yield - battery_charge_change` | Fallback estimate |

**Note:** CE resets to 0 when battery synchronizes at 100% SOC, so Tier 2 or 3 is used in those cases.

### Where Deficit Data Appears

1. **Dashboard Action Queue** - Priority 1-3 for critical deficits
2. **Energy Page** - Detailed alert cards with daily breakdown
3. **Fleet Table** - "Energy Deficit" alerts in Action Queue count
4. **Trailer Detail** - Energy balance charts show daily yield vs consumed
5. **Morning Digest** - "Needs Attention" section lists deficit alerts
6. **Email Alerts** - Sent when new alert triggered (rate-limited to 1 per 6 hours per trailer)

### Visual Indicators

**In Energy Page alert cards:**
```
Alert: Trailer 582 - 3 Day Streak (WARNING)

Date        Yield    Consumed  Balance
Mar 5       9.2 kWh  10.1 kWh  -0.9 kWh 🔋 Throttled
Mar 6       8.5 kWh  10.3 kWh  -1.8 kWh
Mar 7       7.8 kWh   9.5 kWh  -1.7 kWh

[View Details]
```

- **Orange muted row** = Throttled deficit (not counted in streak)
- **🔋 Throttled badge** = Hover for details (EOD SOC, MPPT state, deficit amount)
- **Red deficit row** = Real deficit (counts toward streak)

**In Action Queue:**
```
Energy Deficit — 3 day streak
Trailer 582 (includes throttled days)
```

**In Email Alerts:**
- Throttled days have orange `THROTTLED` badge in table
- Footer explains throttling logic

---

## Solar Performance Score

### What It Is

**Solar Score** is a location-aware performance rating (0-100%) that compares actual solar yield to expected yield based on weather conditions.

### Calculation

```
Solar Score = (Actual Yield Today / Expected Yield Today) × 100%
```

**Expected Yield** is calculated using:
- **GPS coordinates** (latitude/longitude from Pepwave IC2)
- **Solar panel specs** (3× 435W panels = 1,305W total)
- **Weather data** (cloud cover, solar irradiance from Open-Meteo API)
- **System efficiency** (80% default)

### Throttling Adjustment (NEW)

When MPPT is in Float/Storage mode with high SOC, the score adjusts upward to account for intentional solar throttling:

**Conditions for adjustment:**
- MPPT state: Float (5) or Storage (6)
- Battery SOC ≥ throttle threshold (configurable, default 90%)
- Current score < excellent threshold (default 90%)

**Adjustment logic:**
```
Best estimate = MAX(current score, 7-day avg score, panel health indicator)
Adjusted score = MIN(best estimate, 100%)
Floor: If SOC ≥ floor threshold (default 95%), score ≥ floor score (default 85%)
```

**Reason codes:**
- `throttled_full_battery` - Adjusted based on best estimate
- `full_battery_floor` - Score floored at minimum threshold

### Score Grades

| Score | Grade | Badge Color | Meaning |
|-------|-------|-------------|---------|
| **90-100%** | Excellent | 🟢 Green | Optimal performance |
| **70-89%** | Good | 🟡 Yellow | Acceptable performance |
| **50-69%** | Fair | 🟠 Orange | Below expected, investigate |
| **<50%** | Poor | 🔴 Red | Significant underperformance |

### Where Solar Score Appears

1. **Analytics Page** - Fleet Intelligence table, solar score column
2. **Trailer Detail** - Solar Score card in Intelligence section
3. **Morning Digest** - Top/bottom performers based on yesterday's score
4. **Fleet Table** - Intelligence grade column (derived from solar + other factors)

### Transparency Fields

All solar score data includes transparency fields for troubleshooting:

- `score` - Final adjusted score (what's displayed)
- `raw_score` - Original calculated score before throttling adjustment
- `throttled` - Boolean indicating if MPPT throttling detected
- `score_adjustment_reason` - Why score was adjusted (if applicable)

**Example:**
```
Solar Score: 92% (Excellent)
Raw: 78% (adjusted: throttled_full_battery)
```

---

## Alert & Notification System

### Alert Types

| Alert Type | Source | Priority | Notification |
|------------|--------|----------|--------------|
| **Energy Deficit** | Consecutive real deficit days ≥2 | 1-5 (by severity) | Email + Action Queue |
| **Critical SOC** | Battery <20% | 1 | Action Queue only |
| **VRM Alarm/Error** | Active alarm or error code | 1 | Action Queue only |
| **Battery Temp Critical** | >50°C or <0°C | 2 | Action Queue only |
| **Signal Weak** | <-100 dBm | 4 | Action Queue only |
| **Offline** | No data 24+ hours | 3 | Action Queue only |

### Email Notifications

**Trigger:** New energy deficit alert (≥2 real deficit days)

**Rate Limit:** 1 email per 6 hours per trailer (prevents spam)

**Recipients:**
- Environment variable `ALERT_EMAIL_RECIPIENTS`
- System users with `digest_enabled=true` (opt-in via Settings)

**Content:**
- Severity badge (CRITICAL/WARNING/CAUTION)
- Trailer name and ID
- Consecutive deficit day count
- Daily breakdown table (date, yield, consumed, deficit)
- Throttled badge on idle-throttled days
- Footer note explaining throttling logic (if applicable)

**Subject Line:**
```
[CRITICAL] Energy deficit — Trailer 582 (5 days)
```

### Alert Resolution

Alerts are automatically resolved when:
- Deficit streak breaks (surplus day or throttled day)
- Battery SOC recovers (for SOC alerts)
- Alarm/error clears (for VRM alerts)

**Resolution email** is sent when alert clears.

### Alert History

All alerts are logged in the `alert_history` database table:

- `created_at` - When alert first triggered
- `resolved_at` - When alert cleared (NULL if still active)
- `severity` - Critical/warning/caution
- `streak_days` - Number of consecutive real deficit days
- `deficit_wh` - Total cumulative deficit (Wh)
- `last_notified_at` - Last email sent timestamp (for rate limiting)

---

## Where Data is Displayed

### 1. Dashboard (Fleet Overview)

**URL:** `/`

#### Fleet KPI Bar
- **Fleet Size** - "92 trailers: 87 VRM + 5 IC2-only"
- **Online/Total** - "62/92 online"
- **Average SOC** - "83.6%"
- **Total Yield** - Today's fleet-wide solar generation
- **At Risk** - Count of trailers needing attention

#### Tech Status Summary Bar
Clickable filter cards:
- 🟢 **Good** (82) - Click to filter list to Good trailers
- 🟡 **Watch** (7) - Click to filter list to Watch trailers
- 🔴 **Needs Attention** (3) - Click to filter list to critical trailers

#### Deployment Status Bar
- **Actively Billing** (45 trailers)
- **Standby** (32 trailers)
- **Available at HQ** (10 trailers)
- **Awaiting Pickup** (5 trailers)

#### Action Queue
Priority-sorted task list showing:
- Priority badge (1-5, color-coded)
- Category icon (🔋 battery, ☀️ solar, 📡 network, ⚠️ alert)
- Title (e.g., "Energy Deficit — 3 day streak")
- Subtitle (trailer name)
- Throttle annotation (if deficit includes throttled days)
- Acknowledge button (✓ mark as acknowledged)

**Sorting:** Priority 1 (critical) at top, priority 5 at bottom.

#### Fleet Table/Grid
**Table columns:**
- Status (tech status dot)
- Trailer (name + ID)
- Job Site (location)
- SOC (battery %)
- Solar (current watts + yield today)
- Load (DC load watts)
- Network (signal strength + carrier)
- Grade (intelligence grade A-F)

**Grid cards:**
- Status dot in corner
- Trailer name
- Job site
- SOC gauge
- Solar/Load metrics
- Grade badge

### 2. Energy Page

**URL:** `/energy` (legacy)

**Alert Cards:**
- Severity badge (CRITICAL/WARNING/CAUTION)
- Trailer name
- "X Day Streak" label
- Expand button to show daily breakdown
- **Daily breakdown table:**
  - Date, Yield, Consumed, Balance columns
  - Throttled rows have muted background
  - 🔋 Throttled badge with tooltip
  - Red negative balance for deficits

### 3. Fleet Details Page

**URL:** `/fleet`

**Intelligence Tab (default):**
- Solar Performance section
  - Solar score with transparency (raw score, throttled flag)
  - 7-day average score
  - Panel performance % (current watts / max watts)
  - Expected daily yield
- Energy Balance section
  - Today's yield vs consumed
  - Yesterday's performance
- Autonomy section
  - Days of autonomy at current consumption
  - Projected days until critical SOC

**Alerts Tab:**
- All active alerts for the fleet
- Severity, trailer, reason, duration

### 4. Trailer Detail Page

**URL:** `/trailer/:id`

#### Gauges Section (top)
- **Battery SOC** - Percentage with color-coding
- **Battery Voltage** - Volts with nominal range
- **Solar Power** - Current watts with max watts
- **DC Load** - Current consumption

#### Alert Banner (if active)
```
⚠ Alarm: High battery temperature
⛔ Error: MPPT communication lost
```

#### Intelligence Section
**Solar Score Card:**
- Score percentage with grade badge
- Raw score (if throttled)
- 7-day average
- Panel performance %
- Transparency tooltip

**Energy Balance Card:**
- Bar chart: yield (green) vs consumed (red)
- Today and yesterday
- Surplus/deficit label

**Predictive SOC Card (if declining):**
- Current SOC
- Decline rate (%/day)
- Days until critical (<20%)
- Warning/critical badge

#### Historical Charts
- **SOC Trend** - Last 7 days, line chart
- **DC Load** - Last 24 hours, area chart
- **Solar Yield** - Last 7 days, bar chart
- **Battery Voltage** - Last 7 days, line chart

### 5. Analytics Page

**URL:** `/analytics`

**Fleet Intelligence Table:**
- Trailer name
- Solar score (%, grade badge, raw score if throttled)
- 7-day avg score
- Panel performance %
- Energy today (yield/consumed)
- Autonomy (days)
- Grade (A-F)

**Fleet KPIs:**
- Avg Solar Score
- Avg Autonomy
- Underperforming count (<70% score)
- Low Autonomy count (<3 days)

**Performance Insights:**
- Top performers (>100% expected yield)
- Bottom performers (<70% expected yield)

### 6. Map View

**URL:** `/map`

**Interactive Map:**
- Job site markers (clustered by GPS proximity)
- Trailer pins with status color
- Click marker → popup with trailer details
- Filter by deployment status

### 7. Maintenance Page

**URL:** `/maintenance`

**Maintenance Logs:**
- Date, trailer, job site
- Issue description
- Resolution notes
- Parts used (with costs)
- Technician name
- Status (Scheduled/In Progress/Complete)

### 8. Settings Page

**URL:** `/settings`

**Sections:**
- User Management (roles, digest opt-in)
- Solar Score Configuration (thresholds)
- GPS Verification (IC2 device linking)
- SendGrid Status (email configuration)
- Data Retention (purge old data)
- Analytics Backfill (recalculate metrics)

---

## Daily Morning Digest

### What It Is

A comprehensive daily email sent every morning at 6:00 AM (local time) summarizing yesterday's fleet performance and today's action items.

### Recipient Management

**Two recipient groups:**
1. **Environment variable** - `DIGEST_EMAIL_RECIPIENTS` (comma-separated)
2. **User opt-in** - System users with `digest_enabled=true` checkbox in Settings

Recipients are merged and deduplicated automatically.

### Email Sections

#### **1. Yesterday's Fleet Performance**

Complete 24-hour metrics from database (NOT current snapshot):

- **Fleet Size** - "92 trailers: 87 VRM + 5 IC2-only"
- **Avg EOD SOC** - End-of-day battery percentage
- **Total Solar Yield** - Fleet-wide generation (kWh)
- **Total Data Usage** - Network consumption (GB)
- **Trailers Reporting** - How many provided data

**Data Source:** `daily_energy_summary` table for yesterday's date + `pepwave_snapshots` for data usage.

#### **2. Current Status**

Real-time snapshot taken when digest builds:

- **Online Now** - "62/92 online"
- **Current Avg SOC** - Latest battery percentages

#### **3. Needs Attention**

Two priority levels:

**Critical (Dispatch Now):**
- SOC <20%
- Active VRM alarms
- Offline 24+ hours

**Watch (Monitor Today):**
- SOC 20-40%
- Energy deficit ≥5 real days (NEW: only real deficits, excludes throttled)
- SOC declining >2%/day

Each item shows: trailer name, reason, metric value.

#### **4. Performance Highlights**

**Top Performers (>100% expected yield):**
- Trailer name
- Yield vs Expected (e.g., "12.3 kWh / 11.0 kWh")
- Percentage (112%)

**Underperformers (<70% expected yield):**
- Trailer name
- Yield vs Expected
- Percentage (62%)

**Data Source:** `daily_energy_summary.yield_wh` vs `expected_yield_wh` for yesterday.

#### **5. Network Summary**

- **Avg Signal Strength** - Fleet-wide average (dBm)
- **High Data Usage** - Devices >500 MB yesterday
  - Device name
  - Data used (MB)
  - Carrier

### Subject Line

```
Morning Digest for March 8, 2026
```

### Test Digest Endpoint

**API:** `POST /api/test-email` with `{"type": "digest"}`

Sends a test digest with sample data to verify email configuration.

---

## Action Queue

### What It Is

The **Action Queue** is a priority-sorted task list on the Dashboard that consolidates all actionable items requiring technician attention.

### Priority Levels

| Priority | Color | Urgency | Examples |
|----------|-------|---------|----------|
| **1** | 🔴 Red | Critical - Dispatch now | Energy deficit critical, critical SOC |
| **2** | 🔴 Red | High - Today | Battery temp critical, offline 24h+ |
| **3** | 🟠 Orange | Medium - This week | Energy deficit warning, weak signal |
| **4** | 🟡 Yellow | Low - Monitor | Solar underperforming |
| **5** | 🟡 Yellow | Info - FYI | Network usage high |

### Action Sources

Actions are automatically generated from:

1. **Energy Deficit Alerts** - From `computeAlerts()`
   - Priority 1 (critical), 3 (warning), 5 (caution)

2. **Intelligence Flags** - From VRM diagnostics
   - Battery temp critical (Priority 2)
   - Load power excessive (Priority 4)

3. **Network Issues** - From Pepwave data
   - Signal weak <-100 dBm (Priority 4)
   - High data usage >1 GB/day (Priority 5)

4. **Offline Detection** - From timestamp staleness
   - Offline 24+ hours (Priority 3)

### Action Structure

Each action includes:
- `key` - Unique identifier (e.g., `alert:582`, `battery_temp:583`)
- `priority` - 1-5 numeric priority
- `category` - 'energy', 'battery', 'solar', 'network'
- `title` - Short description (e.g., "Energy Deficit — 3 day streak")
- `subtitle` - Trailer name
- `severity` - 'critical', 'warning', 'caution' (for alerts)
- `details` - Additional context (streak days, deficit breakdown, etc.)
- `acknowledged_at` - Timestamp if technician marked as acknowledged

### Acknowledgment System

Technicians can **acknowledge** actions to:
- Mark as "seen" without resolving
- Move to "Acknowledged" section (collapsed by default)
- Track who reviewed the action and when

**To acknowledge:** Click ✓ button on action item.

**Note:** Acknowledgment does NOT resolve the underlying issue. Alert persists until root cause is fixed (e.g., deficit streak breaks).

### Action Queue Display

**Unacknowledged actions (top):**
- Sorted by priority (1 → 5)
- Limit: Top 10 shown, "Show more" button if >10
- Red/orange/yellow badges
- Category icons

**Acknowledged actions (bottom, collapsed):**
- Shows all acknowledged items
- Dimmed appearance
- "Acknowledged on [date]" timestamp
- Can unacknowledge if needed

---

## How to Interpret Intelligence Data

### Reading Tech Status

**Question:** "What does 🟡 Watch mean?"

**Answer:** Trailer has a developing issue (low SOC 20-40%, moderate deficit streak, or declining SOC >2%/day). Monitor closely today, but not critical yet.

**Next Steps:**
1. Check Action Queue for specific reason
2. Review Trailer Detail page for trends
3. If issue worsens, dispatch technician

---

### Understanding Deficit Alerts

**Question:** "Why does the alert say '3 day streak' but the table shows 4 days?"

**Answer:** The 4th day is marked 🔋 Throttled. This means it had a small deficit (<1 kWh) with high SOC (≥88%) and MPPT in Float/Storage mode — indicating the MPPT was **intentionally throttling** excess solar because batteries were full. This is **not a problem**, so it doesn't count toward the alert streak.

**Action:** Focus on the 3 real deficit days. Ignore throttled days.

---

### Interpreting Solar Score

**Question:** "Score shows 92% but raw score is 78%. Why the difference?"

**Answer:** MPPT was in Float mode with high SOC (batteries full), so solar production was intentionally throttled. The system adjusted the score upward based on recent averages and panel health indicators. The trailer is actually performing well; the low raw score is due to throttling, not panel issues.

**Action:** None needed. This is normal when batteries are full.

---

### Reading Energy Balance Charts

**Question:** "Yield is lower than consumed for 3 days. Is this bad?"

**Answer:** Depends on the deficit size and end-of-day battery state:

- **Small deficits (<1 kWh) + high EOD SOC (≥88%) + MPPT Float:** Normal throttling, not a problem
- **Larger deficits + declining SOC + MPPT Bulk/Absorption:** Real energy shortage, investigate

Check for 🔋 Throttled badges to distinguish between the two scenarios.

---

### Offline vs. Offline (Network Only)

**Question:** "Trailer shows 'offline' but has an IC2-only tag. What does that mean?"

**Answer:**
- **Offline** = No VRM data AND no network data (completely dark)
- **Network Online** = Pepwave router is reachable but VRM is not transmitting (power issue or Cerbo GX offline)
- **IC2-only** = Trailer has network hardware but no VRM solar monitoring installed

**Action:**
- Offline = Check power, cellular signal, or hardware failure
- Network Online = Check Cerbo GX, VRM credentials, or wiring
- IC2-only = No action, this is expected configuration

---

## Common Scenarios & Troubleshooting

### Scenario 1: False Positive Deficit Alert

**Symptom:** Trailer has 3-day deficit alert, but EOD SOC is always >90% and MPPT is in Float.

**Diagnosis:** Old data before intelligent deficit detection was implemented. System will auto-resolve when new deficit pattern is detected (or surplus day occurs).

**Action:** Verify via Trailer Detail page:
1. Check current SOC and MPPT state
2. Review last 3 days' yield vs consumed
3. If all recent deficits are <1 kWh with high SOC, alert will clear automatically
4. No technician dispatch needed

**Prevention:** New alerts only trigger on **real** deficits (throttled deficits excluded).

---

### Scenario 2: Energy Deficit with Declining SOC

**Symptom:** Trailer has 5-day deficit alert, SOC declining from 85% → 72% → 58% → 45% → 32%.

**Diagnosis:** Real energy shortage. Consumption exceeds generation consistently.

**Possible Causes:**
- Dirty/damaged solar panels (reduced yield)
- Excessive DC load (new equipment added?)
- Weather (extended cloudy/rainy period)
- Battery degradation (capacity loss)
- Shading (trees, buildings, obstructions)

**Action (Priority 1 - Dispatch Now):**
1. Inspect and clean solar panels
2. Measure DC load (compare to baseline)
3. Check for new equipment drawing power
4. Test battery capacity (may need replacement)
5. Verify panel angles and shading

---

### Scenario 3: Battery Temp Critical in Summer

**Symptom:** Battery temp >50°C alert during afternoon.

**Diagnosis:** High ambient temperature + solar charging heat.

**Possible Causes:**
- Poor ventilation in battery enclosure
- Direct sunlight on battery box
- Thermal insulation inadequate
- Battery fan failure

**Action (Priority 2 - Today):**
1. Check battery enclosure ventilation
2. Verify cooling fans are operational
3. Measure ambient temp inside enclosure
4. Consider adding insulation or shade
5. Monitor temp trend (does it cool at night?)

---

### Scenario 4: Weak Signal (-105 dBm)

**Symptom:** Signal strength consistently <-100 dBm, slow data speeds.

**Diagnosis:** Poor cellular coverage at job site.

**Possible Causes:**
- Remote location (far from cell tower)
- Obstructions (buildings, hills, trees)
- Antenna misalignment
- Carrier congestion

**Action (Priority 4 - This Week):**
1. Check antenna cables and connections
2. Reorient external antenna (point toward nearest tower)
3. Consider carrier switch (if other carriers have better coverage)
4. Add signal booster if needed
5. Document signal strength baseline for this location

---

### Scenario 5: Throttled Days Breaking Streak

**Symptom:** Trailer had 4-day deficit, but alert cleared after adding a 5th deficit day.

**Diagnosis:** The 5th day was an idle-throttled deficit (EOD SOC ≥88%, MPPT Float, <1 kWh deficit). This breaks the streak per intelligent deficit detection logic.

**Explanation:** The system prioritizes **real energy shortage** detection. When batteries end the day full and MPPT is throttling, that's good battery management, not a problem. The streak resets.

**Action:** None. This is expected behavior. Monitor for new real deficit days starting tomorrow.

---

### Scenario 6: Solar Score Poor but Panels Clean

**Symptom:** Solar score 45% (Poor), but panels were just cleaned and weather was sunny.

**Diagnosis:** Possible panel damage, wiring issue, or MPPT misconfiguration.

**Action (Priority 3 - This Week):**
1. Measure open-circuit voltage (VOC) at panels (~45V per panel)
2. Measure short-circuit current (ISC) at panels (~11A per panel)
3. Check MC4 connections and wiring integrity
4. Verify MPPT charge settings (bulk/absorption voltages)
5. Inspect panels for physical damage (cracks, delamination, hot spots)
6. Compare to neighboring trailers' performance

---

### Scenario 7: VRM Alarm - Low Battery Voltage

**Symptom:** VRM alarm "Low battery voltage" appears.

**Diagnosis:** Battery voltage dropped below alarm threshold (typically 23V for 24V system).

**Possible Causes:**
- Battery deeply discharged (low SOC)
- Battery cell failure (capacity loss)
- High DC load draining battery faster than solar can recharge
- Charger malfunction (not charging)

**Action (Priority 1 - Dispatch Now):**
1. Check current battery voltage and SOC
2. Verify MPPT is charging (check charge state, solar power)
3. Measure DC load current (excessive load?)
4. Test battery health (voltage under load, capacity test)
5. If battery voltage <20V, may need immediate replacement to prevent damage

---

### Scenario 8: Offline 24+ Hours

**Symptom:** Trailer shows offline, no VRM or network data for 24+ hours.

**Diagnosis:** Complete system offline (power loss, hardware failure, or cellular outage).

**Possible Causes:**
- Battery fully discharged (system shut down)
- Cerbo GX power loss (fuse blown, wiring issue)
- Pepwave router offline (power loss, cellular modem failure)
- Cellular service outage (carrier network down)

**Action (Priority 3 - Today):**
1. Visit job site to inspect trailer
2. Check battery voltage at terminals
3. Verify Cerbo GX and Pepwave have power (LEDs)
4. Check all fuses and circuit breakers
5. Test cellular signal strength manually
6. Power cycle equipment if needed
7. Check for physical damage (theft, vandalism, weather)

---

## Best Practices for Technicians

### Daily Routine

**Morning:**
1. Read Morning Digest email (reviews yesterday, action items today)
2. Check Dashboard Action Queue (top 10 priorities)
3. Filter Tech Status to 🔴 Needs Attention (critical trailers)
4. Acknowledge actions you're aware of (prevents duplicate work)

**During Day:**
5. Dispatch to critical trailers (Priority 1-2 items)
6. Monitor Watch trailers remotely (Priority 3-4 items)
7. Update maintenance logs for work completed

**Evening:**
8. Review resolved alerts (action queue should shrink)
9. Flag persistent issues for management review

### Using Action Queue Effectively

**✅ DO:**
- Sort by priority (system does this automatically)
- Acknowledge items you've reviewed (prevents confusion)
- Click trailer names to jump to Trailer Detail for more context
- Use deficit alert details (expand card) to see daily breakdown
- Look for 🔋 Throttled badges (those days don't need action)

**❌ DON'T:**
- Ignore Priority 1 alerts (critical = dispatch immediately)
- Acknowledge without reviewing details (defeats purpose)
- Assume all deficits are problems (check for throttling)
- Dispatch to throttled-only deficits (waste of time)

### Interpreting Deficit Alerts

**Quick decision tree:**

```
Is there a 🔋 Throttled badge?
├─ Yes → Check if ALL deficit days are throttled
│  ├─ All throttled? → No action needed (will auto-resolve)
│  └─ Some real deficits? → Investigate real deficit days only
└─ No throttled days → Real energy shortage, investigate
```

**Key questions to ask:**
1. What is the current battery SOC? (if <40%, dispatch)
2. What is the SOC trend? (declining = worse, stable = monitor)
3. How many **real** deficit days? (ignore throttled)
4. What is the deficit size? (>2 kWh/day = significant)
5. What is the MPPT state? (Bulk = charging hard, Float = throttling)

### Communicating with Management

**When escalating issues:**
- Reference specific action queue items (priority, trailer name)
- Include deficit streak length (real days only)
- Note SOC trend (declining X%/day)
- Mention recent weather (cloudy week = lower yield expected)
- Provide estimated resolution time

**Example escalation:**
```
Priority 1 Alert: Trailer 582 at Aurora North
- 5-day real energy deficit (excludes 2 throttled days)
- SOC declining 4.2%/day (85% → 68% → 52% → 35% → 18%)
- Current SOC: 18% (critical)
- Root cause: Panels 40% covered in dust/dirt
- Action: Dispatching tech for panel cleaning today
- ETA resolution: End of day
```

---

## Glossary

| Term | Definition |
|------|------------|
| **SOC** | State of Charge (battery %, 0-100%) |
| **EOD** | End-of-Day (snapshot taken at midnight or last reading) |
| **MPPT** | Maximum Power Point Tracker (solar charge controller) |
| **Bulk** | MPPT charging stage (batteries <80%, max current) |
| **Absorption** | MPPT charging stage (batteries 80-95%, constant voltage) |
| **Float** | MPPT maintenance stage (batteries >95%, trickle charge) |
| **Storage** | MPPT storage stage (batteries full, minimal charge) |
| **Deficit** | Day when consumption > solar yield |
| **Real Deficit** | Deficit indicating energy shortage (not throttled) |
| **Idle-Throttled Deficit** | Small deficit due to MPPT throttling when batteries full |
| **Streak** | Consecutive days of real deficit (throttled days break streak) |
| **Tech Status** | 3-state actionable indicator (Good/Watch/Needs Attention) |
| **Intelligence Grade** | A-F performance grade (separate from Tech Status) |
| **Solar Score** | Location-aware solar performance rating (0-100%) |
| **Action Queue** | Priority-sorted task list on Dashboard |
| **Morning Digest** | Daily email with yesterday's metrics + action items |
| **IC2** | Pepwave InControl2 (network device management platform) |
| **VRM** | Victron Remote Management (solar system monitoring platform) |
| **Cerbo GX** | Victron data logger/gateway device |
| **kWh** | Kilowatt-hour (energy unit, 1000 watt-hours) |
| **dBm** | Decibel-milliwatts (signal strength unit, lower = weaker) |

---

## Support & Feedback

**Questions?** Contact your fleet operations manager or system administrator.

**Found a bug?** Report issues at: https://github.com/spaeny10/vrm1/issues

**Feature requests?** Discuss with management or submit via GitHub Issues.

---

**Document Version:** 1.0
**Last Updated:** March 8, 2026
**System Version:** BIGView OMNI v1.5.0+
