import { getRateCards, getVolumeTiers, getCompanyRentalWindows } from '../db.js';
import { computeCharges, buildTierCounter, parseDateUTC } from '../pricing.js';

export const RATE_PERIOD_DAYS = { day: 1, week: 7, month: 28 };

export function billingDays(rental, asOf = new Date()) {
    if (!rental.billing_start) return null;
    const start = new Date(rental.billing_start);
    const end = rental.billing_stop ? new Date(rental.billing_stop) : asOf;
    if (end < start) return 0;
    return Math.floor((end - start) / 86400000) + 1; // inclusive of start day
}

export function computeAccrued(rental, asOf = new Date()) {
    const days = billingDays(rental, asOf);
    if (days === null || !rental.rate_amount) return null;
    const perDay = Number(rental.rate_amount) / (RATE_PERIOD_DAYS[rental.rate_period] || 28);
    return Math.round(perDay * days * 100) / 100;
}

// Accrual limited to the current calendar month (for the MTD tile)
export function computeAccruedThisMonth(rental, asOf = new Date()) {
    if (!rental.billing_start || !rental.rate_amount) return null;
    const monthStart = new Date(asOf.getFullYear(), asOf.getMonth(), 1);
    const start = new Date(Math.max(new Date(rental.billing_start), monthStart));
    const end = rental.billing_stop ? new Date(Math.min(new Date(rental.billing_stop), asOf)) : asOf;
    if (end < start) return 0;
    const days = Math.floor((end - start) / 86400000) + 1;
    const perDay = Number(rental.rate_amount) / (RATE_PERIOD_DAYS[rental.rate_period] || 28);
    return Math.round(perDay * days * 100) / 100;
}

export async function buildPricingContext() {
    const [rateCards, tiers, windows] = await Promise.all([
        getRateCards(), getVolumeTiers(), getCompanyRentalWindows(),
    ]);
    const cardsByProductTerm = {};
    for (const c of rateCards) {
        (cardsByProductTerm[c.product_code] = cardsByProductTerm[c.product_code] || {})[c.commitment_term] = c;
    }
    return { cardsByProductTerm, tiers, windows };
}

export function rentalRateCard(r, ctx) {
    const product = r.product_code || 'BV1305';
    const term = r.commitment_term || 'monthly';
    return (ctx.cardsByProductTerm[product] || {})[term] || null;
}

// Price a rental: manual rate_amount overrides; otherwise the rate card for
// the trailer's product + the rental's commitment term, with the EA volume
// tier resolved dynamically per billing cycle.
export function priceRental(r, ctx) {
    const rollback = r.rollback_amount ? Number(r.rollback_amount) : 0;

    if (r.rate_amount) {
        const accrued = computeAccrued(r);
        return {
            ...r,
            pricing_source: 'manual',
            days_on_rent: billingDays(r),
            accrued_amount: accrued,
            total_due: accrued === null ? null : Math.round((accrued + rollback) * 100) / 100,
            effective_rate: Number(r.rate_amount),
            billing_cycle: r.rate_period,
            volume_tier: null,
        };
    }

    const card = rentalRateCard(r, ctx);
    if (!card || !r.billing_start) {
        return {
            ...r,
            pricing_source: card ? 'rate_card' : 'none',
            days_on_rent: billingDays(r),
            accrued_amount: null,
            total_due: null,
            effective_rate: card ? Number(card.base_rate) : null,
            billing_cycle: card ? card.billing_cycle : null,
            volume_tier: null,
        };
    }

    const countAt = buildTierCounter(ctx.windows, r.company_id);
    const start = parseDateUTC(r.billing_start);
    const end = r.billing_stop ? parseDateUTC(r.billing_stop) : parseDateUTC(new Date().toISOString());
    const charges = computeCharges({ billingStart: start, billingEnd: end, rateCard: card, tiers: ctx.tiers, countAt });
    return {
        ...r,
        pricing_source: 'rate_card',
        days_on_rent: billingDays(r),
        accrued_amount: charges.accrued,
        total_due: Math.round((charges.accrued + rollback) * 100) / 100,
        effective_rate: charges.currentRate,
        billing_cycle: card.billing_cycle,
        volume_tier: charges.currentTier,
    };
}

// Month-to-date accrual for rate-card rentals: full-window accrual minus
// the accrual up to the end of last month
export function computeMtdEngine(r, ctx) {
    const card = rentalRateCard(r, ctx);
    if (!card || !r.billing_start) return null;
    const countAt = buildTierCounter(ctx.windows, r.company_id);
    const start = parseDateUTC(r.billing_start);
    const today = parseDateUTC(new Date().toISOString());
    const end = r.billing_stop ? parseDateUTC(r.billing_stop) : today;
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const total = computeCharges({ billingStart: start, billingEnd: end, rateCard: card, tiers: ctx.tiers, countAt }).accrued;
    if (start >= monthStart) return total;
    const beforeMonth = computeCharges({
        billingStart: start,
        billingEnd: new Date(Math.min(monthStart.getTime() - 86400000, end.getTime())),
        rateCard: card, tiers: ctx.tiers, countAt,
    }).accrued;
    return Math.round((total - beforeMonth) * 100) / 100;
}

// Rental lifecycle transitions. Each event stamps its date column, moves the
// rental status forward, updates the trailer status, and logs an immutable event.
export const RENTAL_TRANSITIONS = {
    deliver: { from: ['reserved'], dateField: 'delivered_at', toStatus: 'delivered', trailerStatus: 'on_rent' },
    start_billing: { from: ['reserved', 'delivered'], dateField: 'billing_start', toStatus: 'billing', trailerStatus: 'on_rent' },
    calloff: { from: ['billing'], dateField: 'calloff_at', toStatus: 'called_off', trailerStatus: null },
    stop_billing: { from: ['billing', 'called_off'], dateField: 'billing_stop', toStatus: 'awaiting_pickup', trailerStatus: null },
    pickup: { from: ['awaiting_pickup', 'called_off', 'delivered'], dateField: 'picked_up_at', toStatus: 'awaiting_pickup', trailerStatus: 'in_transit' },
    return: { from: ['awaiting_pickup', 'delivered', 'reserved'], dateField: 'returned_at', toStatus: 'closed', trailerStatus: 'available' },
    cancel: { from: ['reserved', 'delivered'], dateField: null, toStatus: 'cancelled', trailerStatus: 'available' },
};

// ============================================================
// Monthly statements: charges for an arbitrary calendar month
// ============================================================

// Overlap (inclusive day count) of a rental's billing window with a
// month, plus the clipped [from, to] range. month = 'YYYY-MM'.
function monthWindow(rental, month) {
    if (!rental.billing_start) return null;
    const monthStart = parseDateUTC(`${month}-01`);
    const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
    const today = parseDateUTC(new Date().toISOString());
    const start = parseDateUTC(rental.billing_start);
    const end = rental.billing_stop ? parseDateUTC(rental.billing_stop) : today;
    const from = new Date(Math.max(start.getTime(), monthStart.getTime()));
    const to = new Date(Math.min(end.getTime(), monthEnd.getTime()));
    if (to < from) return null;
    return { from, to, start, end, days: Math.floor((to - from) / 86400000) + 1 };
}

// Amount a rental accrued within a specific calendar month.
// Manual rates prorate daily; rate-card rentals use the engine with the
// tier resolution the full window would have had (clip = total-to-`to`
// minus total-to-day-before-`from`, so cycle boundaries stay anchored
// to billing_start exactly as the accrual engine computes them).
export function computeMonthCharges(r, ctx, month) {
    const win = monthWindow(r, month);
    if (!win) return null;

    if (r.rate_amount) {
        const perDay = Number(r.rate_amount) / (RATE_PERIOD_DAYS[r.rate_period] || 28);
        return { days: win.days, amount: Math.round(perDay * win.days * 100) / 100 };
    }

    const card = rentalRateCard(r, ctx);
    if (!card) return null;
    const countAt = buildTierCounter(ctx.windows, r.company_id);
    const upToEnd = computeCharges({ billingStart: win.start, billingEnd: win.to, rateCard: card, tiers: ctx.tiers, countAt }).accrued;
    let before = 0;
    if (win.from > win.start) {
        before = computeCharges({
            billingStart: win.start,
            billingEnd: new Date(win.from.getTime() - 86400000),
            rateCard: card, tiers: ctx.tiers, countAt,
        }).accrued;
    }
    return { days: win.days, amount: Math.round((upToEnd - before) * 100) / 100 };
}

// Build per-customer statements for a month from a full rentals list
export function buildStatements(rentals, ctx, month) {
    const byCompany = new Map();
    for (const r of rentals) {
        if (r.status === 'cancelled') continue;
        const charges = computeMonthCharges(r, ctx, month);
        // Roll-back adjustments bill in the month billing stopped
        const stopMonth = r.billing_stop ? String(r.billing_stop instanceof Date ? r.billing_stop.toISOString() : r.billing_stop).slice(0, 7) : null;
        const rollback = (r.rollback_amount && stopMonth === month) ? Number(r.rollback_amount) : 0;
        if (!charges && rollback === 0) continue;

        const key = r.company_id || 0;
        if (!byCompany.has(key)) {
            byCompany.set(key, {
                company_id: r.company_id || null,
                company_name: r.company_name || 'No Customer Assigned',
                lines: [],
                subtotal: 0,
                rollback_total: 0,
            });
        }
        const grp = byCompany.get(key);
        const priced = priceRental(r, ctx);
        grp.lines.push({
            rental_id: r.id,
            unit_number: r.unit_number,
            job_site_name: r.job_site_name || null,
            po_number: r.po_number || null,
            status: r.status,
            pricing_source: priced.pricing_source,
            commitment_term: r.commitment_term,
            effective_rate: priced.effective_rate,
            billing_cycle: priced.billing_cycle,
            volume_tier: priced.volume_tier,
            days_in_month: charges ? charges.days : 0,
            amount: charges ? charges.amount : 0,
            rollback_adjustment: rollback,
            line_total: Math.round(((charges ? charges.amount : 0) + rollback) * 100) / 100,
        });
        grp.subtotal = Math.round((grp.subtotal + (charges ? charges.amount : 0)) * 100) / 100;
        grp.rollback_total = Math.round((grp.rollback_total + rollback) * 100) / 100;
    }

    const companies = [...byCompany.values()]
        .map(c => ({ ...c, total: Math.round((c.subtotal + c.rollback_total) * 100) / 100 }))
        .sort((a, b) => a.company_name.localeCompare(b.company_name));
    const grand_total = Math.round(companies.reduce((s, c) => s + c.total, 0) * 100) / 100;
    return { month, companies, grand_total };
}
