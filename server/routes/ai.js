import { TRAILER_SPECS, anthropic } from '../config.js';
import { getAllContentForEmbedding, getBatteryHistory, getEmbeddingStats, getMaintenanceStats, getUpcomingMaintenance, semanticSearch, upsertEmbedding } from '../db.js';
import { embedAlerts, embedJobSites, embedMaintenanceLogs, embedPepwaveDevices, embedSiteSnapshots, generateQueryEmbedding, isConfigured as isEmbeddingsConfigured } from '../embeddings.js';
import { hasVrmData, todayStr } from '../lib/util.js';
import { aiLimiter, requireRole } from '../middleware/auth.js';
import { computeAlerts } from '../services/alerts.js';
import { computeTrailerIntelligence } from '../services/intelligence.js';
import { dailyEnergy, dbAvailable, dbPool, pepwaveCache, pgvectorAvailable, snapshotCache } from '../state.js';

// ============================================================
// Natural Language Query (Claude-powered)
// ============================================================
const FLEET_SCHEMA = `
You are a fleet data assistant for a solar-powered trailer monitoring system.
The system tracks ~110 trailers across ~53 construction job sites. HQ is in Kansas.
"Site" = construction job site. "Trailer" = individual VRM solar installation.

Database tables:

1. site_snapshots — VRM power data (one row per trailer per 5-min poll)
   Columns: id SERIAL, site_id INTEGER, site_name TEXT, timestamp BIGINT (ms),
   battery_soc REAL (0-100%), battery_voltage REAL (V), battery_current REAL (A),
   battery_temp REAL (°C), battery_power REAL (W), solar_watts REAL (W),
   solar_yield_today REAL (kWh), solar_yield_yesterday REAL (kWh), charge_state TEXT,
   consumed_ah REAL (consumed amp-hours from CE diagnostic, most accurate consumption),
   dc_load_watts REAL (DC load power in watts), load_current REAL (load amps),
   load_state TEXT (on/off), inverter_mode TEXT, mppt_state TEXT,
   alarm_reason TEXT, error_code TEXT, lifetime_yield_kwh REAL (cumulative solar kWh),
   time_to_go_min REAL (Victron TTG estimate in minutes)

2. pepwave_snapshots — Pepwave network data (one row per device per 5-min poll)
   Columns: id SERIAL, device_name TEXT, timestamp BIGINT (ms),
   online BOOLEAN, signal_bar INTEGER (0-5), rsrp REAL (dBm, good > -90, fair > -105, poor < -105),
   rsrq REAL (dB), rssi REAL (dBm), sinr REAL (dB, higher=better),
   carrier TEXT, technology TEXT (LTE/5G/etc), usage_mb REAL (cumulative MB),
   tx_mb REAL, rx_mb REAL, client_count INTEGER, uptime INTEGER (seconds), wan_ip TEXT

3. job_sites — Construction locations (one row per physical location)
   Columns: id SERIAL, name TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
   address TEXT, status TEXT ('active'|'standby'|'completed'), notes TEXT,
   uid TEXT, customer_name TEXT, primary_contact_name TEXT, primary_contact_phone TEXT,
   primary_contact_email TEXT, secondary_contact_name TEXT, secondary_contact_phone TEXT, secondary_contact_email TEXT,
   created_at BIGINT (ms), updated_at BIGINT (ms)

4. trailer_assignments — Links trailers to job sites
   Columns: id SERIAL, site_id INTEGER (VRM idSite, UNIQUE), site_name TEXT,
   job_site_id INTEGER REFERENCES job_sites(id), latitude DOUBLE PRECISION,
   longitude DOUBLE PRECISION, manual_override BOOLEAN, assigned_at BIGINT (ms)

5. maintenance_logs — Service/repair tracking
   Columns: id SERIAL, job_site_id INTEGER REFERENCES job_sites(id), site_id INTEGER (trailer, nullable),
   visit_type TEXT ('inspection'|'repair'|'scheduled'|'emergency'|'installation'|'decommission'),
   status TEXT ('scheduled'|'in_progress'|'completed'|'cancelled'),
   title TEXT, description TEXT, technician TEXT,
   scheduled_date BIGINT (ms), completed_date BIGINT (ms),
   labor_hours REAL, labor_cost_cents INTEGER, parts_cost_cents INTEGER,
   parts_used JSONB, created_at BIGINT (ms), updated_at BIGINT (ms)

6. analytics_daily_metrics — Pre-computed daily aggregates per trailer
   Columns: id SERIAL, date DATE, site_id INTEGER, avg_soc REAL, min_soc REAL, max_soc REAL,
   solar_yield_kwh REAL, avg_voltage REAL, avg_signal_bar REAL, data_usage_mb REAL,
   uptime_percent REAL, created_at BIGINT (ms). UNIQUE(site_id, date)

7. daily_energy_summary — Daily solar yield and consumption per trailer
   Columns: site_id INTEGER, date DATE, site_name TEXT, yield_wh NUMERIC (solar Wh),
   consumed_wh NUMERIC (consumption Wh), soc_start_of_day REAL, expected_yield_wh NUMERIC,
   consumption_source TEXT ('CE diagnostic'|'DC power accumulation'|'SOC delta estimate'),
   battery_soc_eod REAL (end-of-day battery SOC %), mppt_state_eod INTEGER (0-7: 0=Off, 3=Bulk, 4=Absorption, 5=Float, 6=Storage),
   updated_at BIGINT (ms). PRIMARY KEY(site_id, date)

8. site_notes — Communications and log of interactions per job site
   Columns: id SERIAL, job_site_id INTEGER REFERENCES job_sites(id),
   note TEXT, author TEXT, created_at BIGINT (ms)

   Energy Deficit Context:
   - A "deficit" occurs when consumed_wh > yield_wh on a given date
   - "Idle-throttled deficit": Small deficit (<1 kWh) with high EOD SOC (≥88%) and MPPT in Float/Storage (5/6)
     → Not a problem—just MPPT intentionally throttling excess solar when batteries are full
   - "Real deficit": Deficit not meeting throttle criteria—indicates potential energy shortage
   - Alerts only trigger on 2+ consecutive REAL deficit days (throttled days excluded)

IMPORTANT:
- site_snapshots.site_name matches pepwave_snapshots.device_name (they share trailer names)
- trailer_assignments.site_id matches site_snapshots.site_id
- trailer_assignments.site_name matches pepwave_snapshots.device_name
- To find trailers at a job site: JOIN trailer_assignments ta ON ta.job_site_id = job_sites.id
- Timestamps are epoch milliseconds. Use to_timestamp(timestamp/1000) for date ops.
- Costs in maintenance_logs are in cents (divide by 100 for dollars).
- Always LIMIT results to 50 rows max.
- Only generate SELECT queries. Never INSERT, UPDATE, DELETE, DROP, ALTER, or any DDL/DML.
- For "latest" queries, use DISTINCT ON or subqueries with MAX(timestamp).
- For daily aggregations, group by DATE(to_timestamp(timestamp/1000)).
- PostgreSQL REAL columns: cast to numeric for round(): round(column::numeric, 2)
- For geographic queries (e.g. "trailers in Colorado"), use job_sites.address which contains city/state info. Match on state name: WHERE js.address ILIKE '%Colorado%'. Do NOT match on job site name alone — names like "Big View HQ" don't indicate state.
- job_sites.name may include city and state (e.g. "Aurora, Colorado") OR be a custom name (e.g. "Big View HQ"). Always use the address field for state/location filtering.

Trailer hardware specs: ${TRAILER_SPECS.solar.panels}x ${TRAILER_SPECS.solar.panel_watts}W solar panels (${TRAILER_SPECS.solar.total_watts}W total), ${TRAILER_SPECS.battery.count}x ${TRAILER_SPECS.battery.ah_per_battery}Ah ${TRAILER_SPECS.battery.voltage}V batteries (${TRAILER_SPECS.battery.total_wh}Wh / ${(TRAILER_SPECS.battery.total_wh / 1000).toFixed(1)} kWh total storage).

Intelligence vocabulary (available in live context below):
- "solar score" → actual yield vs location+weather-adjusted expected yield (0-100+%)
- "solar efficiency" → same as solar score
- "days of autonomy" → stored Wh / avg daily consumption Wh
- "underperforming trailers" → those with 7-day avg solar score below 50%
- "panel performance" → instantaneous solar watts / rated ${TRAILER_SPECS.solar.total_watts}W capacity

Examples:
- "trailers at Downtown site" → JOIN trailer_assignments + job_sites WHERE js.name ILIKE '%downtown%'
- "how many trailers does X have" → JOIN trailer_assignments ta ON ta.job_site_id = js.id WHERE js.customer_name ILIKE '%X%'
- "read notes for site X" → JOIN site_notes sn ON sn.job_site_id = js.id WHERE js.name ILIKE '%X%'
- "which sites have most maintenance costs" → SUM(labor_cost_cents + parts_cost_cents) from maintenance_logs GROUP BY job_site_id
- "low battery trailers" → DISTINCT ON site_snapshots for latest where battery_soc < 30
- "site rankings by SOC" → analytics_daily_metrics AVG(avg_soc) GROUP BY site_id, JOIN job_sites
- "data usage this week" → aggregate pepwave_snapshots usage_mb grouped by device_name
- "underperforming trailers" → use intelligence metrics from live context
- "what's the solar score for trailer X" → use intelligence metrics from live context
`;

export function registerAiRoutes(app) {

// ============================================================
// Agentic Analysis: Claude-powered trailer intelligence
// ============================================================
app.post('/api/analyze/trailer/:id', aiLimiter, async (req, res) => {
    if (!anthropic) {
        return res.status(501).json({ error: 'Claude API key not configured' });
    }

    const siteId = parseInt(req.params.id);
    const snapshot = snapshotCache.get(siteId);
    if (!snapshot) {
        return res.status(404).json({ error: 'Trailer not found or no data' });
    }

    try {
        const intel = await computeTrailerIntelligence(siteId);
        const alerts = computeAlerts().filter(a => a.site_id === siteId);
        const energyHistory = dailyEnergy.get(siteId) || {};

        // Find matching Pepwave device
        let pepwaveDevice = null;
        for (const [name, device] of pepwaveCache.entries()) {
            if (name === snapshot.site_name) { pepwaveDevice = device; break; }
        }

        // Get battery health trend from DB
        let batteryTrend = null;
        if (dbAvailable) {
            try {
                const dataPoints = await getBatteryHistory(siteId, 30);
                if (dataPoints.length >= 3) {
                    const n = dataPoints.length;
                    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
                    for (let i = 0; i < n; i++) {
                        const y = dataPoints[i].min_soc ?? dataPoints[i].avg_soc ?? 0;
                        sumX += i; sumY += y; sumXY += i * y; sumXX += i * i;
                    }
                    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
                    batteryTrend = {
                        direction: slope < -0.5 ? 'declining' : slope > 0.5 ? 'improving' : 'stable',
                        daily_change_pct: Math.round(slope * 100) / 100,
                        data_points: n,
                    };
                }
            } catch { }
        }

        // Helper to format nullable values for AI context
        const fmt = (val, unit = '') => val != null ? `${val}${unit}` : 'N/A';

        // Determine consumption data source for this trailer
        const todayEnergy = energyHistory[todayStr()] || {};
        const consumptionSource = todayEnergy.consumption_source || 'unavailable';

        // Build context for Claude
        const ctx = [
            `TRAILER: ${snapshot.site_name} (ID: ${siteId})`,
            `TIMESTAMP: ${new Date().toISOString()}`,
            '',
            '=== HARDWARE SPECIFICATIONS ===',
            `Solar: ${TRAILER_SPECS.solar.panels}x ${TRAILER_SPECS.solar.panel_watts}W panels = ${TRAILER_SPECS.solar.total_watts}W total capacity`,
            `Battery: ${TRAILER_SPECS.battery.count}x ${TRAILER_SPECS.battery.ah_per_battery}Ah ${TRAILER_SPECS.battery.voltage}V = ${TRAILER_SPECS.battery.total_wh}Wh (${(TRAILER_SPECS.battery.total_wh / 1000).toFixed(1)} kWh)`,
            `System efficiency factor: ${TRAILER_SPECS.solar.system_efficiency * 100}%`,
            '',
            '=== LOCATION & WEATHER ===',
            `GPS: ${intel.location.latitude ?? 'unknown'}, ${intel.location.longitude ?? 'unknown'}`,
            `Peak Sun Hours: ${intel.location.peak_sun_hours}h (source: ${intel.location.data_source})`,
            `Cloud Cover: ${intel.location.cloud_cover_pct !== null ? intel.location.cloud_cover_pct + '%' : 'unknown'}`,
            `Expected Daily Yield: ${fmt(intel.location.expected_daily_yield_wh, 'Wh')}`,
            '',
            '=== LIVE READINGS ===',
            `Battery SOC: ${fmt(snapshot.battery_soc, '%')}`,
            `Battery Voltage: ${fmt(snapshot.battery_voltage, 'V')}`,
            `Battery Current: ${fmt(snapshot.battery_current, 'A')}`,
            `Battery Temp: ${fmt(snapshot.battery_temp, '°C')}`,
            `Battery Power: ${fmt(snapshot.battery_power, 'W')}`,
            `Solar Power (now): ${fmt(snapshot.solar_watts, 'W')}`,
            `Solar Yield Today: ${fmt(snapshot.solar_yield_today, ' kWh')}`,
            `Solar Yield Yesterday: ${fmt(snapshot.solar_yield_yesterday, ' kWh')}`,
            `Charge State: ${fmt(snapshot.charge_state)}`,
            '',
            '=== DEVICE STATUS ===',
            `DC Load Power (now): ${fmt(snapshot.dc_load_watts, 'W')}`,
            `Load Current: ${fmt(snapshot.load_current, 'A')}`,
            `Load Output: ${fmt(snapshot.load_state)}`,
            `Inverter Mode: ${fmt(snapshot.inverter_mode)}`,
            `Alarm Reason: ${snapshot.alarm_reason != null ? snapshot.alarm_reason : 'None'}`,
            `Error Code: ${snapshot.error_code != null ? snapshot.error_code : 'None'}`,
            `MPPT State: ${fmt(snapshot.mppt_state)}`,
            `Lifetime Yield: ${fmt(snapshot.lifetime_yield_kwh, ' kWh')}`,
            `Time to Go (Victron estimate): ${snapshot.time_to_go_min != null ? `${Math.round(snapshot.time_to_go_min / 60 * 10) / 10} hours` : 'N/A'}`,
            `Firmware: ${fmt(snapshot.firmware_version)}`,
            '',
            '=== COMPUTED INTELLIGENCE ===',
            `Yesterday's Solar Score: ${fmt(intel.solar.score, '%')} (${intel.solar.score_label ?? 'N/A'}) — completed day, location+weather adjusted`,
            `${intel.solar.throttled ? '  ⚡ MPPT was throttled (battery full) — score adjusted for idle/float curtailment' : ''}`,
            `${intel.solar.raw_score !== null && intel.solar.raw_score !== intel.solar.score ? `  Raw score before adjustment: ${intel.solar.raw_score}%` : ''}`,
            `7-Day Avg Score: ${fmt(intel.solar.avg_7d_score, '%')} — use this alongside yesterday's score for trend analysis`,
            `Today's Live Score (partial day): ${fmt(intel.solar.today_live_score, '%')} — still accumulating, do NOT use for performance evaluation`,
            `Panel Performance (now): ${fmt(intel.solar.panel_performance_pct, '%')} of ${TRAILER_SPECS.solar.total_watts}W rated`,
            `Days of Autonomy: ${fmt(intel.battery.days_of_autonomy)}`,
            `Est. Charge Time to Full: ${intel.battery.charge_time_hours ? intel.battery.charge_time_hours + 'h' : 'N/A'}`,
            `Battery Temp Status: ${fmt(intel.battery.temp_status)}`,
            `Stored Energy: ${fmt(intel.battery.stored_wh, 'Wh')} of ${TRAILER_SPECS.battery.total_wh}Wh`,
            `Avg Daily Consumption: ${fmt(intel.energy.avg_daily_consumption_wh, 'Wh')}`,
            `Consumption Data Source: ${consumptionSource}`,
            `Today Balance: ${fmt(intel.energy.today_balance_wh, 'Wh')}`,
        ];

        if (batteryTrend) {
            ctx.push('', '=== BATTERY HEALTH TREND (30 days) ===');
            ctx.push(`Direction: ${batteryTrend.direction}`);
            ctx.push(`Daily SOC change: ${batteryTrend.daily_change_pct}%/day`);
        }

        if (alerts.length > 0) {
            ctx.push('', '=== ACTIVE ALERTS ===');
            for (const a of alerts) ctx.push(`Energy deficit streak: ${a.streak_days} days (${a.severity})`);
        }

        const energyDays = Object.entries(energyHistory).sort(([a], [b]) => b.localeCompare(a)).slice(0, 14);
        if (energyDays.length > 0) {
            ctx.push('', '=== DAILY ENERGY HISTORY (recent) ===');
            for (const [date, info] of energyDays) {
                ctx.push(`${date}: yield=${info.yield_wh !== null ? Math.round(info.yield_wh) : '?'}Wh, consumed=${info.consumed_wh !== null ? Math.round(info.consumed_wh) : '?'}Wh${info.consumption_source ? ' (' + info.consumption_source + ')' : ''}`);
            }
        }

        if (pepwaveDevice) {
            ctx.push('', '=== NETWORK STATUS ===');
            ctx.push(`Status: ${pepwaveDevice.online ? 'Online' : 'Offline'}`);
            ctx.push(`Signal: ${pepwaveDevice.cellular?.signal_bar ?? '?'}/5 bars`);
            ctx.push(`RSRP: ${pepwaveDevice.cellular?.signal?.rsrp ?? '?'} dBm`);
        }

        const systemPrompt = `You are an expert solar energy systems analyst for a fleet of construction site trailers.
Each trailer has ${TRAILER_SPECS.solar.panels}x ${TRAILER_SPECS.solar.panel_watts}W solar panels (${TRAILER_SPECS.solar.total_watts}W total) and ${TRAILER_SPECS.battery.count}x ${TRAILER_SPECS.battery.ah_per_battery}Ah ${TRAILER_SPECS.battery.voltage}V batteries (${(TRAILER_SPECS.battery.total_wh / 1000).toFixed(1)} kWh total storage).

Analyze the trailer data and provide:
1. STATUS SUMMARY (1-2 sentences: overall health assessment)
2. KEY FINDINGS (3-5 bullet points of the most important observations)
3. RECOMMENDATIONS (2-4 specific, actionable recommendations)
4. RISK ASSESSMENT (low/medium/high with brief explanation)

Consider:
- Evaluate solar performance using YESTERDAY'S SCORE (completed day) and the 7-DAY AVERAGE — do NOT use today's live score as it's a partial day still accumulating
- If the MPPT was throttled (idle/float due to full battery), note that reduced yield is expected behavior, not a problem
- Is the battery being drawn down faster than it charges?
- Are there signs of panel degradation or underperformance based on yesterday and the 7-day trend?
- How many days can this trailer run without sunlight?
- Any temperature or voltage concerns?
- Are there active alarms or error codes that need attention?
- What is the inverter mode and is the load output functioning?
- How reliable is the consumption data? (Check the "Consumption Data Source" — CE diagnostic is most accurate, DC power accumulation and SOC delta are estimates)
- If consumption data shows N/A, note that autonomy calculations are unavailable and recommend investigating load metering
- How does lifetime yield compare to expected cumulative production for the trailer's age?

Be specific with numbers. Reference the hardware specs. Keep under 400 words.
Respond in plain text with the section headers above.`;

        const msg = await anthropic.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 1200,
            messages: [{ role: 'user', content: ctx.join('\n') }],
            system: systemPrompt,
        });

        res.json({
            success: true,
            site_id: siteId,
            site_name: snapshot.site_name,
            analysis: msg.content[0].text,
            intelligence: intel,
            generated_at: new Date().toISOString(),
        });
    } catch (err) {
        console.error(`Analyze trailer ${siteId} error:`, err.message);
        res.status(500).json({ error: `Analysis failed: ${err.message}` });
    }
});

app.post('/api/query', aiLimiter, async (req, res) => {
    if (!anthropic) {
        return res.status(501).json({ error: 'Claude API key not configured' });
    }

    const { question } = req.body;
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
        return res.status(400).json({ error: 'Question is required' });
    }

    try {
        // Build real-time context from in-memory caches
        const deviceSummary = [];
        for (const [name, device] of pepwaveCache.entries()) {
            deviceSummary.push(`${name}: ${device.online ? 'online' : 'offline'}, signal=${device.cellular?.signal_bar ?? '?'}/5, rsrp=${device.cellular?.signal?.rsrp ?? '?'}dBm, clients=${device.client_count}, usage=${device.usage_mb}MB`);
        }
        const snapshotSummary = [];
        for (const [siteId, snap] of snapshotCache.entries()) {
            if (!hasVrmData(snap)) continue;
            snapshotSummary.push(`${snap.site_name || 'Site ' + siteId}: SOC=${snap.battery_soc}%, ${snap.battery_voltage}V, solar=${snap.solar_watts}W, charge=${snap.charge_state}, dcLoad=${snap.dc_load_watts ?? '?'}W, inverter=${snap.inverter_mode ?? '?'}, mppt=${snap.mppt_state ?? '?'}`);
        }

        // Build intelligence summary from computed metrics
        const intelSummary = [];
        for (const [siteId, snap] of snapshotCache) {
            if (!hasVrmData(snap)) continue;
            try {
                const intel = await computeTrailerIntelligence(siteId);
                if (intel) {
                    intelSummary.push(`${intel.site_name}: score=${intel.solar.score ?? '?'}%(${intel.solar.score_label ?? '?'}), autonomy=${intel.battery.days_of_autonomy ?? '?'}d, panel=${intel.solar.panel_performance_pct ?? '?'}%, PSH=${intel.location.peak_sun_hours}h`);
                }
            } catch { }
        }

        // Build maintenance context from DB
        let maintContext = '';
        if (dbAvailable) {
            try {
                const stats = await getMaintenanceStats();
                const upcoming = await getUpcomingMaintenance(14);
                maintContext = `\n\nMaintenance: ${stats.open_count || 0} open, ${stats.overdue_count || 0} overdue, ${stats.upcoming_week || 0} due this week`;
                if (upcoming.length > 0) {
                    maintContext += '\nUpcoming maintenance:\n' + upcoming.slice(0, 15).map(m => {
                        const d = m.scheduled_date ? new Date(Number(m.scheduled_date)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'no date';
                        return `- ${m.title} at ${m.job_site_name || 'unassigned'}, due ${d}, ${m.status}`;
                    }).join('\n');
                }
            } catch { }
        }

        const liveContext = `\nCurrent live data (${new Date().toISOString()}):\n` +
            `Pepwave devices (${deviceSummary.length} total):\n${deviceSummary.join('\n')}\n\n` +
            `VRM sites (${snapshotSummary.length} total):\n${snapshotSummary.join('\n')}` +
            (intelSummary.length > 0 ? `\n\nIntelligence metrics (specs: ${TRAILER_SPECS.solar.total_watts}W solar, ${TRAILER_SPECS.battery.total_wh}Wh battery per trailer):\n${intelSummary.join('\n')}` : '') +
            maintContext;

        const systemPrompt = FLEET_SCHEMA + liveContext + `\n\nRespond in this JSON format:\n{\n  "answer": "<human-readable answer to the question>",\n  "sql": "<optional SQL query if database lookup would help, or null>",\n  "data": null\n}\n\nIf you can answer from the live context alone, set sql to null and answer directly.\nIf a SQL query would give better/more complete data, include it. The system will execute it and ask you to refine the answer.\nAlways respond with valid JSON only, no markdown fences.`;

        const msg = await anthropic.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 1500,
            messages: [{ role: 'user', content: question }],
            system: systemPrompt,
        });

        let parsed;
        try {
            let text = msg.content[0].text;
            // Strip markdown code blocks if present
            const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (codeBlockMatch) {
                text = codeBlockMatch[1];
            }
            parsed = JSON.parse(text);
        } catch {
            // If Claude didn't return valid JSON, wrap the text as an answer
            parsed = { answer: msg.content[0].text, sql: null, data: null };
        }

        // If Claude generated a SQL query and DB is available, execute it
        if (parsed.sql && dbAvailable) {
            const sqlLower = parsed.sql.toLowerCase().trim();
            // Safety: only allow SELECT (including CTEs starting with WITH)
            if (!sqlLower.startsWith('select') && !sqlLower.startsWith('with')) {
                parsed.answer += '\n⚠️ Query was blocked for safety (non-SELECT detected).';
                parsed.sql = null;
            } else if (dbPool) {
                try {
                    const result = await dbPool.query(parsed.sql);
                    parsed.data = result.rows.slice(0, 50);

                    // Ask Claude to refine the answer with the actual data
                    const refinement = await anthropic.messages.create({
                        model: 'claude-sonnet-4-5-20250929',
                        max_tokens: 1000,
                        messages: [{
                            role: 'user',
                            content: `Original question: "${question}"\n\nSQL query returned ${result.rows.length} rows:\n${JSON.stringify(result.rows.slice(0, 20), null, 2)}\n\nProvide a clear, concise answer summarizing these results. Format as plain text, use bullet points if listing items. Keep it brief.`
                        }],
                        system: 'You are a fleet data assistant. Provide clear, concise answers about trailer fleet data. Use bullet points for lists. Include numbers and specifics. Keep answers under 200 words.',
                    });
                    parsed.answer = refinement.content[0].text;
                } catch (dbErr) {
                    parsed.answer += `\n⚠️ SQL execution failed: ${dbErr.message}`;
                    parsed.data = null;
                }
            }
        }

        res.json({
            success: true,
            question,
            answer: parsed.answer,
            sql: parsed.sql,
            data: parsed.data,
        });
    } catch (err) {
        console.error('Query error:', err.message);
        res.status(500).json({ error: `Query failed: ${err.message}` });
    }
});

// ============================================================
// Semantic Search Endpoint
// ============================================================
app.post('/api/search/semantic', async (req, res) => {
    if (!isEmbeddingsConfigured()) {
        return res.status(501).json({ error: 'Voyage API key not configured' });
    }

    if (!dbAvailable || !pgvectorAvailable) {
        return res.status(503).json({ error: 'Semantic search not available (pgvector required)' });
    }

    const { query, contentTypes, limit } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ error: 'Query is required' });
    }

    try {
        // Generate embedding for the search query
        const queryEmbedding = await generateQueryEmbedding(query);

        // Perform vector similarity search
        const results = await semanticSearch(
            queryEmbedding,
            contentTypes || null,
            limit || 20
        );

        // Use Claude to synthesize results into a natural answer
        let answer = '';
        if (anthropic && results.length > 0) {
            try {
                const resultsContext = results.slice(0, 10).map((r, i) =>
                    `${i + 1}. [${r.content_type}] ${r.content_text} (similarity: ${(r.similarity * 100).toFixed(1)}%)`
                ).join('\n');

                const msg = await anthropic.messages.create({
                    model: 'claude-sonnet-4-5-20250929',
                    max_tokens: 800,
                    messages: [{
                        role: 'user',
                        content: `User query: "${query}"\n\nMost relevant fleet data:\n${resultsContext}\n\nProvide a clear, concise answer based on these search results. Use bullet points if listing items. Keep it under 150 words.`
                    }],
                    system: 'You are a fleet data assistant. Provide clear answers about trailer fleet data based on semantic search results.',
                });
                answer = msg.content[0].text;
            } catch (claudeErr) {
                console.error('Claude synthesis failed:', claudeErr.message);
                // Fall back to raw results
                answer = `Found ${results.length} relevant results for "${query}".`;
            }
        } else {
            answer = results.length > 0
                ? `Found ${results.length} relevant results for "${query}".`
                : `No results found for "${query}".`;
        }

        res.json({
            success: true,
            query,
            answer,
            results: results.map(r => ({
                type: r.content_type,
                id: r.content_id,
                text: r.content_text,
                similarity: r.similarity,
                metadata: r.metadata,
            })),
            count: results.length,
        });
    } catch (err) {
        console.error('Semantic search error:', err.message);
        res.status(500).json({ error: `Search failed: ${err.message}` });
    }
});

// Get embedding stats
app.get('/api/embeddings/stats', async (req, res) => {
    try {
        if (!dbAvailable || !pgvectorAvailable) {
            return res.json({ success: true, stats: [] });
        }
        const stats = await getEmbeddingStats();
        res.json({ success: true, stats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate embeddings for all current data
app.post('/api/embeddings/generate', requireRole('admin'), async (req, res) => {
    if (!isEmbeddingsConfigured()) {
        return res.status(501).json({ error: 'Voyage API key not configured' });
    }

    if (!dbAvailable || !pgvectorAvailable) {
        return res.status(503).json({ error: 'Semantic search not available (pgvector required)' });
    }

    try {
        const data = await getAllContentForEmbedding();
        let siteCount = 0;
        let deviceCount = 0;

        // Embed sites
        if (data.sites.length > 0) {
            const siteEmbeddings = await embedSiteSnapshots(data.sites);
            for (const emb of siteEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
            siteCount = data.sites.length;
        }

        // Embed devices
        if (data.devices.length > 0) {
            const deviceEmbeddings = await embedPepwaveDevices(data.devices);
            for (const emb of deviceEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
            deviceCount = data.devices.length;
        }

        // Embed current alerts
        const alerts = computeAlerts();
        if (alerts.length > 0) {
            const alertEmbeddings = await embedAlerts(alerts);
            for (const emb of alertEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
        }

        // Embed maintenance logs
        let maintenanceCount = 0;
        if (data.maintenance && data.maintenance.length > 0) {
            const maintEmbeddings = await embedMaintenanceLogs(data.maintenance);
            for (const emb of maintEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
            maintenanceCount = data.maintenance.length;
        }

        // Embed job sites
        let jobSiteCount = 0;
        if (data.jobSites && data.jobSites.length > 0) {
            const jsEmbeddings = await embedJobSites(data.jobSites);
            for (const emb of jsEmbeddings) {
                await upsertEmbedding(emb.contentType, emb.contentId, emb.contentText, emb.embedding, emb.metadata);
            }
            jobSiteCount = data.jobSites.length;
        }

        res.json({
            success: true,
            sites_embedded: siteCount,
            devices_embedded: deviceCount,
            alerts_embedded: alerts.length,
            maintenance_embedded: maintenanceCount,
            job_sites_embedded: jobSiteCount,
        });
    } catch (err) {
        console.error('Embedding generation error:', err.message);
        res.status(500).json({ error: `Failed to generate embeddings: ${err.message}` });
    }
});

}
