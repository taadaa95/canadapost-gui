'use strict';

const assert = require('assert');
const { buildPreflightReport } = require('../lib/preflight');
const diagnosticGate = require('../lib/tracking-diagnostic-gate');
const { TRACKING_API_VERSION } = require('../lib/tracking-contract');

const ready = buildPreflightReport({
  scope: 'step3',
  storageWritable: true,
  databaseIntegrity: { ok: true, result: 'ok' },
  webUsernameAvailable: true,
  webPasswordAvailable: true,
  claimAddressAvailable: true,
  claimCount: 2,
  builtinBrowserRequired: true,
  step3WorkersAvailable: true,
  reconciliationCount: 0
});
assert.strictEqual(ready.ready, true);
assert.strictEqual(ready.blockingCount, 0);

const blocked = buildPreflightReport({
  scope: 'step3',
  storageWritable: true,
  databaseIntegrity: { ok: true, result: 'ok' },
  webUsernameAvailable: false,
  webPasswordAvailable: false,
  claimAddressAvailable: false,
  claimCount: 0,
  builtinBrowserRequired: true,
  step3WorkersAvailable: true,
  reconciliationCount: 2
});
assert.strictEqual(blocked.ready, false);
assert.strictEqual(blocked.blockingCount, 4);
assert.strictEqual(blocked.warningCount, 1);

const legacyOnly = buildPreflightReport({
  scope: 'step2', storageWritable: true, databaseIntegrity: { ok: true },
  apiCredentialsAvailable: false, legacyApiCredentialsAvailable: true,
  apiCredentialMetadata: { selectedEnvironment: 'production', credentialEnvironment: 'unknown', apiVersion: TRACKING_API_VERSION },
  trackingDiagnosticGateSatisfied: false, trackingCsvAvailable: true, nodeRuntimeAvailable: true
});
assert.strictEqual(legacyOnly.ready, false);
assert.match(legacyOnly.checks.find(item => item.id === 'tracking-api-credentials').message, /Only deprecated legacy/);

const currentStep2 = buildPreflightReport({
  scope: 'step2', storageWritable: true, databaseIntegrity: { ok: true },
  apiCredentialsAvailable: true,
  apiCredentialMetadata: { selectedEnvironment: 'test', credentialEnvironment: 'production', apiVersion: TRACKING_API_VERSION },
  trackingDiagnosticGateSatisfied: false, trackingCsvAvailable: true, nodeRuntimeAvailable: true
});
assert.strictEqual(currentStep2.ready, false);
assert.strictEqual(currentStep2.checks.find(item => item.id === 'tracking-api-environment').ok, false);

let gate = diagnosticGate.invalidate({}, { newRevision: true, revisionFactory: () => 'revision-one' });
assert.strictEqual(diagnosticGate.isSatisfied(gate, 'test'), false);
gate = diagnosticGate.markSucceeded(gate, 'test', { succeededAt: '2026-07-28T00:00:00.000Z' });
assert.strictEqual(diagnosticGate.isSatisfied(gate, 'test'), true);
assert.strictEqual(diagnosticGate.isSatisfied(gate, 'production'), false, 'environment changes invalidate the gate');
assert.strictEqual(diagnosticGate.isSatisfied(gate, 'test', 'future-version'), false, 'API version changes invalidate the gate');
assert.strictEqual(diagnosticGate.isSatisfied(gate, 'test', undefined, 'future-parser'), false, 'parser version changes invalidate the gate');
const changed = diagnosticGate.invalidate(gate, { newRevision: true, revisionFactory: () => 'revision-two' });
assert.strictEqual(changed.trackingCredentialRevision, 'revision-two');
assert.strictEqual(diagnosticGate.isSatisfied(changed, 'test'), false, 'credential changes invalidate the gate');

console.log('Preflight readiness tests passed.');
