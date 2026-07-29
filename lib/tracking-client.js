'use strict';

const { setTimeout: sleepTimer } = require('timers/promises');
const { request } = require('./canadapost-api');
const { CanadaPostServiceError, applicationErrorFromResponse } = require('./canadapost-errors');
const { TokenManager, normalizeCredentials, credentialMetadata } = require('./tracking-oauth');
const { parseTrackingJson } = require('./tracking-json');
const { buildSanitizedStructure } = require('./tracking-structure');
const {
  TRACKING_API_VERSION,
  TRACKING_SCOPE,
  TRACKING_ACCEPT,
  TRACKING_ENVIRONMENTS,
  normalizeEnvironment,
  environmentContract,
  trackingEndpoint
} = require('./tracking-contract');

const TRACKING_MODE = 'oauth2-json-tracking-current';
const ENDPOINT_FAMILY = 'developer-portal-tracking-v1';
const DEFAULT_RESOURCE_TIMEOUT_MS = 45000;
const MAX_RESOURCE_TIMEOUT_RETRIES = 2;

function normalizeResourceTimeoutMs(value, fallback = DEFAULT_RESOURCE_TIMEOUT_MS) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1000 || number > 120000) throw new Error('Tracking resource timeout must be an integer from 1000 to 120000 milliseconds.');
  return number;
}

function isTimeoutError(error) {
  if (error?.diagnostic) return error.diagnostic.category === 'transport_timeout';
  return Boolean(error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.code === 23 || error.code === 'ETIMEDOUT' || /(?:timed?\s*out|timeout)/i.test(String(error.message || ''))));
}

function transportTimeoutError(environment, timeoutMs, attempts) {
  return new CanadaPostServiceError({
    status: 0, tokenHttpStatus: 0, resourceHttpStatus: 0, contentType: '', applicationCode: 'TRACKING_RESOURCE_TIMEOUT',
    message: `Tracking resource request timed out after ${timeoutMs} milliseconds.`, requestId: '', endpointFamily: ENDPOINT_FAMILY,
    protocol: 'REST/JSON', environment, apiVersion: TRACKING_API_VERSION, scope: TRACKING_SCOPE, requestMethod: 'GET',
    responseHostname: '', redirectStatus: 0, redirectDestination: null, wwwAuthenticateScheme: '', htmlClassification: '',
    bodyFingerprint: 'none', retryAfterSeconds: null, category: 'transport_timeout', systemic: true,
    attempts, fingerprint: `${ENDPOINT_FAMILY}|${environment}|${TRACKING_API_VERSION}|REST/JSON|transport_timeout|0|TRACKING_RESOURCE_TIMEOUT`
  });
}

function assertTrackingMode(value = TRACKING_MODE) {
  const mode = String(value || TRACKING_MODE).trim().toLowerCase();
  if (mode !== TRACKING_MODE) {
    throw new Error('The public-beta Step 2 path requires OAuth2 and JSON. Legacy Basic/XML mode is deprecated and has no automatic fallback.');
  }
  return mode;
}

function schemaError(message, response, environment) {
  const diagnostic = {
    status: Number(response?.status || 0),
    tokenHttpStatus: 0,
    resourceHttpStatus: Number(response?.status || 0),
    contentType: String(response?.headers?.get?.('content-type') || '').slice(0, 128),
    applicationCode: 'TRACKING_JSON_SCHEMA',
    message: String(message).slice(0, 1000),
    requestId: '',
    endpointFamily: ENDPOINT_FAMILY,
    protocol: 'REST/JSON',
    environment,
    apiVersion: TRACKING_API_VERSION,
    scope: TRACKING_SCOPE,
    requestMethod: 'GET',
    responseHostname: String(response?.responseHostname || '').slice(0, 253),
    redirectStatus: 0,
    redirectDestination: null,
    wwwAuthenticateScheme: '',
    htmlClassification: '',
    bodyFingerprint: 'json:schema-invalid',
    retryAfterSeconds: null,
    category: 'schema',
    systemic: true,
    fingerprint: `${ENDPOINT_FAMILY}|${environment}|${TRACKING_API_VERSION}|REST/JSON|schema|${Number(response?.status || 0)}`
  };
  return new CanadaPostServiceError(diagnostic);
}

function noTrackingError(response, environment) {
  const diagnostic = {
    status: Number(response?.status || 200), tokenHttpStatus: 0, resourceHttpStatus: Number(response?.status || 200),
    contentType: String(response?.headers?.get?.('content-type') || '').slice(0, 128), applicationCode: 'TRACKING_NOT_FOUND',
    message: 'Canada Post returned no active or archived tracking record for this shipment.', requestId: '', endpointFamily: ENDPOINT_FAMILY,
    protocol: 'REST/JSON', environment, apiVersion: TRACKING_API_VERSION, scope: TRACKING_SCOPE, requestMethod: 'GET',
    responseHostname: String(response?.responseHostname || '').slice(0, 253), redirectStatus: 0, redirectDestination: null,
    wwwAuthenticateScheme: '', htmlClassification: '', bodyFingerprint: 'json:tracking-not-found', retryAfterSeconds: null,
    category: 'shipment_not_found', systemic: false,
    fingerprint: `${ENDPOINT_FAMILY}|${environment}|${TRACKING_API_VERSION}|REST/JSON|shipment_not_found`
  };
  return new CanadaPostServiceError(diagnostic);
}

class TrackingClient {
  constructor(options = {}) {
    this.requestImpl = options.requestImpl || request;
    this.onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    this.allowMock = options.allowMock === true;
    this.baseUrl = options.baseUrl || '';
    this.tokenUrl = options.tokenUrl || '';
    this.tokenTimeoutMs = Number(options.tokenTimeoutMs || 30000);
    this.resourceTimeoutMs = normalizeResourceTimeoutMs(options.resourceTimeoutMs ?? options.timeoutMs);
    this.maxTimeoutRetries = Math.max(0, Math.min(MAX_RESOURCE_TIMEOUT_RETRIES, Number(options.maxTimeoutRetries ?? MAX_RESOURCE_TIMEOUT_RETRIES)));
    this.random = options.random || Math.random;
    this.sleep = options.sleep || ((ms, signal) => sleepTimer(ms, undefined, { signal }));
    this.beforeResourceRetry = typeof options.beforeResourceRetry === 'function' ? options.beforeResourceRetry : async () => {};
    this.tokenManager = options.tokenManager || new TokenManager({
      requestImpl: this.requestImpl,
      onStage: event => this.onStage(event),
      allowMock: this.allowMock,
      tokenUrl: this.tokenUrl,
      timeoutMs: this.tokenTimeoutMs,
      monotonicNow: options.monotonicNow
    });
  }

  clearToken(reason, environment) {
    this.tokenManager.clear(reason, environment);
  }

  async getTracking(pin, credentials, options = {}) {
    assertTrackingMode(options.mode || TRACKING_MODE);
    const environment = normalizeEnvironment(options.environment || 'test');
    const normalizedCredentials = normalizeCredentials(credentials);
    const contract = environmentContract(environment);
    const baseUrl = String(options.baseUrl || this.baseUrl || contract.trackingBaseUrl);
    const endpoint = trackingEndpoint(pin, { environment, baseUrl });
    const tokenOptions = {
      environment,
      tokenUrl: options.tokenUrl || this.tokenUrl || (options.baseUrl ? `${String(options.baseUrl).replace(/\/$/, '')}/oauth2/token` : contract.tokenUrl),
      allowMock: options.allowMock === true || this.allowMock,
      signal: options.signal,
      timeoutMs: options.tokenTimeoutMs || this.tokenTimeoutMs
    };
    let token = await this.tokenManager.getToken(normalizedCredentials, tokenOptions);
    let refreshed = false;
    let timeoutRetry = 0;
    for (;;) {
      this.onStage({ stage: 'tracking_request_sent', environment, apiVersion: TRACKING_API_VERSION, scope: TRACKING_SCOPE, endpointHostname: new URL(endpoint).hostname });
      try {
        const response = await this.requestImpl({
          url: endpoint,
          method: 'GET',
          accept: TRACKING_ACCEPT,
          bearerToken: token,
          sensitiveValues: [normalizedCredentials.clientId, normalizedCredentials.clientSecret, token],
          timeoutMs: normalizeResourceTimeoutMs(options.resourceTimeoutMs ?? options.timeoutMs, this.resourceTimeoutMs),
          retries: 0,
          allowMock: options.allowMock === true || this.allowMock,
          signal: options.signal,
          endpointFamily: ENDPOINT_FAMILY,
          protocol: 'REST/JSON',
          environment,
          apiVersion: TRACKING_API_VERSION,
          scope: TRACKING_SCOPE,
          diagnosticStage: 'resource'
        });
        const applicationError = applicationErrorFromResponse(response, {
          endpointFamily: ENDPOINT_FAMILY,
          protocol: 'REST/JSON',
          sensitiveValues: [normalizedCredentials.clientId, normalizedCredentials.clientSecret, token],
          requestMethod: 'GET',
          responseHostname: response.responseHostname || new URL(endpoint).hostname,
          environment,
          apiVersion: TRACKING_API_VERSION,
          scope: TRACKING_SCOPE,
          diagnosticStage: 'resource'
        });
        if (applicationError) throw applicationError;
        let payload;
        let detail;
        try {
          payload = JSON.parse(response.body);
          detail = parseTrackingJson(payload, pin);
        } catch (error) {
          const failure = schemaError(error.message, response, environment);
          if (options.includeSanitizedStructure && payload && typeof payload === 'object') {
            failure.sanitizedStructure = buildSanitizedStructure(payload, {
              apiVersion: TRACKING_API_VERSION,
              responseShape: 'unrecognized',
              validationErrors: [error.message]
            });
          }
          throw failure;
        }
        if (!detail.activeExists && !detail.archiveExists) throw noTrackingError(response, environment);
        this.onStage({ stage: 'tracking_json_received', environment, apiVersion: TRACKING_API_VERSION, scope: TRACKING_SCOPE, resourceHttpStatus: response.status, contentType: String(response.headers?.get?.('content-type') || '').slice(0, 128), archiveState: detail.archiveState });
        const structure = options.includeSanitizedStructure
          ? buildSanitizedStructure(payload, { apiVersion: TRACKING_API_VERSION, responseShape: detail.schema.responseShape })
          : null;
        // The response body is deliberately dropped here. Callers receive normalized data and,
        // when explicitly requested, a value-free structural report only.
        return {
          status: response.status,
          headers: response.headers,
          responseHostname: response.responseHostname,
          environment: response.environment,
          requestMethod: response.requestMethod,
          detail,
          structure,
          tokenRefreshed: refreshed
        };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (isTimeoutError(error) || error?.diagnostic?.category === 'transport_timeout') {
          const timeoutMs = normalizeResourceTimeoutMs(options.resourceTimeoutMs ?? options.timeoutMs, this.resourceTimeoutMs);
          const failure = error?.diagnostic?.category === 'transport_timeout' ? error : transportTimeoutError(environment, timeoutMs, timeoutRetry + 1);
          if (timeoutRetry >= this.maxTimeoutRetries) {
            failure.diagnostic.attempts = timeoutRetry + 1;
            throw failure;
          }
          timeoutRetry += 1;
          const jitterMs = Math.max(0, Math.min(250, Math.floor(Number(this.random()) * 251)));
          const delayMs = Math.min(5000, 1000 * (2 ** (timeoutRetry - 1))) + jitterMs;
          this.onStage({ stage: 'tracking_timeout_backoff', environment, apiVersion: TRACKING_API_VERSION, scope: TRACKING_SCOPE, timeoutMs, retryAttempt: timeoutRetry, maxRetries: this.maxTimeoutRetries, delayMs, jitterMs });
          await this.sleep(delayMs, options.signal);
          continue;
        }
        if (error?.diagnostic?.status === 401 && !refreshed) {
          refreshed = true;
          this.tokenManager.clear('resource-401', environment);
          token = await this.tokenManager.getToken(normalizedCredentials, tokenOptions);
          await this.beforeResourceRetry({ reason: 'resource-401', signal: options.signal });
          continue;
        }
        if (error?.diagnostic?.status === 401) this.tokenManager.clear('second-resource-401', environment);
        throw error;
      }
    }
  }
}

class SystemicCircuitBreaker {
  constructor({ threshold = 3 } = {}) { this.threshold = threshold; this.fingerprint = ''; this.count = 0; this.open = false; this.diagnostic = null; }
  success() { this.fingerprint = ''; this.count = 0; }
  record(error) {
    const diagnostic = error?.diagnostic || null;
    if (!diagnostic?.systemic) { this.success(); return { opened: false, count: 0, diagnostic }; }
    if (diagnostic.fingerprint === this.fingerprint) this.count += 1;
    else { this.fingerprint = diagnostic.fingerprint; this.count = 1; }
    this.diagnostic = diagnostic;
    if (this.count >= this.threshold) this.open = true;
    return { opened: this.open, count: this.count, diagnostic };
  }
}

function redactedTracking(pin) {
  const value = String(pin || '').replace(/\s+/g, '');
  return value ? `[REDACTED:${value.slice(-4)}]` : '[REDACTED]';
}

const defaultClient = new TrackingClient();
async function getTracking(pin, credentials, options = {}) { return await defaultClient.getTracking(pin, credentials, options); }

module.exports = {
  TRACKING_MODE,
  ENDPOINT_FAMILY,
  ACCEPT: TRACKING_ACCEPT,
  TRACKING_API_VERSION,
  TRACKING_SCOPE,
  TRACKING_ENVIRONMENTS,
  normalizeEnvironment,
  normalizeCredentials,
  credentialMetadata,
  assertTrackingMode,
  trackingEndpoint,
  TrackingClient,
  getTracking,
  SystemicCircuitBreaker,
  redactedTracking,
  DEFAULT_RESOURCE_TIMEOUT_MS,
  MAX_RESOURCE_TIMEOUT_RETRIES,
  normalizeResourceTimeoutMs,
  isTimeoutError
};
