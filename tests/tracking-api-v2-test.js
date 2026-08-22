'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CanadaPostServiceError, parseCanadaPostError } = require('../lib/canadapost-errors');
const { sanitizedRedirect } = require('../lib/canadapost-api');
const { TokenManager, validateTokenPayload, CLIENT_ID_HEADER, CLIENT_SECRET_HEADER } = require('../lib/tracking-oauth');
const { TrackingClient, TRACKING_MODE } = require('../lib/tracking-client');
const { parseTrackingJson, normalizedTrackingEvents } = require('../lib/tracking-json');
const { normalizeTrackingEvents } = require('../lib/tracking-normalizer');
const {
  TRACKING_API_VERSION, TRACKING_SCOPE, TRACKING_ACCEPT, TOKEN_CONTENT_TYPE,
  environmentContract, trackingEndpoint
} = require('../lib/tracking-contract');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tracking-api-1.0.0.contract.json'), 'utf8'));
const syntheticPin = 'ZXCVBN120045';
const syntheticDetail = {
  pin: syntheticPin,
  activeExists: true,
  archiveExists: false,
  expectedDeliveryDate: '2026-06-02',
  changedExpectedDate: '2026-06-03',
  serviceName: 'Synthetic Service',
  serviceName2: 'Service synthétique',
  deliveryOptions: [{ deliveryOption: 'SYN', deliveryOptionDescription: 'Synthetic option' }],
  destinationPostalId: 'A0A',
  customerRef1: 'SYNTHETIC-REF-1',
  customerRef2: 'SYNTHETIC-REF-2',
  signatureImageExists: false,
  suppressSignature: false,
  significantEvents: [
    { eventIdentifier: 'ATTEMPT', eventDate: '2026-06-04', eventTime: '14:15:00', eventTimeZone: 'EDT', eventDescription: 'Delivery attempt made', eventSite: 'SYNTHETIC', unknownField: true },
    { eventIdentifier: 'DELIVERED', eventDate: '2026-06-05', eventTime: '09:30:00', eventTimeZone: 'EDT', eventDescription: 'Delivered' }
  ],
  unknownTopLevel: { ignored: true }
};

function response(status, body, contentType = 'application/json', extraHeaders = {}) {
  return { status, body: typeof body === 'string' ? body : JSON.stringify(body), headers: new Headers({ 'content-type': contentType, ...extraHeaders }), responseHostname: 'mock.local' };
}

function service401(stage = 'resource') {
  return new CanadaPostServiceError(parseCanadaPostError({ status: 401, headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify({ httpCode: '401', httpMessage: 'Unauthorized' }), endpointFamily: stage === 'token' ? 'developer-portal-oauth2' : 'developer-portal-tracking-v1', protocol: stage === 'token' ? 'OAuth2' : 'REST/JSON', diagnosticStage: stage, apiVersion: TRACKING_API_VERSION, scope: TRACKING_SCOPE }));
}

async function main() {
  assert.strictEqual(TRACKING_API_VERSION, fixture.apiVersion);
  assert.strictEqual(TRACKING_SCOPE, 'merchant');
  assert.strictEqual(TRACKING_ACCEPT, 'application/json');
  assert.strictEqual(TOKEN_CONTENT_TYPE, 'application/x-www-form-urlencoded');
  assert.strictEqual(CLIENT_ID_HEADER, 'X-IBM-Client-Id');
  assert.strictEqual(CLIENT_SECRET_HEADER, 'X-IBM-Client-Secret');
  assert.strictEqual(environmentContract('production').tokenUrl, `${fixture.production.gatewayOrigin}${fixture.production.tokenPath}`);
  assert.strictEqual(environmentContract('test').tokenUrl, `${fixture.test.gatewayOrigin}${fixture.test.tokenPath}`);
  assert.strictEqual(trackingEndpoint(syntheticPin, { environment: 'production' }), `${fixture.production.gatewayOrigin}${fixture.production.trackingBasePath}/pins/${syntheticPin}/details`);
  assert.strictEqual(trackingEndpoint(syntheticPin, { environment: 'test' }), `${fixture.test.gatewayOrigin}${fixture.test.trackingBasePath}/pins/${syntheticPin}/details`);

  assert.deepStrictEqual(validateTokenPayload({ token_type: 'Bearer', access_token: 'synthetic-token', expires_in: 3600, scope: 'merchant' }), { tokenType: 'Bearer', accessToken: 'synthetic-token', expiresIn: 3600, scope: 'merchant' });
  assert.throws(() => validateTokenPayload({ token_type: 'Bearer', expires_in: 3600, scope: 'merchant' }), /valid Bearer/);
  assert.throws(() => validateTokenPayload({ token_type: 'Bearer', access_token: 'synthetic-token', expires_in: 3600, scope: 'other' }), /merchant scope/);

  await assert.rejects(() => new TokenManager({ requestImpl: async () => { throw new Error('must not request'); } }).getToken({}, { environment: 'test' }), /Missing Tracking API client ID/);
  await assert.rejects(() => new TokenManager({ requestImpl: async () => { throw new Error('must not request'); } }).getToken({ clientId: 'current', clientSecret: 'secret', environment: 'production' }, { environment: 'test' }), /production.*test/);

  let now = 1000;
  const tokenCalls = [];
  const tokenManager = new TokenManager({
    monotonicNow: () => now,
    requestImpl: async options => {
      tokenCalls.push(options);
      return response(200, { token_type: 'Bearer', access_token: `synthetic-token-${tokenCalls.length}`, expires_in: 100, scope: 'merchant' });
    }
  });
  const credentials = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', environment: 'test' };
  assert.strictEqual(await tokenManager.getToken(credentials, { environment: 'test' }), 'synthetic-token-1');
  assert.strictEqual(await tokenManager.getToken(credentials, { environment: 'test' }), 'synthetic-token-1');
  assert.strictEqual(tokenCalls.length, 1, 'valid token must be cached in memory');
  assert.strictEqual(tokenCalls[0].method, 'POST');
  assert.strictEqual(tokenCalls[0].clientId, credentials.clientId);
  assert.strictEqual(tokenCalls[0].clientSecret, credentials.clientSecret);
  assert.strictEqual(tokenCalls[0].accept, 'application/json');
  assert.strictEqual(tokenCalls[0].contentType, 'application/x-www-form-urlencoded');
  assert.deepStrictEqual(Object.fromEntries(new URLSearchParams(tokenCalls[0].body)), { scope: 'merchant', grant_type: 'client_credentials' });
  assert.strictEqual(tokenCalls[0].bearerToken, undefined);
  assert.strictEqual(tokenCalls[0].username, undefined);
  now += 91000;
  assert.strictEqual(await tokenManager.getToken(credentials, { environment: 'test' }), 'synthetic-token-2');
  assert.strictEqual(tokenCalls.length, 2, 'token must refresh before official expiry');

  const environmentStages = [];
  let environmentTokenCalls = 0;
  const environmentManager = new TokenManager({
    onStage: event => environmentStages.push(event),
    requestImpl: async options => {
      environmentTokenCalls += 1;
      return response(200, { token_type: 'Bearer', access_token: `${options.environment}-token-${environmentTokenCalls}`, expires_in: 3600, scope: 'merchant' });
    }
  });
  const environmentNeutralCredentials = { clientId: 'current', clientSecret: 'secret' };
  assert.match(await environmentManager.getToken(environmentNeutralCredentials, { environment: 'production' }), /^production-token/);
  environmentManager.clear('worker-finished', 'production');
  assert.strictEqual(environmentStages.at(-1).environment, 'production', 'production token clear must log production');
  assert.match(await environmentManager.getToken(environmentNeutralCredentials, { environment: 'test' }), /^test-token/);
  environmentManager.clear('worker-finished', 'test');
  assert.strictEqual(environmentStages.at(-1).environment, 'test', 'test token clear must log test');
  const firstProduction = await environmentManager.getToken(environmentNeutralCredentials, { environment: 'production' });
  const switchedTest = await environmentManager.getToken(environmentNeutralCredentials, { environment: 'test' });
  assert.match(firstProduction, /^production-token/);
  assert.match(switchedTest, /^test-token/);
  assert.notStrictEqual(firstProduction, switchedTest, 'tokens must never be reused across environments');
  assert(environmentStages.some(event => event.stage === 'token_cleared' && event.reason === 'environment-changed' && event.environment === 'production'));

  const parsed = parseTrackingJson(JSON.stringify(syntheticDetail), syntheticPin);
  assert.strictEqual(parsed.expectedDeliveryDate, '2026-06-02');
  assert.strictEqual(parsed.originalExpectedDeliveryDate, '2026-06-02');
  assert.strictEqual(parsed.revisedExpectedDeliveryDate, '2026-06-03');
  assert.strictEqual(parsed.events[0].eventTimeZone, 'EDT');
  assert.deepStrictEqual(parsed.deliveryOptions, [{ code: 'SYN', description: 'Synthetic option' }]);
  assert.strictEqual(parsed.reference2, 'SYNTHETIC-REF-2');
  assert.throws(() => parseTrackingJson({ ...syntheticDetail, pin: 'ZXCVBN120046' }, syntheticPin), /did not match/);
  const normalized = normalizeTrackingEvents(normalizedTrackingEvents(parsed));
  assert.strictEqual(normalized.expectedDeliveryDate, '2026-06-02');
  assert.strictEqual(normalized.firstAttemptDate, '2026-06-04');
  assert.strictEqual(normalized.actualDeliveryDate, '2026-06-05');
  assert.strictEqual(normalized.events.find(event => event.sourceCode === 'ATTEMPT').eventTimeZone, 'EDT');
  const archived = parseTrackingJson({ ...syntheticDetail, activeExists: false, archiveExists: true, significantEvents: [] }, syntheticPin);
  assert.strictEqual(archived.archiveState, 'archived');

  const exactCalls = [];
  const exactClient = new TrackingClient({
    baseUrl: 'http://127.0.0.1:1', tokenUrl: 'http://127.0.0.1:1/oauth2/token', allowMock: true,
    requestImpl: async options => {
      exactCalls.push(options);
      return options.method === 'POST'
        ? response(200, { token_type: 'Bearer', access_token: 'synthetic-exact-token', expires_in: 3600, scope: 'merchant' })
        : response(200, syntheticDetail);
    }
  });
  await exactClient.getTracking(syntheticPin, { clientId: ' current-id ', clientSecret: ' current-secret ', environment: 'test' }, { environment: 'test', allowMock: true });
  assert.strictEqual(exactCalls.length, 2);
  assert.strictEqual(exactCalls[1].method, 'GET');
  assert.strictEqual(exactCalls[1].accept, 'application/json');
  assert.strictEqual(exactCalls[1].body, undefined);
  assert.strictEqual(exactCalls[1].contentType, undefined);
  assert.strictEqual(exactCalls[1].bearerToken, 'synthetic-exact-token');
  assert.strictEqual(exactCalls[1].username, undefined);
  assert.deepStrictEqual(exactCalls[0].sensitiveValues, ['current-id', 'current-secret'], 'current credentials must be whitespace-normalized before use');

  const wrapperClient = new TrackingClient({
    baseUrl: 'http://127.0.0.1:1', tokenUrl: 'http://127.0.0.1:1/oauth2/token', allowMock: true,
    requestImpl: async options => options.method === 'POST'
      ? response(200, { token_type: 'Bearer', access_token: 'synthetic-wrapper-token', expires_in: 3600, scope: 'merchant' })
      : response(200, { trackingDetail: syntheticDetail })
  });
  await assert.rejects(
    () => wrapperClient.getTracking(syntheticPin, credentials, { environment: 'test', allowMock: true, includeSanitizedStructure: true }),
    error => {
      assert.strictEqual(error.diagnostic?.applicationCode, 'TRACKING_JSON_SCHEMA');
      assert(error.sanitizedStructure?.unrecognizedPaths.includes('$.trackingDetail'));
      assert(!JSON.stringify(error.sanitizedStructure).includes(syntheticPin));
      return true;
    }
  );

  let tokenRequestCount = 0;
  let resourceRequestCount = 0;
  const refreshClient = new TrackingClient({
    baseUrl: 'http://127.0.0.1:1', tokenUrl: 'http://127.0.0.1:1/oauth2/token', allowMock: true,
    requestImpl: async options => {
      if (options.method === 'POST') { tokenRequestCount += 1; return response(200, { token_type: 'Bearer', access_token: `synthetic-refresh-${tokenRequestCount}`, expires_in: 3600, scope: 'merchant' }); }
      resourceRequestCount += 1;
      if (resourceRequestCount === 1) throw service401();
      return response(200, syntheticDetail);
    }
  });
  const refreshed = await refreshClient.getTracking(syntheticPin, credentials, { environment: 'test', allowMock: true });
  assert.strictEqual(refreshed.tokenRefreshed, true);
  assert.strictEqual(tokenRequestCount, 2);
  assert.strictEqual(resourceRequestCount, 2);

  tokenRequestCount = 0; resourceRequestCount = 0;
  const second401Client = new TrackingClient({
    baseUrl: 'http://127.0.0.1:1', tokenUrl: 'http://127.0.0.1:1/oauth2/token', allowMock: true,
    requestImpl: async options => {
      if (options.method === 'POST') { tokenRequestCount += 1; return response(200, { token_type: 'Bearer', access_token: `synthetic-stop-${tokenRequestCount}`, expires_in: 3600, scope: 'merchant' }); }
      resourceRequestCount += 1; throw service401();
    }
  });
  await assert.rejects(() => second401Client.getTracking(syntheticPin, credentials, { environment: 'test', allowMock: true }), error => error.diagnostic?.status === 401);
  assert.strictEqual(tokenRequestCount, 2);
  assert.strictEqual(resourceRequestCount, 2, 'a second 401 must stop without another refresh loop');

  const statuses = [400, 401, 403, 404, 409, 429, 500, 502, 503, 504];
  for (const status of statuses) {
    const diagnostic = parseCanadaPostError({ status, headers: new Headers({ 'content-type': 'application/json', 'retry-after': status === 429 ? '60' : '' }), body: JSON.stringify({ title: 'Synthetic', detail: status === 403 ? 'Missing Tracking product permission' : 'Synthetic failure', errors: [{ errorCode: `E${status}`, message: 'Synthetic failure' }] }), endpointFamily: 'developer-portal-tracking-v1', protocol: 'REST/JSON', diagnosticStage: 'resource', apiVersion: TRACKING_API_VERSION, scope: TRACKING_SCOPE });
    assert.strictEqual(diagnostic.status, status);
    if (status === 429) assert.strictEqual(diagnostic.retryAfterSeconds, 60);
    if (status === 504) { assert.strictEqual(diagnostic.category, 'gateway_timeout'); assert.strictEqual(diagnostic.message, 'Canada Post API gateway timed out (HTTP 504).'); }
    if ([502, 503].includes(status)) assert.strictEqual(diagnostic.category, 'transient_gateway');
  }
  const html504 = parseCanadaPostError({ status: 504, headers: new Headers({ 'content-type': 'text/html' }), body: '<html><title>Gateway</title></html>', endpointFamily: 'developer-portal-tracking-v1', protocol: 'REST/JSON' });
  assert.strictEqual(html504.message, 'Canada Post API gateway timed out (HTTP 504).');
  assert.strictEqual(html504.category, 'gateway_timeout');
  const slm504 = parseCanadaPostError({ status: 504, headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify({ errors: [{ errorCode: 'Server', message: 'Rejected by SLM Monitor' }] }), endpointFamily: 'developer-portal-tracking-v1', protocol: 'REST/JSON' });
  assert.strictEqual(slm504.category, 'slm_throttle');
  assert.match(slm504.message, /SLM Monitor.*at least 60 seconds/);

  const permission = parseCanadaPostError({ status: 403, headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify({ moreInformation: 'Application lacks Tracking product permission' }), diagnosticStage: 'resource' });
  assert.strictEqual(permission.category, 'product_permission');
  const scope = parseCanadaPostError({ status: 403, headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify({ error: 'insufficient_scope', error_description: 'merchant scope required' }), diagnosticStage: 'resource' });
  assert.strictEqual(scope.category, 'incorrect_scope');

  const estAuthentication = parseCanadaPostError({ status: 401, headers: new Headers({ 'content-type': 'application/xml' }), body: '', endpointFamily: 'est-desktop-history', protocol: 'Basic/XML', diagnosticStage: 'resource' });
  assert.strictEqual(estAuthentication.message, 'Canada Post rejected the saved website username or password. Re-enter your website credentials in Settings and try again.');
  const trackingAuthentication = parseCanadaPostError({ status: 401, headers: new Headers({ 'content-type': 'application/json' }), body: '', endpointFamily: 'developer-portal-tracking-v1', protocol: 'REST/JSON', diagnosticStage: 'resource' });
  assert.strictEqual(trackingAuthentication.message, 'Canada Post Tracking API rejected the Bearer [REDACTED] (HTTP 401).');

  const redirect = sanitizedRedirect('https://accounts.canadapost-postescanada.ca/account/login?token=private', new URL('https://api.canadapost-postescanada.ca/source'));
  const redirectDiagnostic = parseCanadaPostError({ status: 302, headers: new Headers({ location: 'redacted' }), body: '', endpointFamily: 'developer-portal-tracking-v1', protocol: 'REST/JSON', responseHostname: 'api.canadapost-postescanada.ca', redirect });
  assert.strictEqual(redirectDiagnostic.category, 'redirect');
  assert.deepStrictEqual(redirectDiagnostic.redirectDestination, { hostname: 'accounts.canadapost-postescanada.ca', pathname: '/account/login', appearsLogin: true });
  assert.ok(!JSON.stringify(redirectDiagnostic).includes('token=private'));

  const serializedSources = [
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'tracking-client.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'scripts', 'get-tracking.js'), 'utf8')
  ].join('\n');
  assert.ok(!serializedSources.includes('application/vnd.cpc.track-v2+xml'));
  assert.ok(!serializedSources.includes('Basic '));
  assert.ok(!serializedSources.includes('getLegacyTracking'));
  assert.ok(serializedSources.includes(TRACKING_MODE));
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSource, /trackingDiagnosticGateSatisfied/);
  assert.doesNotMatch(mainSource, /Step 2 is blocked until/,
    'Normal Step 2 must not depend on the removed one-shipment diagnostic controls');

  const secretDiagnostic = parseCanadaPostError({ status: 401, headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify({ error_description: `${credentials.clientId} ${credentials.clientSecret} synthetic-token-private` }), sensitiveValues: [credentials.clientId, credentials.clientSecret, 'synthetic-token-private'], diagnosticStage: 'token' });
  const safe = JSON.stringify(secretDiagnostic);
  assert.ok(!safe.includes(credentials.clientId));
  assert.ok(!safe.includes(credentials.clientSecret));
  assert.ok(!safe.includes('synthetic-token-private'));

  console.log('Current Developer Portal Tracking API OAuth/JSON tests passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
