'use strict';

const assert = require('assert');
const { assertBuiltInBrowserMode } = require('../lib/step3/browser-handshake');
const { isFinalSubmissionLabel } = require('../lib/step3/form');
const { classifyClaimOutcome } = require('../lib/step3/outcome');
const { assertNeverRetryUncertainFinalAction } = require('../lib/step3/safety');

assert.strictEqual(assertBuiltInBrowserMode('builtin'), true);
assert.throws(() => assertBuiltInBrowserMode('external'), error => error.code === 'BUILTIN_BROWSER_REQUIRED');
assert.strictEqual(isFinalSubmissionLabel('Create Ticket'), true);
assert.strictEqual(isFinalSubmissionLabel('Continue'), false);
assert.strictEqual(classifyClaimOutcome('Ticket number: CP-12345').status, 'submitted');
assert.throws(() => assertNeverRetryUncertainFinalAction({ finalActionDispatched: true, status: 'unknown' }), error => error.code === 'RECONCILIATION_REQUIRED' && error.reconciliationRequired === true);
assert.strictEqual(assertNeverRetryUncertainFinalAction({ finalActionDispatched: true, status: 'submitted' }), true);
process.stdout.write('Step 3 navigation/form/outcome/browser/safety module boundaries passed.\n');
