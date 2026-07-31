'use strict';

function cleanString(value, { max = 4096, trim = true } = {}) {
  let text = value === null || value === undefined ? '' : String(value);
  if (trim) text = text.trim();
  return text.slice(0, Math.max(0, Number(max) || 0));
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const text = cleanString(value, { max: 16 }).toLowerCase();
  if (['true', 'yes', 'on'].includes(text)) return true;
  if (['false', 'no', 'off'].includes(text)) return false;
  return Boolean(fallback);
}

function strictBoolean(value, { fallback = false, code = 'BOOLEAN_VALUE_INVALID', field = 'value' } = {}) {
  if (value === undefined) return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  const error = new Error(`${field} must be a boolean.`);
  error.code = code;
  throw error;
}

function boundedInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0, allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || value === '')) return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeTrackingNumber(value) {
  return cleanString(value, { max: 128 }).replace(/\s+/g, '');
}

function validateTrackingSelection(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const raw of value.slice(0, 10000)) {
    const tracking = normalizeTrackingNumber(raw);
    if (!tracking || seen.has(tracking)) continue;
    seen.add(tracking);
    output.push(tracking);
  }
  return output;
}

function validateClassificationSelection(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const raw of value.slice(0, 10000)) {
    const recordId = Number(raw?.recordId);
    const evidenceHash = cleanString(raw?.evidenceHash, { max: 64 }).toLowerCase();
    if (!Number.isSafeInteger(recordId) || recordId < 1 || !/^[a-f0-9]{64}$/.test(evidenceHash) || seen.has(recordId)) continue;
    seen.add(recordId);
    output.push({ recordId, evidenceHash });
  }
  return output;
}

function validateSubmitOptions(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const browserMode = cleanString(source.browserMode, { max: 16 }).toLowerCase() === 'builtin' ? 'builtin' : 'builtin';
  return {
    webUsername: cleanString(source.webUsername, { max: 512 }),
    webPassword: cleanString(source.webPassword, { max: 4096, trim: false }),
    rememberSettings: asBoolean(source.rememberSettings, true),
    claimStreetNumber: cleanString(source.claimStreetNumber, { max: 64 }),
    claimStreetName: cleanString(source.claimStreetName, { max: 256 }),
    claimAddressLine2: cleanString(source.claimAddressLine2, { max: 256 }),
    claimCity: cleanString(source.claimCity, { max: 128 }),
    claimProvince: cleanString(source.claimProvince, { max: 64 }),
    claimPostalCode: cleanString(source.claimPostalCode, { max: 32 }).toUpperCase(),
    claimBusinessName: cleanString(source.claimBusinessName, { max: 256 }),
    claimContactName: cleanString(source.claimContactName, { max: 256 }),
    claimContactPhone: cleanString(source.claimContactPhone, { max: 64 }),
    claimContactEmail: cleanString(source.claimContactEmail, { max: 320 }),
    browserMode,
    dryRun: asBoolean(source.dryRun, false),
    developerMode: false,
    afterSubmitMs: boundedInteger(source.afterSubmitMs, { min: 5000, max: 120000, fallback: 20000 }),
    betweenClaimsMs: boundedInteger(source.betweenClaimsMs, { min: 250, max: 60000, fallback: 750 }),
    maxClaims: boundedInteger(source.maxClaims, { min: 1, max: 10000, fallback: null, allowNull: true }),
    selectedTrackingNumbers: validateTrackingSelection(source.selectedTrackingNumbers),
    selectedClassificationRecords: validateClassificationSelection(source.selectedClassificationRecords),
    canaryMode: strictBoolean(source.canaryMode, { fallback: false, code: 'SUBMIT_CANARY_INVALID', field: 'canaryMode' }),
    liveSubmissionConfirmed: asBoolean(source.liveSubmissionConfirmed, false),
    expectedClaimCount: boundedInteger(source.expectedClaimCount, { min: 0, max: 10000, fallback: 0 })
  };
}

function validatePreflightOptions(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    scope: ['all', 'step1', 'step2', 'step3'].includes(cleanString(source.scope, { max: 16 }).toLowerCase())
      ? cleanString(source.scope, { max: 16 }).toLowerCase()
      : 'all',
    submitOptions: validateSubmitOptions(source.submitOptions || {})
  };
}

module.exports = {
  cleanString,
  asBoolean,
  strictBoolean,
  boundedInteger,
  normalizeTrackingNumber,
  validateTrackingSelection,
  validateClassificationSelection,
  validateSubmitOptions,
  validatePreflightOptions
};
