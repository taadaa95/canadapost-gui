'use strict';

const assert = require('assert');
const {
  cleanString,
  asBoolean,
  boundedInteger,
  validateCustomerNumber,
  validateTrackingSelection,
  validateSubmitOptions
} = require('../lib/input-validation');

assert.strictEqual(cleanString('  abc  ', { max: 10 }), 'abc');
assert.strictEqual(asBoolean('yes'), true);
assert.strictEqual(asBoolean('off', true), false);
assert.strictEqual(boundedInteger('500000', { min: 1, max: 100, fallback: 5 }), 100);
assert.deepStrictEqual(validateTrackingSelection([' 123 ', '123', '', '456']), ['123', '456']);
assert.deepStrictEqual(validateCustomerNumber('12345678'), { valid: true, normalized: '0012345678' });
assert.strictEqual(validateCustomerNumber('1').valid, true);
assert.strictEqual(validateCustomerNumber('1234567890').valid, true);
assert.strictEqual(validateCustomerNumber('12345678901').valid, false);
assert.strictEqual(validateCustomerNumber('12 345').valid, false);

const validated = validateSubmitOptions({
  browserMode: 'external',
  dryRun: true,
  selectedTrackingNumbers: [' 123 ', '456'],
  selectedClassificationRecords: [
    { recordId: 7, evidenceHash: 'A'.repeat(64) },
    { recordId: 7, evidenceHash: 'b'.repeat(64) },
    { recordId: 'invalid', evidenceHash: 'c'.repeat(64) }
  ],
  afterSubmitMs: 1,
  betweenClaimsMs: 999999
});
assert.strictEqual(validated.browserMode, 'builtin', 'Step 3 must remain built-in-browser only');
assert.strictEqual(validated.afterSubmitMs, 5000);
assert.strictEqual(validated.betweenClaimsMs, 60000);
assert.deepStrictEqual(validated.selectedTrackingNumbers, ['123', '456']);
assert.deepStrictEqual(validated.selectedClassificationRecords, [{ recordId: 7, evidenceHash: 'a'.repeat(64) }]);
assert.strictEqual(Object.hasOwn(validated, 'dryRun'), false, 'the production Step 3 contract must not expose a dry-run option');
assert.strictEqual(Object.hasOwn(validated, 'liveSubmissionConfirmed'), false);
assert.strictEqual(Object.hasOwn(validated, 'canaryMode'), false);

console.log('IPC input validation tests passed.');
