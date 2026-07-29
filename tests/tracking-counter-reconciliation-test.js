'use strict';

const assert = require('assert');
const {
  PRIMARY_TERMINAL_CATEGORIES, createTerminalCounters, recordTerminal, assertTerminalReconciliation
} = require('../scripts/get-tracking');

function fixture(categories) {
  const counters = createTerminalCounters();
  for (const [category, count] of Object.entries(categories)) {
    for (let index = 0; index < count; index += 1) recordTerminal(counters, category);
  }
  assertTerminalReconciliation(counters);
  return counters;
}

const latest = fixture({ late: 19, on_time: 234, not_delivered: 31 });
assert.deepStrictEqual(latest, { checked: 284, late: 19, onTime: 234, notDelivered: 31, deliveredReview: 0, errors: 0 });

const previousStyle = fixture({ late: 19, on_time: 232, not_delivered: 32, delivered_review: 1 });
assert.deepStrictEqual(previousStyle, { checked: 284, late: 19, onTime: 232, notDelivered: 32, deliveredReview: 1, errors: 0 });

const semantics = fixture({ delivered_review: 1, not_delivered: 1, error: 1 });
assert.strictEqual(semantics.deliveredReview, 1, 'delivered but missing standard is review, not not-delivered');
assert.strictEqual(semantics.notDelivered, 1, 'attempted without successful delivery is not-delivered');
assert.strictEqual(semantics.errors, 1, 'technical failures are errors, not not-delivered');
assert.strictEqual(semantics.checked, 3);

assert.throws(() => recordTerminal(createTerminalCounters(), 'review'));
const broken = createTerminalCounters();
broken.checked = 1;
assert.throws(() => assertTerminalReconciliation(broken));
assert.strictEqual(PRIMARY_TERMINAL_CATEGORIES.LATE, 'late');

console.log('Tracking counter reconciliation tests passed.');
