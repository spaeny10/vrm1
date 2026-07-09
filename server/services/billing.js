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
