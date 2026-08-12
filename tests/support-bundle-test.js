'use strict';

const assert = require('assert');
const supportBundle = require('../lib/support-bundle');

const reference = supportBundle.supportReferenceId(new Date('2026-08-01T00:00:00.000Z'), size => Buffer.alloc(size, 0xab));
assert.strictEqual(reference, 'CPCR-20260801-ABABABABAB');
const defaults = supportBundle.preview({ applicationVersion: '0.4.0', databaseSchemaVersion: 8, trackingParserVersion: 'v1', supportReferenceId: reference });
assert.deepStrictEqual(defaults.selectedComponents, ['system', 'settings']);
assert.strictEqual(defaults.supportReferenceId, reference);
assert.ok(defaults.exclusions.includes('credentials'));
assert.ok(defaults.exclusions.includes('screenshots'));
assert.ok(defaults.exclusions.includes('raw Tracking API response bodies'));
assert.strictEqual(defaults.components.logs.explicitOptIn, true);
assert.deepStrictEqual(supportBundle.selectedComponents(['logs', 'bogus', 'system', 'logs']), ['logs', 'system']);
process.stdout.write('Customer-safe support bundle preview tests passed.\n');
