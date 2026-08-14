'use strict';

const TRACKING_API_VERSION = '1.0.0';
const TRACKING_PLATFORM_RELEASE = '2026-04-30';
const TRACKING_SCOPE = 'merchant';
const TRACKING_ACCEPT = 'application/json';
const TOKEN_CONTENT_TYPE = 'application/x-www-form-urlencoded';
const TOKEN_PATH = '/prod/devportal-portaildesdeveloppeurs/cpc-api-native-oauth-provider/oauth2/token';
const TRACKING_PATH_PREFIX = '/prod/devportal-portaildesdeveloppeurs/tracking/v1';

const TRACKING_ENVIRONMENTS = Object.freeze({
  production: Object.freeze({
    gatewayOrigin: 'https://api.canadapost-postescanada.ca',
    credentialLabel: 'production'
  }),
  test: Object.freeze({
    gatewayOrigin: 'https://api-stg.canadapost-postescanada.ca',
    credentialLabel: 'test'
  })
});

function normalizeEnvironment(value = 'test') {
  const raw = String(value || 'test').trim().toLowerCase();
  const environment = raw === 'development' ? 'test' : raw;
  if (!Object.prototype.hasOwnProperty.call(TRACKING_ENVIRONMENTS, environment)) {
    throw new Error('Tracking API environment must be test or production.');
  }
  return environment;
}

function environmentContract(value = 'test') {
  const environment = normalizeEnvironment(value);
  const entry = TRACKING_ENVIRONMENTS[environment];
  return {
    environment,
    gatewayOrigin: entry.gatewayOrigin,
    tokenUrl: `${entry.gatewayOrigin}${TOKEN_PATH}`,
    trackingBaseUrl: `${entry.gatewayOrigin}${TRACKING_PATH_PREFIX}`
  };
}

function trackingEndpoint(pin, options = {}) {
  const environment = normalizeEnvironment(options.environment || 'test');
  const normalized = String(pin || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{12,16}$/.test(normalized)) {
    throw new Error('Tracking PIN must contain 12 to 16 letters or digits.');
  }
  const baseUrl = String(options.baseUrl || environmentContract(environment).trackingBaseUrl).replace(/\/$/, '');
  return `${baseUrl}/pins/${encodeURIComponent(normalized)}/details`;
}

module.exports = {
  TRACKING_API_VERSION,
  TRACKING_PLATFORM_RELEASE,
  TRACKING_SCOPE,
  TRACKING_ACCEPT,
  TOKEN_CONTENT_TYPE,
  TOKEN_PATH,
  TRACKING_PATH_PREFIX,
  TRACKING_ENVIRONMENTS,
  normalizeEnvironment,
  environmentContract,
  trackingEndpoint
};
