// ============================================================
// Pricing engine — FY2026 commercial rate structure
//
// Commitment terms:
//   monthly  → billed per calendar month (prorated by each month's real length)
//   6_month  → billed on 28-day cycles (13 per year)
//   1_year   → billed on 28-day cycles
//
// Enterprise Agreement volume discounts are resolved dynamically at the
// opening of each billing cycle from the customer's count of on-rent units
// at that date (per the Dynamic Fleet Volume Adjustments clause).
//
// Roll-Back clause: early termination of a 6-month or 1-year commitment
// retroactively re-prices the utilized period at the shorter-term bracket.
// ============================================================

const DAY_MS = 86400000;

// Minimum committed duration in days. 1 year = 13 × 28-day cycles;
// 6 months = half of that.
export const TERM_DAYS = { '6_month': 182, '1_year': 364 };

// Fallback bracket when a commitment is terminated early
function rollbackTerm(term, utilizedDays) {
    if (term === '1_year') return utilizedDays >= TERM_DAYS['6_month'] ? '6_month' : 'monthly';
    if (term === '6_month') return 'monthly';
    return null;
}

// Normalize a pg DATE (Date object or ISO string) to UTC midnight
export function parseDateUTC(d) {
    if (!d) return null;
    return new Date(String(d instanceof Date ? d.toISOString() : d).slice(0, 10) + 'T00:00:00Z');
}

function daysInMonthUTC(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function monthOpenUTC(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

// Pick the volume tier matching an on-rent unit count
export function resolveTier(tiers, unitCount) {
    let match = null;
    for (const t of tiers) {
        if (unitCount >= t.min_units && (t.max_units === null || unitCount <= t.max_units)) {
            match = t;
        }
    }
    // Below the lowest tier floor (count 0) → treat as the first tier
    return match || tiers[0] || { name: 'Standard', discount_pct: 0 };
}

// Build a per-company counter: how many units were on rent at a given date.
// windows: [{ company_id, billing_start, billing_stop }]
export function buildTierCounter(windows, companyId) {
    if (!companyId) return () => 1;
    const mine = windows
        .filter(w => w.company_id === companyId)
        .map(w => ({
            start: parseDateUTC(w.billing_start).getTime(),
            stop: w.billing_stop ? parseDateUTC(w.billing_stop).getTime() : null,
        }));
    return (date) => {
        const t = date.getTime();
        let n = 0;
        for (const w of mine) {
            if (w.start <= t && (w.stop === null || w.stop >= t)) n++;
        }
        return n;
    };
}

/**
 * Accrue charges for a billing window under a rate card.
 *
 * opts:
 *   billingStart, billingEnd — Date (UTC midnight), both inclusive
 *   rateCard  — { billing_cycle: '28_day'|'calendar_month', base_rate }
 *   tiers     — volume tier rows
 *   countAt   — (date) => on-rent unit count for the customer at that date
 *
 * Returns { accrued, currentTier, currentRate, dailyRate }
 */
export function computeCharges({ billingStart, billingEnd, rateCard, tiers, countAt }) {
    if (!billingStart || !billingEnd || !rateCard) return null;
    const start = billingStart.getTime();
    const end = billingEnd.getTime();
    if (end < start) return { accrued: 0, currentTier: null, currentRate: null, dailyRate: null };

    const base = Number(rateCard.base_rate);
    const tierCache = new Map();
    const tierAt = (openDate) => {
        const key = openDate.getTime();
        if (!tierCache.has(key)) tierCache.set(key, resolveTier(tiers, countAt(openDate)));
        return tierCache.get(key);
    };

    let accrued = 0;
    let currentTier = null;
    let dailyRate = 0;

    for (let t = start; t <= end; t += DAY_MS) {
        const day = new Date(t);
        if (rateCard.billing_cycle === 'calendar_month') {
            // Tier locks at whichever came later: the 1st of the month or billing start
            const open = Math.max(monthOpenUTC(day).getTime(), start);
            currentTier = tierAt(new Date(open));
            const discounted = base * (1 - Number(currentTier.discount_pct) / 100);
            dailyRate = discounted / daysInMonthUTC(day);
        } else {
            // 28-day cycles anchored to billing start; tier locks at cycle open
            const cycleIdx = Math.floor((t - start) / DAY_MS / 28);
            const open = new Date(start + cycleIdx * 28 * DAY_MS);
            currentTier = tierAt(open);
            const discounted = base * (1 - Number(currentTier.discount_pct) / 100);
            dailyRate = discounted / 28;
        }
        accrued += dailyRate;
    }

    const currentRate = base * (1 - Number(currentTier.discount_pct) / 100);
    return {
        accrued: Math.round(accrued * 100) / 100,
        currentTier: { name: currentTier.name, discount_pct: Number(currentTier.discount_pct) },
        currentRate: Math.round(currentRate * 100) / 100,
        dailyRate: Math.round(dailyRate * 100) / 100,
    };
}

/**
 * Roll-Back clause: if a 6-month/1-year commitment stopped billing before its
 * committed duration, re-price the utilized period at the shorter-term bracket
 * and return the additional amount owed (0 if not an early termination).
 *
 * opts: billingStart, billingStop (Dates), term, rateCardsByTerm (Map or
 * object keyed by commitment_term for the same product), tiers, countAt
 */
export function computeRollback({ billingStart, billingStop, term, rateCardsByTerm, tiers, countAt }) {
    if (!billingStart || !billingStop || !TERM_DAYS[term]) return null;
    const utilizedDays = Math.floor((billingStop.getTime() - billingStart.getTime()) / DAY_MS) + 1;
    if (utilizedDays >= TERM_DAYS[term]) return null; // commitment fulfilled

    const fallback = rollbackTerm(term, utilizedDays);
    const committedCard = rateCardsByTerm[term];
    const fallbackCard = rateCardsByTerm[fallback];
    if (!committedCard || !fallbackCard) return null;

    const committed = computeCharges({ billingStart, billingEnd: billingStop, rateCard: committedCard, tiers, countAt });
    const repriced = computeCharges({ billingStart, billingEnd: billingStop, rateCard: fallbackCard, tiers, countAt });
    const adjustment = Math.round((repriced.accrued - committed.accrued) * 100) / 100;

    return {
        utilized_days: utilizedDays,
        committed_term: term,
        rollback_term: fallback,
        committed_accrued: committed.accrued,
        repriced_accrued: repriced.accrued,
        adjustment: Math.max(0, adjustment),
    };
}
