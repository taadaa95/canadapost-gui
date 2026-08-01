'use strict';

const assert = require('assert');
const { validateIpcPayload, validateWorkerEvent } = require('../lib/ipc-contracts');

assert.deepStrictEqual(validateIpcPayload('privacy:delete', {
  allRecords: false,
  trackingNumbers: ['123'],
  confirmed: true,
  secondConfirmed: true,
  typedPhrase: 'DELETE',
  locale: 'en-CA'
}), {
  allRecords: false,
  trackingNumbers: ['123'],
  confirmed: true,
  secondConfirmed: true,
  typedPhrase: 'DELETE',
  locale: 'en-CA'
});
assert.throws(() => validateIpcPayload('privacy:delete', { surprise: true }), error => error.code === 'IPC_FIELD_UNEXPECTED');
assert.throws(() => validateIpcPayload('config:save', []), error => error.code === 'IPC_PAYLOAD_INVALID');
assert.throws(() => validateIpcPayload('submit:run', { selectedClassificationRecords: new Array(10001).fill({}) }), error => error.code === 'IPC_ARRAY_TOO_LARGE');
assert.throws(() => validateIpcPayload('locale:load', { locale: 'en-CA' }), error => error.code === 'IPC_STRING_INVALID');
assert.strictEqual(validateIpcPayload('locale:load', 'fr-CA'), 'fr-CA');
assert.deepStrictEqual(validateIpcPayload('browser:syncVisibility', {
  requestId: 'synthetic-request', visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 },
  reason: 'step3-inactive', force: true, requireVisible: true, step3Active: false,
  browserEnabled: true, placeholderVisible: true,
  rawDomRect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
  viewport: { width: 1280, height: 720 }
}), {
  requestId: 'synthetic-request', visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 },
  reason: 'step3-inactive', force: true, requireVisible: true, step3Active: false,
  browserEnabled: true, placeholderVisible: true,
  rawDomRect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
  viewport: { width: 1280, height: 720 }
});

assert.deepStrictEqual(validateWorkerEvent({ type: 'tracking_complete', count: 2 }, 'tracking'), { type: 'tracking_complete', count: 2 });
assert.throws(() => validateWorkerEvent({ type: '../bad' }, 'tracking'), error => error.code === 'WORKER_EVENT_TYPE_INVALID');
assert.throws(() => validateWorkerEvent('not-an-object', 'tracking'), error => error.code === 'IPC_PAYLOAD_INVALID');

process.stdout.write('IPC and worker boundary contract tests passed.\n');
