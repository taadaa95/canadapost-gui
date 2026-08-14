'use strict';

const { performance } = require('perf_hooks');
const { request } = require('./canadapost-api');
const {
  TRACKING_API_VERSION,
  TRACKING_SCOPE,
  TRACKING_ACCEPT,
  TOKEN_CONTENT_TYPE,
  normalizeEnvironment,
  environmentContract
} = require('./tracking-contract');

const ENDPOINT_FAMILY = 'developer-portal-oauth2';
const CLIENT_ID_HEADER = 'X-IBM-Client-Id';
const CLIENT_SECRET_HEADER = 'X-IBM-Client-Secret';

function normalizeCredentials(credentials = {}) {
  return {
    clientId: String(credentials.clientId || '').trim(),
    clientSecret: String(credentials.clientSecret || '').trim(),
    environment: credentials.environment ? normalizeEnvironment(credentials.environment) : ''
  };
}

function credentialMetadata(credentials = {}, selectedEnvironment = 'test') {
  const normalized = normalizeCredentials(credentials);
  return {
    clientId: { present: Boolean(normalized.clientId) },
    clientSecret: { present: Boolean(normalized.clientSecret) },
    selectedEnvironment: normalizeEnvironment(selectedEnvironment),
    credentialEnvironment: normalized.environment || 'unknown',
    apiVersion: TRACKING_API_VERSION,
    scope: TRACKING_SCOPE,
    legacyCredentialsActive: false
  };
}

function credentialError(code, message, environment) {
  const error = new Error(message);
  error.diagnostic = {
    status: 0,
    tokenHttpStatus: 0,
    resourceHttpStatus: 0,
    contentType: '',
    applicationCode: code,
    message,
    requestId: '',
    endpointFamily: ENDPOINT_FAMILY,
    protocol: 'OAuth2',
    environment,
    apiVersion: TRACKING_API_VERSION,
    scope: TRACKING_SCOPE,
    requestMethod: 'POST',
    responseHostname: '',
    redirectStatus: 0,
    redirectDestination: null,
    wwwAuthenticateScheme: '',
    htmlClassification: '',
    bodyFingerprint: 'none',
    retryAfterSeconds: null,
    category: code === 'TRACKING_ENVIRONMENT_MISMATCH' ? 'credential_environment' : 'token_authentication',
    systemic: true,
    fingerprint: `${ENDPOINT_FAMILY}|${environment}|OAuth2|${code}`
  };
  return error;
}

function validateTokenPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Canada Post OAuth token response was not a JSON object.');
  }
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  const tokenType = typeof payload.token_type === 'string' ? payload.token_type.trim() : '';
  const expiresIn = Number(payload.expires_in);
  const scopes = String(payload.scope || '').trim().split(/\s+/).filter(Boolean);
  if (!accessToken || !/^Bearer$/i.test(tokenType) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Canada Post OAuth token response was missing a valid Bearer access token or expiry.');
  }
  if (!scopes.includes(TRACKING_SCOPE)) {
    throw new Error('Canada Post OAuth token response did not grant the required merchant scope.');
  }
  return { accessToken, tokenType: 'Bearer', expiresIn, scope: TRACKING_SCOPE };
}

class TokenManager {
  constructor(options = {}) {
    this.requestImpl = options.requestImpl || request;
    this.monotonicNow = options.monotonicNow || (() => performance.now());
    this.onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
    this.allowMock = options.allowMock === true;
    this.tokenUrl = options.tokenUrl || '';
    this.timeoutMs = Number(options.timeoutMs || 30000);
    this.cached = null;
    this.pending = null;
    this.pendingEnvironment = '';
    this.lastEnvironment = '';
  }

  clear(reason = 'cleared', requestedEnvironment = '') {
    const environment = this.cached?.environment || this.pendingEnvironment || this.lastEnvironment || (requestedEnvironment ? normalizeEnvironment(requestedEnvironment) : '');
    this.cached = null;
    this.pending = null;
    this.pendingEnvironment = '';
    this.onStage({ stage: 'token_cleared', reason: String(reason).slice(0, 64), environment });
  }

  hasValidToken(environment) {
    return Boolean(this.cached && this.cached.environment === environment && this.monotonicNow() < this.cached.refreshAt);
  }

  async getToken(credentials, options = {}) {
    const environment = normalizeEnvironment(options.environment || 'test');
    const normalized = normalizeCredentials(credentials);
    if (!normalized.clientId || !normalized.clientSecret) {
      throw credentialError('TRACKING_API_CREDENTIALS_MISSING', 'Missing Tracking API client ID or client secret.', environment);
    }
    if (normalized.environment && normalized.environment !== environment) {
      throw credentialError('TRACKING_ENVIRONMENT_MISMATCH', `The saved Tracking API credentials are for ${normalized.environment}, but the ${environment} gateway is selected.`, environment);
    }
    if (this.cached && this.cached.environment !== environment) this.clear('environment-changed', environment);
    if (this.pending && this.pendingEnvironment !== environment) this.clear('environment-changed', environment);
    this.lastEnvironment = environment;
    if (this.hasValidToken(environment)) {
      this.onStage({ stage: 'token_cached', environment, scope: TRACKING_SCOPE, apiVersion: TRACKING_API_VERSION });
      return this.cached.accessToken;
    }
    if (this.pending && this.pendingEnvironment === environment) return this.pending;
    this.pendingEnvironment = environment;
    this.pending = this.acquireToken(normalized, { ...options, environment });
    try {
      return await this.pending;
    } finally {
      this.pending = null;
      this.pendingEnvironment = '';
    }
  }

  async acquireToken(credentials, options = {}) {
    const environment = normalizeEnvironment(options.environment || 'test');
    const contract = environmentContract(environment);
    const tokenUrl = String(options.tokenUrl || this.tokenUrl || contract.tokenUrl);
    this.onStage({ stage: 'token_request_sent', environment, scope: TRACKING_SCOPE, apiVersion: TRACKING_API_VERSION, endpointHostname: new URL(tokenUrl).hostname });
    let response;
    try {
      response = await this.requestImpl({
        url: tokenUrl,
        method: 'POST',
        accept: TRACKING_ACCEPT,
        acceptLanguage: '',
        contentType: TOKEN_CONTENT_TYPE,
        body: new URLSearchParams({ scope: TRACKING_SCOPE, grant_type: 'client_credentials' }).toString(),
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        sensitiveValues: [credentials.clientId, credentials.clientSecret],
        timeoutMs: Number(options.timeoutMs || this.timeoutMs),
        retries: 0,
        allowMock: options.allowMock === true || this.allowMock,
        signal: options.signal,
        endpointFamily: ENDPOINT_FAMILY,
        protocol: 'OAuth2',
        environment,
        apiVersion: TRACKING_API_VERSION,
        scope: TRACKING_SCOPE,
        diagnosticStage: 'token'
      });
    } catch (error) {
      this.clear('authentication-failed', environment);
      this.onStage({ stage: 'token_failed', environment, scope: TRACKING_SCOPE, tokenHttpStatus: Number(error?.diagnostic?.status || 0), diagnostic: error?.diagnostic || null });
      throw error;
    }
    let parsed;
    try {
      parsed = validateTokenPayload(JSON.parse(response.body));
    } catch (cause) {
      this.clear('malformed-token', environment);
      const error = credentialError('OAUTH_TOKEN_SCHEMA', cause.message, environment);
      error.diagnostic.status = response.status;
      error.diagnostic.tokenHttpStatus = response.status;
      error.diagnostic.contentType = String(response.headers?.get?.('content-type') || '').slice(0, 128);
      error.diagnostic.responseHostname = response.responseHostname || new URL(tokenUrl).hostname;
      error.diagnostic.category = /scope/i.test(cause.message) ? 'incorrect_scope' : 'token_schema';
      error.diagnostic.fingerprint = `${ENDPOINT_FAMILY}|${environment}|OAuth2|${error.diagnostic.category}|${response.status}`;
      this.onStage({ stage: 'token_failed', environment, scope: TRACKING_SCOPE, tokenHttpStatus: response.status, diagnostic: error.diagnostic });
      throw error;
    }
    const now = this.monotonicNow();
    const lifetimeMs = parsed.expiresIn * 1000;
    const refreshSkewMs = Math.min(60000, Math.max(1000, lifetimeMs * 0.1));
    this.cached = {
      accessToken: parsed.accessToken,
      environment,
      expiresAt: now + lifetimeMs,
      refreshAt: now + Math.max(0, lifetimeMs - refreshSkewMs)
    };
    this.onStage({ stage: 'token_acquired', environment, scope: TRACKING_SCOPE, apiVersion: TRACKING_API_VERSION, tokenHttpStatus: response.status, expiresIn: parsed.expiresIn });
    return parsed.accessToken;
  }
}

module.exports = {
  ENDPOINT_FAMILY,
  CLIENT_ID_HEADER,
  CLIENT_SECRET_HEADER,
  normalizeCredentials,
  credentialMetadata,
  validateTokenPayload,
  TokenManager
};
