'use strict';

const crypto = require('crypto');

const FINGERPRINT_VERSION = 'portal-controls-v1';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EXPECTED_STAGES = new Set(['support', 'category', 'late', 'ticket']);

function canonicalFingerprintPayload(health = {}) {
  const checks = health.checks || {};
  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    code: String(health.code || ''),
    stages: [...new Set((health.navigationVisited || []).map(String))].sort(),
    controls: {
      domain: checks.domain === true,
      authenticated: checks.authenticated === true,
      claimNavigation: checks.claimNavigation === true,
      latePackageControl: checks.latePackageControl === true,
      ticketLauncher: checks.ticketLauncher === true
    }
  };
}

function evaluateHealthResult(health = {}, checkedAt = new Date()) {
  const payload = canonicalFingerprintPayload(health);
  const compatible = health.ok === true
    && health.status === 'healthy'
    && health.code === 'HEALTHY'
    && payload.controls.domain
    && payload.controls.authenticated
    && payload.controls.claimNavigation
    && payload.controls.latePackageControl
    && payload.stages.length > 0
    && payload.stages.every(stage => EXPECTED_STAGES.has(stage))
    && payload.stages.some(stage => stage === 'late' || stage === 'ticket');
  return {
    ...payload,
    compatible,
    checkedAt: checkedAt.toISOString(),
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  };
}

function gate(latestRun, options = {}) {
  if (!latestRun) return { ok: false, code: 'PORTAL_COMPATIBILITY_REQUIRED', reason: 'Portal compatibility must be validated before a live batch.' };
  let metadata;
  try { metadata = JSON.parse(latestRun.metadata_json || '{}'); } catch (_) { metadata = {}; }
  const compatibility = metadata.portalCompatibility || {};
  if (latestRun.status !== 'complete' || compatibility.compatible !== true) {
    return { ok: false, code: 'PORTAL_COMPATIBILITY_FAILED', reason: 'The latest portal compatibility validation did not confirm all expected live-claim controls.' };
  }
  if (compatibility.fingerprintVersion !== FINGERPRINT_VERSION) {
    return { ok: false, code: 'PORTAL_COMPATIBILITY_STALE', reason: 'The portal compatibility validation uses an obsolete fingerprint.' };
  }
  const checkedAt = Date.parse(compatibility.checkedAt || '');
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  if (!Number.isFinite(checkedAt) || checkedAt > now + 60000 || now - checkedAt > Number(options.maxAgeMs || MAX_AGE_MS)) {
    return { ok: false, code: 'PORTAL_COMPATIBILITY_STALE', reason: 'The portal compatibility validation is missing or older than seven days.' };
  }
  return { ok: true, compatibility };
}

module.exports = { FINGERPRINT_VERSION, MAX_AGE_MS, EXPECTED_STAGES, canonicalFingerprintPayload, evaluateHealthResult, gate };
