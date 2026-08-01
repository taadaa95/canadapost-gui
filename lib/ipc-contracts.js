'use strict';

const MAX_KEYS = 80;
const MAX_ARRAY_ITEMS = 10000;
const MAX_STRING = 4096;

class BoundaryValidationError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'BoundaryValidationError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new BoundaryValidationError(code, message);
}

/** @param {unknown} value @param {string} channel @returns {Record<string, unknown>} */
function plainObject(value, channel) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('IPC_PAYLOAD_INVALID', `${channel} requires a plain-object payload.`);
  }
  if (Object.keys(value).length > MAX_KEYS) fail('IPC_PAYLOAD_TOO_LARGE', `${channel} contains too many fields.`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} path @param {number} [depth] @returns {unknown} */
function safeValue(value, path, depth = 0) {
  if (depth > 4) fail('IPC_PAYLOAD_TOO_DEEP', `${path} exceeds the supported nesting depth.`);
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('IPC_NUMBER_INVALID', `${path} must be a finite number.`);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) fail('IPC_STRING_TOO_LONG', `${path} exceeds ${MAX_STRING} characters.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) fail('IPC_ARRAY_TOO_LARGE', `${path} exceeds ${MAX_ARRAY_ITEMS} items.`);
    return value.map((item, index) => safeValue(item, `${path}[${index}]`, depth + 1));
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > MAX_KEYS) fail('IPC_PAYLOAD_TOO_LARGE', `${path} contains too many fields.`);
    return Object.fromEntries(entries.map(([key, item]) => {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) fail('IPC_FIELD_INVALID', `${path} contains an invalid field name.`);
      return [key, safeValue(item, `${path}.${key}`, depth + 1)];
    }));
  }
  fail('IPC_VALUE_INVALID', `${path} contains an unsupported value.`);
}

/** @param {unknown} value @param {string} channel @returns {Record<string, unknown>} */
function safeRecord(value, channel) {
  return /** @type {Record<string, unknown>} */ (safeValue(plainObject(value, channel), channel));
}

/** @param {unknown} value @param {string} channel @param {Set<string>} allowed @returns {Record<string, unknown>} */
function onlyKeys(value, channel, allowed) {
  const payload = safeRecord(value, channel);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) fail('IPC_FIELD_UNEXPECTED', `${channel} does not accept field ${key}.`);
  }
  return payload;
}

/** @param {string} text */
const keySet = text => new Set(text.trim().split(/\s+/));
const CONFIG_KEYS = keySet(`
  rememberSettings webUsername webPassword trackingClientId trackingClientSecret trackingApiEnvironment
  trackingRequestDelayMs trackingResourceTimeoutMs saveLogin saveUsernameOnly estCustomerNumber estFrom estTo
  historyCustomerNumber historyFrom historyTo historyAutoMobo historyMobo historyIncludeNoManifest
  claimStreetNumber claimStreetName claimAddressLine2 claimCity claimProvince claimPostalCode claimBusinessName
  claimContactName claimContactPhone claimContactEmail evidenceRetentionDays dryRunDefault setupCompleted locale
  developerMode freshTracking updateUrl
`);
const RUN_KEYS = new Set([...CONFIG_KEYS, ...keySet(`
  fresh browserMode afterSubmitMs betweenClaimsMs maxClaims dryRun importHistory expectedClaimCount
  selectedTrackingNumbers selectedClassificationRecords canaryMode liveSubmissionConfirmed diagnosticMode
  diagnosticConfirmed diagnosticRow structureExport scope submitOptions estWorkgroup estMobo estCategoryGroup estFileTypes
`)]);

/** @type {Readonly<Record<string, Set<string> | null>>} */
const CHANNEL_KEYS = Object.freeze({
  'config:save': CONFIG_KEYS,
  'credentials:clearTrackingApi': keySet('confirmed'),
  'locale:load': null,
  'evidence:load': keySet('screenshotPath textPath'),
  'evidence:open': null,
  'history:list': keySet('search status limit offset'),
  'history:export': keySet('search status'),
  'reconciliation:update': keySet('attemptId action note confirmationNumber'),
  'manualReview:list': keySet('status search limit'),
  'classification:list': keySet('classification search status limit offset'),
  'manualReview:update': keySet('reviewId action note'),
  'shipment:listManual': keySet('search limit offset'),
  'shipment:manualAdd': keySet('trackingNumber referenceNumber serviceCode destinationPostalCode expectedDate deliveryDate classification note'),
  'backup:create': keySet('password'),
  'backup:restore': keySet('password'),
  'privacy:preview': keySet('allRecords trackingNumbers dateFrom dateTo'),
  'privacy:delete': keySet('allRecords trackingNumbers dateFrom dateTo locale confirmed typedPhrase secondConfirmed'),
  'preflight:run': keySet('scope submitOptions'),
  'tracking:discardIncomplete': keySet('confirmed'),
  'browser:showBuiltin': keySet('bounds x y width height'),
  'browser:syncVisibility': keySet('requestId visible bounds generation reason'),
  'browser:setBuiltinBounds': keySet('x y width height'),
  'browser:clearSession': keySet('confirmed resetProfile'),
  'siteHealth:run': RUN_KEYS,
  'est:importHistory': RUN_KEYS,
  'history:import': RUN_KEYS,
  'run:start': RUN_KEYS,
  'tracking:run': RUN_KEYS,
  'submit:run': RUN_KEYS
});

const STRING_ARGUMENT_CHANNELS = new Set(['locale:load', 'evidence:open']);

/** @param {string} channel @param {unknown} payload @returns {unknown} */
function validateIpcPayload(channel, payload) {
  if (STRING_ARGUMENT_CHANNELS.has(channel)) {
    if (typeof payload !== 'string' || payload.length > MAX_STRING) {
      fail('IPC_STRING_INVALID', `${channel} requires a bounded string argument.`);
    }
    return payload;
  }
  const allowed = CHANNEL_KEYS[channel];
  if (!allowed) return payload;
  return onlyKeys(payload, channel, allowed);
}

/** @param {unknown} value @param {string} [stage] @returns {Record<string, unknown>} */
function validateWorkerEvent(value, stage = 'worker') {
  const event = safeRecord(value, `${stage}:event`);
  if (typeof event.type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(event.type)) {
    fail('WORKER_EVENT_TYPE_INVALID', `${stage} emitted an invalid event type.`);
  }
  return event;
}

module.exports = {
  BoundaryValidationError,
  CHANNEL_KEYS,
  validateIpcPayload,
  validateWorkerEvent
};
