'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const portalCompatibility = require('../lib/portal-compatibility');

const now = new Date('2026-08-01T12:00:00.000Z');
const healthy = portalCompatibility.evaluateHealthResult({
  ok: true, status: 'healthy', code: 'HEALTHY', navigationVisited: ['support', 'late'],
  checks: { domain: true, authenticated: true, claimNavigation: true, latePackageControl: true, ticketLauncher: false }
}, now);
assert.strictEqual(healthy.compatible, true);
assert.match(healthy.fingerprint, /^[a-f0-9]{64}$/);
assert.strictEqual(portalCompatibility.gate({ status: 'complete', metadata_json: JSON.stringify({ portalCompatibility: healthy }) }, { now }).ok, true);

for (const health of [
  { ok: false, status: 'failed', code: 'CLAIM_NAVIGATION_CHANGED', checks: {} },
  { ok: true, status: 'warning', code: 'VERIFICATION_REQUIRED', checks: { domain: true } },
  { ok: true, status: 'healthy', code: 'HEALTHY', navigationVisited: ['support'], checks: { domain: true, authenticated: true, claimNavigation: false, latePackageControl: false } },
  { ok: true, status: 'healthy', code: 'HEALTHY', navigationVisited: ['unknown-stage', 'late'], checks: { domain: true, authenticated: true, claimNavigation: true, latePackageControl: true } },
  { ok: true, status: 'healthy', code: 'HEALTHY', navigationVisited: ['support'], checks: { domain: true, authenticated: true, claimNavigation: true, latePackageControl: true } }
]) assert.strictEqual(portalCompatibility.evaluateHealthResult(health, now).compatible, false);

assert.strictEqual(portalCompatibility.gate(null, { now }).code, 'PORTAL_COMPATIBILITY_REQUIRED');
assert.strictEqual(portalCompatibility.gate({ status: 'failed', metadata_json: '{}' }, { now }).code, 'PORTAL_COMPATIBILITY_FAILED');
assert.strictEqual(portalCompatibility.gate({ status: 'complete', metadata_json: JSON.stringify({ portalCompatibility: { ...healthy, fingerprintVersion: 'old' } }) }, { now }).code, 'PORTAL_COMPATIBILITY_STALE');
assert.strictEqual(portalCompatibility.gate({ status: 'complete', metadata_json: JSON.stringify({ portalCompatibility: { ...healthy, checkedAt: '2026-07-01T00:00:00.000Z' } }) }, { now }).code, 'PORTAL_COMPATIBILITY_STALE');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const submit = mainSource.match(/registerIpcHandler\('submit:run'[\s\S]*?registerIpcHandler\('run:requestStop'/)?.[0] || '';
assert.ok(submit.indexOf("latestRunByType(DB_PATH, 'site_health')") < submit.indexOf('createRunSnapshot'), 'live portal gate must run before immutable snapshot creation');
assert.match(submit, /if \(!options\.dryRun\)/, 'dry diagnostics may proceed without a live portal fingerprint');

process.stdout.write('Versioned portal compatibility fingerprint and live gate tests passed.\n');
