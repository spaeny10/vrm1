import { getBillingAtHeadquarters, getBillingPastCalloff, getRateCards, getRental, getRentalEvents, getRentals, getTrailer, getTrailers, getUnbilledDeployedTrailers, getVolumeTiers, insertAuditLog, insertRental, insertRentalEvent, insertTrailer, updateRental, updateTrailer } from '../db.js';
import { requireRole } from '../middleware/auth.js';
import { TERM_DAYS, buildTierCounter, computeRollback, parseDateUTC } from '../pricing.js';
import { RENTAL_TRANSITIONS, buildPricingContext, computeAccruedThisMonth, computeMtdEngine, priceRental } from '../services/billing.js';

export function registerRentalsRoutes(app) {

app.get('/api/trailers', async (req, res) => {
    try {
        const trailers = await getTrailers({ status: req.query.status });
        res.json({ success: true, trailers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/trailers', requireRole('admin', 'technician'), async (req, res) => {
    try {
        if (!req.body.unit_number) return res.status(400).json({ success: false, error: 'unit_number is required' });
        const created = await insertTrailer(req.body);
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('trailer', created.id, 'trailer_created', { unit_number: created.unit_number }, actor).catch(() => { });
        res.status(201).json({ success: true, trailer: created });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, error: 'A trailer with that unit number or VRM site already exists' });
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/trailers/:id', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const updated = await updateTrailer(parseInt(req.params.id), req.body);
        if (!updated) return res.status(404).json({ success: false, error: 'Trailer not found' });
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('trailer', updated.id, 'trailer_updated', { fields: Object.keys(req.body) }, actor).catch(() => { });
        res.json({ success: true, trailer: updated });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, error: 'A trailer with that unit number or VRM site already exists' });
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/rentals', async (req, res) => {
    try {
        const rentals = await getRentals({
            status: req.query.status,
            trailerId: req.query.trailer_id ? parseInt(req.query.trailer_id) : undefined,
            jobSiteId: req.query.job_site_id ? parseInt(req.query.job_site_id) : undefined,
            companyId: req.query.company_id ? parseInt(req.query.company_id) : undefined,
            open: req.query.open === '1' || req.query.open === 'true',
        });
        const ctx = await buildPricingContext();
        res.json({ success: true, rentals: rentals.map(r => priceRental(r, ctx)) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/rentals/:id', async (req, res) => {
    try {
        const rental = await getRental(parseInt(req.params.id));
        if (!rental) return res.status(404).json({ success: false, error: 'Rental not found' });
        const events = await getRentalEvents(rental.id);
        const ctx = await buildPricingContext();
        res.json({ success: true, rental: priceRental(rental, ctx), events });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Rate card matrix + EA tiers (for UI display and reference)
app.get('/api/pricing/rate-cards', async (req, res) => {
    try {
        const [rateCards, tiers] = await Promise.all([getRateCards(req.query.product), getVolumeTiers()]);
        res.json({ success: true, rate_cards: rateCards, volume_tiers: tiers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/rentals', requireRole('admin', 'technician'), async (req, res) => {
    try {
        if (!req.body.trailer_id) return res.status(400).json({ success: false, error: 'trailer_id is required' });
        const trailer = await getTrailer(parseInt(req.body.trailer_id));
        if (!trailer) return res.status(404).json({ success: false, error: 'Trailer not found' });
        if (trailer.status === 'retired') return res.status(400).json({ success: false, error: 'Cannot rent a retired trailer' });

        const created = await insertRental(req.body);
        await updateTrailer(trailer.id, { status: 'reserved' });
        const actor = req.user ? req.user.display_name : 'system';
        await insertRentalEvent(created.id, 'reserved', created.reserved_at, actor, req.body.notes || null);
        insertAuditLog('rental', created.id, 'rental_created', { trailer: trailer.unit_number, job_site_id: created.job_site_id }, actor).catch(() => { });
        res.status(201).json({ success: true, rental: created });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ success: false, error: 'This trailer already has an open rental' });
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/rentals/:id', requireRole('admin', 'technician'), async (req, res) => {
    try {
        // Status changes must go through the lifecycle event endpoint
        const { status, ...updates } = req.body;
        const updated = await updateRental(parseInt(req.params.id), updates);
        if (!updated) return res.status(404).json({ success: false, error: 'Rental not found' });
        const actor = req.user ? req.user.display_name : 'system';
        insertAuditLog('rental', updated.id, 'rental_updated', { fields: Object.keys(updates) }, actor).catch(() => { });
        res.json({ success: true, rental: updated });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/rentals/:id/events', requireRole('admin', 'technician'), async (req, res) => {
    try {
        const { event_type, event_date, notes } = req.body;
        const transition = RENTAL_TRANSITIONS[event_type];
        if (!transition) {
            return res.status(400).json({ success: false, error: `Unknown event_type. Valid: ${Object.keys(RENTAL_TRANSITIONS).join(', ')}` });
        }

        const rental = await getRental(parseInt(req.params.id));
        if (!rental) return res.status(404).json({ success: false, error: 'Rental not found' });
        if (!transition.from.includes(rental.status)) {
            return res.status(409).json({ success: false, error: `Cannot ${event_type} a rental in '${rental.status}' status` });
        }

        // Billing can't stop before it started
        const date = event_date || new Date().toISOString().slice(0, 10);
        if (event_type === 'stop_billing' && rental.billing_start && new Date(date) < new Date(rental.billing_start)) {
            return res.status(400).json({ success: false, error: 'billing_stop cannot be before billing_start' });
        }

        const updates = { status: transition.toStatus };
        if (transition.dateField) updates[transition.dateField] = date;
        const updated = await updateRental(rental.id, updates);

        if (transition.trailerStatus) {
            await updateTrailer(rental.trailer_id, { status: transition.trailerStatus });
        }

        const actor = req.user ? req.user.display_name : 'system';
        const event = await insertRentalEvent(rental.id, event_type, date, actor, notes || null);
        insertAuditLog('rental', rental.id, `rental_${event_type}`, { trailer: rental.unit_number, date }, actor).catch(() => { });

        // Roll-Back clause: stopping billing before a 6-month/1-year commitment
        // is fulfilled retroactively re-prices the utilized period at the
        // shorter-term bracket. Only applies to rate-card pricing.
        let rollback = null;
        let merged = { ...rental, ...updated };
        if (event_type === 'stop_billing' && !rental.rate_amount && TERM_DAYS[rental.commitment_term] && rental.billing_start) {
            const ctx = await buildPricingContext();
            const cardsByTerm = ctx.cardsByProductTerm[rental.product_code || 'BV1305'] || {};
            rollback = computeRollback({
                billingStart: parseDateUTC(rental.billing_start),
                billingStop: parseDateUTC(date),
                term: rental.commitment_term,
                rateCardsByTerm: cardsByTerm,
                tiers: ctx.tiers,
                countAt: buildTierCounter(ctx.windows, rental.company_id),
            });
            if (rollback && rollback.adjustment > 0) {
                await updateRental(rental.id, { rollback_amount: rollback.adjustment });
                merged.rollback_amount = rollback.adjustment;
                await insertRentalEvent(
                    rental.id, 'rollback_adjustment', date, actor,
                    `Early termination of ${rental.commitment_term} commitment after ${rollback.utilized_days} days — re-priced at ${rollback.rollback_term} bracket: +$${rollback.adjustment.toFixed(2)}`
                );
                insertAuditLog('rental', rental.id, 'rental_rollback_adjustment', { trailer: rental.unit_number, ...rollback }, actor).catch(() => { });
            }
        }

        const ctx = await buildPricingContext();
        res.json({ success: true, rental: priceRental(merged, ctx), event, rollback });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Billing dashboard summary
app.get('/api/billing/summary', async (req, res) => {
    try {
        const openRentals = await getRentals({ open: true });
        const trailers = await getTrailers();
        const ctx = await buildPricingContext();

        const billing = openRentals.filter(r => r.status === 'billing' || r.status === 'called_off');
        let accruedMtd = 0, accruedTotal = 0, missingRates = 0;
        for (const r of billing) {
            const priced = priceRental(r, ctx);
            const mtd = priced.pricing_source === 'manual' ? computeAccruedThisMonth(r) : computeMtdEngine(r, ctx);
            if (priced.accrued_amount === null) missingRates++;
            accruedMtd += mtd || 0;
            accruedTotal += priced.total_due || 0;
        }

        res.json({
            success: true,
            summary: {
                trailers_total: trailers.filter(t => t.status !== 'retired').length,
                trailers_available: trailers.filter(t => t.status === 'available').length,
                rentals_open: openRentals.length,
                rentals_billing: billing.length,
                rentals_awaiting_pickup: openRentals.filter(r => r.status === 'awaiting_pickup').length,
                accrued_mtd: Math.round(accruedMtd * 100) / 100,
                accrued_total_open: Math.round(accruedTotal * 100) / 100,
                rentals_missing_rate: missingRates,
            },
            rentals: openRentals.map(r => priceRental(r, ctx)),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Revenue-leakage alerts
app.get('/api/billing/alerts', async (req, res) => {
    try {
        const [pastCalloff, atHq, unbilled] = await Promise.all([
            getBillingPastCalloff(),
            getBillingAtHeadquarters(),
            getUnbilledDeployedTrailers(),
        ]);

        const alerts = [
            ...pastCalloff.map(r => ({
                type: 'billing_past_calloff',
                severity: 'warning',
                rental_id: r.id,
                unit_number: r.unit_number,
                message: `${r.unit_number} is still billing but was called off ${new Date(r.calloff_at).toLocaleDateString()} — stop billing or clear the calloff date`,
            })),
            ...atHq.map(r => ({
                type: 'billing_at_hq',
                severity: 'critical',
                rental_id: r.id,
                unit_number: r.unit_number,
                message: `${r.unit_number} is physically at ${r.hq_name} but billing is still running — customer may be overbilled`,
            })),
            ...unbilled.map(t => ({
                type: 'unbilled_deployed',
                severity: 'critical',
                trailer_id: t.trailer_id,
                unit_number: t.unit_number,
                message: `${t.unit_number} is deployed at active site "${t.job_site_name}" with no open rental — revenue is leaking`,
            })),
        ];

        res.json({ success: true, alerts });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

}
