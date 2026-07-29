'use strict';

const assert = require('assert');
const {
  cleanString,
  asBoolean,
  boundedInteger,
  validateTrackingSelection,
  validateSubmitOptions
} = require('../lib/input-validation');

assert.strictEqual(cleanString('  abc  ', { max: 10 }), 'abc');
assert.strictEqual(asBoolean('yes'), true);
assert.strictEqual(asBoolean('off', true), false);
assert.strictEqual(boundedInteger('500000', { min: 1, max: 100, fallback: 5 }), 100);
assert.deepStrictEqual(validateTrackingSelection([' 123 ', '123', '', '456']), ['123', '456']);

const validated = validateSubmitOptions({
  browserMode: 'external',
  dryRun: 'false',
  liveSubmissionConfirmed: true,
  selectedTrackingNumbers: [' 123 ', '456'],
  afterSubmitMs: 1,
  betweenClaimsMs: 999999
});
assert.strictEqual(validated.browserMode, 'builtin', 'Step 3 must remain built-in-browser only');
assert.strictEqual(validated.afterSubmitMs, 5000);
assert.strictEqual(validated.betweenClaimsMs, 60000);
assert.deepStrictEqual(validated.selectedTrackingNumbers, ['123', '456']);
assert.strictEqual(validated.liveSubmissionConfirmed, true);

console.log('IPC input validation tests passed.');
