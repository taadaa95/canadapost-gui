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
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const submit = mainSource.match(/registerIpcHandler\('submit:run'[\s\S]*?registerIpcHandler\('run:requestStop'/)?.[0] || '';
assert.ok(submit.indexOf("latestRunByType(DB_PATH, 'site_health')") < submit.indexOf('createRunSnapshot'), 'live portal gate must run before immutable snapshot creation');
assert.match(submit, /if \(!options\.dryRun\)/, 'dry diagnostics may proceed without a live portal fingerprint');
assert.match(submit, /!compatibilityGate\.ok && !options\.portalCompatibilityOverride/, 'an unverified live run must require an explicit override');

const healthHandler = mainSource.match(/registerIpcHandler\('siteHealth:run'[\s\S]*?registerIpcHandler\('est:importHistory'/)?.[0] || '';
assert.match(healthHandler, /await healthProcess/, 'explicit compatibility refresh must await the worker result');
assert.match(healthHandler, /portalCompatibility\.evaluateHealthResult\(health\)/, 'portal validation must create a versioned compatibility fingerprint');
assert.match(healthHandler, /ok: compatible/, 'only a compatible fingerprint may satisfy automatic validation');
assert.match(preloadSource, /runSiteHealth: options => ipcRenderer\.invoke\('siteHealth:run', options\)/, 'the narrow Step 3 portal-validation bridge must remain');

const startSubmit = rendererSource.match(/async function startSubmitOnly\(\)[\s\S]*?async function refreshConfig/)?.[0] || '';
assert.doesNotMatch(startSubmit, /runSiteHealth/, 'opening or starting live Step 3 must not require the removed automatic health check');
const finalPreflightIndex = startSubmit.indexOf('const preflight = dryRun ? preliminaryPreflight : await runStep3Preflight');
assert.ok(startSubmit.indexOf('confirmPortalCompatibilityOverride') < finalPreflightIndex, 'an advisory override must precede the live preflight');
assert.ok(finalPreflightIndex < startSubmit.indexOf('window.cpApp.runSubmit'), 'final preflight must still block before submission starts');
assert.match(startSubmit, /if \(!dryRun\)/, 'dry runs must not launch the live portal validation worker');
assert.ok(startSubmit.indexOf('confirmPortalCompatibilityOverride') < startSubmit.indexOf('confirmLiveSubmission'), 'Continue Anyway must proceed to the normal live acknowledgement');
const refreshAdvisory = rendererSource.match(/async function refreshPortalCompatibilityStatus[\s\S]*?function dismissPortalCompatibilityWarning/)?.[0] || '';
assert.match(refreshAdvisory, /if \(runCheck\)[\s\S]*?window\.cpApp\.runSiteHealth/, 'compatibility checks must be an explicit inline advisory action');

process.stdout.write('Versioned portal compatibility fingerprint and live gate tests passed.\n');
