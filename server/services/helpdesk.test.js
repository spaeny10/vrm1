// Help desk state rules: what a message, a status change and an assignment do to a request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAssignment, applyMessage, applyStatus, customerView, findTrailerRow, findTrailerRowByRef } from './helpdesk.js';

const NOW = 1_800_000_000_000;
const ticket = (over = {}) => ({ id: 1, status: 'new', assignee_id: null, first_response_at: null, resolved_at: null, awaiting_reply: true, customer_visible: true, ...over });

test('a tech reply answers the customer, claims the request and starts the clock', () => {
    const p = applyMessage(ticket(), { from: 'staff', authorId: 7, now: NOW });
    assert.equal(p.awaiting_reply, false);
    assert.equal(p.assignee_id, 7);
    assert.equal(p.status, 'open');
    assert.equal(p.first_response_at, NOW);
    assert.equal(p.customer_unread, true);
});

test('a reply does not take a request away from its owner or reset the first response time', () => {
    const p = applyMessage(ticket({ status: 'open', assignee_id: 3, first_response_at: 5 }), { from: 'staff', authorId: 7, now: NOW });
    assert.equal(p.assignee_id, undefined);
    assert.equal(p.first_response_at, undefined);
    assert.equal(p.status, undefined);
});

test('an internal note leaves the customer waiting', () => {
    const p = applyMessage(ticket(), { from: 'staff', internal: true, authorId: 7, now: NOW });
    assert.equal(p.awaiting_reply, undefined);
    assert.equal(p.customer_unread, undefined);
    assert.equal(p.assignee_id, undefined);
    assert.equal(p.status, undefined);
});

test('reply and resolve in one step', () => {
    const p = applyMessage(ticket({ status: 'open', assignee_id: 3 }), { from: 'staff', authorId: 3, then: 'resolved', now: NOW });
    assert.equal(p.status, 'resolved');
    assert.equal(p.resolved_at, NOW);
    assert.equal(p.awaiting_reply, false);
});

test('reply and wait on the customer', () => {
    const p = applyMessage(ticket(), { from: 'staff', authorId: 3, then: 'waiting', now: NOW });
    assert.equal(p.status, 'waiting');
    assert.equal(p.assignee_id, 3);
});

test('a customer reply reopens a resolved request with its owner', () => {
    const p = applyMessage(ticket({ status: 'resolved', assignee_id: 3, resolved_at: 5, awaiting_reply: false }), { from: 'customer', now: NOW });
    assert.equal(p.status, 'open');
    assert.equal(p.resolved_at, null);
    assert.equal(p.awaiting_reply, true);
});

test('a customer reply on an unowned resolved request goes back to the queue', () => {
    const p = applyMessage(ticket({ status: 'resolved', resolved_at: 5 }), { from: 'customer', now: NOW });
    assert.equal(p.status, 'new');
});

test('a customer answering our question moves it out of waiting', () => {
    const p = applyMessage(ticket({ status: 'waiting', assignee_id: 3, awaiting_reply: false }), { from: 'customer', now: NOW });
    assert.equal(p.status, 'open');
    assert.equal(p.awaiting_reply, true);
});

test('a customer adding to an open request leaves its status alone', () => {
    const p = applyMessage(ticket({ status: 'open', assignee_id: 3 }), { from: 'customer', now: NOW });
    assert.equal(p.status, undefined);
    assert.equal(p.awaiting_reply, true);
});

test('resolving stops the wait; reopening clears the resolved time', () => {
    const r = applyStatus(ticket({ status: 'open' }), 'resolved', NOW);
    assert.deepEqual([r.status, r.resolved_at, r.awaiting_reply], ['resolved', NOW, false]);
    const o = applyStatus(ticket({ status: 'resolved', resolved_at: 5 }), 'open', NOW);
    assert.deepEqual([o.status, o.resolved_at], ['open', null]);
    assert.throws(() => applyStatus(ticket(), 'closed'));
});

test('assigning starts work; unassigning untouched work puts it back in the queue', () => {
    assert.equal(applyAssignment(ticket(), 4, NOW).status, 'open');
    assert.equal(applyAssignment(ticket({ status: 'open', assignee_id: 4 }), null, NOW).status, 'new');
    // Already answered: stays in progress, just without an owner
    assert.equal(applyAssignment(ticket({ status: 'open', assignee_id: 4, first_response_at: 5 }), null, NOW).status, undefined);
    assert.equal(applyAssignment(ticket({ status: 'waiting', assignee_id: 4 }), 9, NOW).status, undefined);
});

test('a request finds its trailer after the telemetry id or registry row changes', () => {
    const rows = [
        { key: 'v200', site_id: 200, site_ids: [200, 100, -55], trailer_id: 12, unit: 'Trailer 628' },
        { key: 'nbv-9', site_id: null, site_ids: [], trailer_id: 30, unit: 'BV-9' },
    ];
    assert.equal(findTrailerRow(rows, { trailer_id: 12, site_id: 999 }).key, 'v200');
    assert.equal(findTrailerRow(rows, { trailer_id: null, site_id: 100 }).key, 'v200');
    assert.equal(findTrailerRow(rows, { trailer_id: 404, site_id: 404, trailer_unit: 'trailer  628' }).key, 'v200');
    assert.equal(findTrailerRow(rows, { trailer_id: 404, site_id: 404, trailer_unit: 'gone' }), null);
    assert.equal(findTrailerRow(rows, { trailer_id: null, site_id: null, trailer_unit: null }), null);
    assert.equal(findTrailerRowByRef(rows, '-55').key, 'v200');
    assert.equal(findTrailerRowByRef(rows, 'nbv-9').key, 'nbv-9');
    assert.equal(findTrailerRowByRef(rows, ''), null);
});

test('the customer view carries no internal fields', () => {
    const v = customerView({ id: 1, subject: 's', status: 'open', assignee_id: 3, assignee_name: 'Riley', requester_email: 'a@b.c', priority: 'urgent', customer_unread: true, last_public_message: 'hi' });
    assert.deepEqual(Object.keys(v).filter(k => /assignee|email|priority|phone|created_by/.test(k)), []);
    assert.equal(v.unread, true);
});
