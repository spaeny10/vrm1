# Solar Score — Complete Calculation Detail

The Solar Score answers: **"How well is this trailer's solar system performing relative to what it _should_ produce given its location, weather, and time of year?"**

A score of 85% means the trailer is producing 85% of what is physically expected at that GPS location, on that day, with current weather conditions.

---

## Hardware Specs (Constants)

All trailers share the same hardware configuration:

| Spec | Value |
|------|-------|
| Solar panels | 3 x 435W = **1,305W total capacity** |
| Batteries | 2 x 230Ah 24V = **11,040Wh (11.04 kWh) total** |
| System efficiency | **80%** (accounts for wiring losses, temperature derating, inverter losses) |
| Usable battery capacity | **8,832Wh** (above 20% minimum SOC threshold) |

These are defined in the `TRAILER_SPECS` constant in `server/server.js`.

---

## Calculation Steps

### Step 1 — Determine Peak Sun Hours (PSH)

**Peak Sun Hours** represent how many hours of equivalent full-strength 1,000 W/m² sunlight hit the trailer's location today. This is the most important variable — it changes dramatically by geography, season, and weather.

| Location & Season | Typical PSH |
|-------------------|-------------|
| Arizona, June | ~7-8 hours |
| Texas, March | ~5-6 hours |
| Michigan, December | ~2-3 hours |
| Cloudy day anywhere | 1-3 hours |

#### Primary Method: Open-Meteo Weather API

The system uses [Open-Meteo](https://open-meteo.com/) (free, no API key required) to get real solar radiation data:

**API call:**
```
https://api.open-meteo.com/v1/forecast
  ?latitude={lat}&longitude={lon}
  &daily=shortwave_radiation_sum,sunshine_duration
  &current=cloud_cover
  &timezone=auto
  &forecast_days=1
```

**Data returned:**
- `shortwave_radiation_sum` — total solar energy in **MJ/m²** (megajoules per square meter)
- `sunshine_duration` — seconds of sunshine today
- `cloud_cover` — current cloud cover percentage

**PSH conversion:**
```
PSH = shortwave_radiation_sum (MJ/m²) ÷ 3.6
```
This works because 1 kWh/m² = 3.6 MJ/m², and 1 PSH = 1 kWh/m².

**Caching:**
- Results are cached for **1 hour** per GPS location
- GPS coordinates are rounded to 0.1° for cache keys (trailers at the same job site share weather data)

#### Fallback Method: Astronomical Calculation

If Open-Meteo is unreachable, the system uses a pure-math calculation based on latitude and day of year:

1. **Solar declination angle:**
   ```
   δ = 23.45° × sin(360/365 × (284 + dayOfYear))
   ```
   This models Earth's axial tilt — the sun is higher in summer, lower in winter.

2. **Sunset hour angle:**
   ```
   ω = arccos(-tan(latitude) × tan(δ))
   ```
   Determines when the sun rises and sets at this latitude on this day.

3. **Day length:**
   ```
   DL = 2 × ω / 15 hours
   ```

4. **Clear-sky PSH estimate:**
   ```
   PSH = DL × 0.60
   ```
   The 0.60 factor accounts for atmospheric attenuation (the atmosphere absorbs/scatters ~40% of solar energy even on clear days).

**Edge cases:**
- `cos(ω) > 1` → polar night (PSH = 0)
- `cos(ω) < -1` → midnight sun (PSH = 12)

**Note:** The astronomical method assumes clear skies and does not account for clouds or weather. It is only used when the weather API is unavailable.

#### Last Resort Default

If no GPS coordinates exist for the trailer, PSH defaults to **5.0 hours** (approximate US average).

### Step 2 — Calculate Expected Daily Yield

```
Expected Daily Yield (Wh) = PSH × 1,305W × 0.80
```

The 0.80 system efficiency factor accounts for:
- DC wiring losses (~2-3%)
- Panel temperature derating (~5-10% in hot conditions)
- Charge controller conversion losses (~3-5%)
- Dust/dirt on panels (~2-5%)
- Other system losses

**Examples:**

| PSH | Calculation | Expected Yield |
|-----|-------------|----------------|
| 2.5h (winter, north) | 2.5 × 1,305 × 0.80 | 2,610 Wh |
| 5.0h (average) | 5.0 × 1,305 × 0.80 | 5,220 Wh |
| 7.5h (summer, south) | 7.5 × 1,305 × 0.80 | 7,830 Wh |

### Step 3 — Get Actual Yield Today

The actual solar yield comes from VRM telemetry data:

```
Actual Yield (Wh) = snapshot.solar_yield_today (kWh) × 1,000
```

This value is updated in real-time from the Victron VRM API and represents total energy produced by the solar panels since midnight.

### Step 4 — Calculate Solar Score

```
Solar Score = (Actual Yield Today Wh / Expected Daily Yield Wh) × 100
```

**Score labels:**

| Score Range | Label | Interpretation |
|-------------|-------|----------------|
| 90%+ | **Excellent** | Performing at or above expectation for location + weather |
| 70–89% | **Good** | Normal, healthy operation |
| 50–69% | **Fair** | Possible shading, dirt, misalignment, or partial panel failure |
| Below 50% | **Poor** | Significant underperformance — investigate panels |

**Note:** Scores above 100% are possible. This can happen when:
- Open-Meteo forecast underestimated actual radiation
- Astronomical fallback assumed clouds that didn't materialize
- Brief periods of above-rated panel output (cool temperatures increase panel efficiency)

### Step 5 — 7-Day Average Score

To smooth out single-day anomalies (a cloudy morning, a brief storm), the system also calculates a rolling 7-day average:

```
Avg 7d Yield = average of daily yield (Wh) over past 7 days
Avg 7d Score = (Avg 7d Yield / Expected Daily Yield) × 100
```

The 7-day average is more reliable for identifying true performance issues vs. weather-related dips. A trailer with a low single-day score but a healthy 7-day average is likely fine. A trailer with a consistently low 7-day average needs attention.

---

## Why Location-Aware Scoring Matters

Without location awareness, a fixed "expected yield" (e.g., assuming 5h PSH everywhere) creates misleading results:

| Trailer | Location | PSH | Actual Yield | Fixed 5h Score | Location-Aware Score |
|---------|----------|-----|-------------|----------------|---------------------|
| T-101 | Phoenix, AZ (June) | 8.0 | 6,500 Wh | 124% | 78% (Good) |
| T-205 | Detroit, MI (Dec) | 2.5 | 2,200 Wh | 42% | 84% (Good) |
| T-318 | Dallas, TX (March) | 5.5 | 2,000 Wh | 38% | 35% (Poor) |

- **T-101** looks amazing with a fixed score but is actually underperforming for Arizona summer sun
- **T-205** looks broken with a fixed score but is actually performing well for Michigan winter
- **T-318** correctly shows as poor in both cases — it's genuinely underperforming

The location-aware score tells you which trailers actually need attention regardless of where they are.

---

## Related Metrics

The intelligence system also computes these values using the same spec and location data:

| Metric | Formula | Purpose |
|--------|---------|---------|
| **Panel Performance %** | `(current_solar_watts / 1,305W) × 100` | Instantaneous output vs rated capacity |
| **Days of Autonomy** | `stored_energy_Wh / avg_daily_consumption_Wh` | How long batteries last with no sun |
| **Charge Time to Full** | `remaining_to_full_Wh / current_solar_watts` | Estimated hours to reach 100% SOC |
| **Energy Balance** | `yield_today_Wh - consumed_today_Wh` | Net energy gain/loss for the day |
| **Stored Energy** | `11,040Wh × SOC% / 100` | Current energy in batteries (Wh) |

---

## Data Sources

| Data | Source | Update Frequency |
|------|--------|------------------|
| GPS coordinates | VRM diagnostic codes (`lt`/`lg`) | Every polling cycle (~60s) |
| Solar radiation / PSH | Open-Meteo API | Cached 1 hour per location |
| Actual yield, SOC, solar watts | Victron VRM API | Every polling cycle (~60s) |
| Daily energy history | Internal `dailyEnergy` Map | Accumulated throughout the day |
| Astronomical PSH | Calculated from latitude + date | Computed on demand (fallback only) |

---

## Where Solar Score Appears in the UI

1. **Analytics Page** — Fleet Intelligence table showing all trailers sorted by any column including Solar Score and 7-day average
2. **Trailer Detail Page** — System Intelligence section with score card, weather context, and energy balance visualization
3. **Fleet Overview** — KPI row showing fleet average Solar Score and count of underperforming trailers
4. **AI Analysis** — Claude-powered analysis references the Solar Score when generating recommendations
5. **Query Bar** — Natural language queries like "which trailers are underperforming?" use intelligence data
