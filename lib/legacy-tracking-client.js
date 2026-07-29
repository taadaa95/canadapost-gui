'use strict';

const { request } = require('./canadapost-api');

const LEGACY_TRACKING_MODE = 'legacy-basic-rest-v2';
const LEGACY_ACCEPT = 'application/vnd.cpc.track-v2+xml';
const LEGACY_ENVIRONMENTS = Object.freeze({
  production: 'https://soa-gw.canadapost.ca',
  development: 'https://ct.soa-gw.canadapost.ca'
});

function legacyTrackingEndpoint(pin, { baseUrl = LEGACY_ENVIRONMENTS.production } = {}) {
  const normalized = String(pin || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{10,35}$/.test(normalized)) throw new Error('Legacy tracking number format is invalid.');
  return `${String(baseUrl).replace(/\/$/, '')}/vis/track/pin/${encodeURIComponent(normalized)}/detail`;
}

async function getLegacyTracking(pin, credentials, options = {}) {
  if (options.enabled !== true) throw new Error('Legacy Tracking API is deprecated and disabled. No OAuth-to-Basic fallback is permitted.');
  const environment = options.environment === 'development' ? 'development' : 'production';
  return await (options.requestImpl || request)({
    url: legacyTrackingEndpoint(pin, { baseUrl: options.baseUrl || LEGACY_ENVIRONMENTS[environment] }),
    method: 'GET',
    accept: LEGACY_ACCEPT,
    username: String(credentials?.username || '').trim(),
    password: String(credentials?.password || '').trim(),
    allowMock: options.allowMock === true,
    retries: 0,
    endpointFamily: 'legacy-developer-program-tracking-v2',
    protocol: 'REST/XML',
    environment
  });
}

module.exports = { LEGACY_TRACKING_MODE, LEGACY_ACCEPT, LEGACY_ENVIRONMENTS, legacyTrackingEndpoint, getLegacyTracking };
