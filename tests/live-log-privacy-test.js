'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'scripts/get-tracking.js'), 'utf8');

assert.match(renderer, /options\.allowFullTrackingNumber === true/);
assert.match(renderer, /rendererOnlyFullTrackingNumber === true/);
assert.match(renderer, /MAX_VISIBLE_LOG_LINES = 2000/);
assert.match(main, /displayTrackingNumber: fullTrackingNumber, rendererOnlyFullTrackingNumber: true/);
assert.match(main, /appendLog\(logPath, storage\.redactCustomerNumbers\(raw, customerNumbers\)\)/, 'worker events must be customer-number-redacted before renderer-only enrichment');
assert.doesNotMatch(renderer, /event\.customerNumber/, 'the renderer log view must not display a full customer number from worker events');
assert.match(worker, /const safePin = redactedTracking\(pin\)/);
assert.doesNotMatch(worker, /emit\('pin_(?:late|on_time|overdue|review_required|no_data|error)'[^\n]*pin:\s*pin\b/);
assert.match(renderer, /pin_late: 'log-late'/);
assert.match(renderer, /pin_on_time: 'log-on-time'/);
assert.match(renderer, /pin_overdue: 'log-not-delivered'/);
assert.match(renderer, /pin_review_required: 'log-warning'/);
assert.match(renderer, /pin_error: 'log-submit-error'/);
assert.match(renderer, /tracking_protocol_stage = 'log-retry'/);

console.log('Transient full-PIN UI and persistent-log redaction contract tests passed.');
