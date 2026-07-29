'use strict';

const assert = require('assert');
const { TrackingClient, SystemicCircuitBreaker, DEFAULT_RESOURCE_TIMEOUT_MS } = require('../lib/tracking-client');

const pin = 'SYNTHETIC000001';
const detail = {
  pin, activeExists: true, archiveExists: false, expectedDeliveryDate: '2026-06-03', serviceName: 'Xpresspost',
  signatureImageExists: false, suppressSignature: false,
  significantEvents: [{ eventIdentifier: '1442', eventDate: '2026-06-04', eventTime: '10:00:00', eventTimeZone: 'EDT', eventDescription: 'Delivered' }]
};
const credentials = { clientId: 'synthetic', clientSecret: 'synthetic-secret', environment: 'test' };
function response(status, body) { return { status, body: JSON.stringify(body), headers: new Headers({ 'content-type': 'application/json' }), responseHostname: '127.0.0.1' }; }
function timeout() { const error = new Error('The operation timed out.'); error.name = 'TimeoutError'; return error; }

async function main() {
  assert.strictEqual(DEFAULT_RESOURCE_TIMEOUT_MS, 45000);
  let tokenCalls = 0; let resourceCalls = 0; const waits = [];
  const retryClient = new TrackingClient({
    allowMock: true, baseUrl: 'http://127.0.0.1:1', tokenUrl: 'http://127.0.0.1:1/oauth2/token', random: () => 0,
    sleep: async ms => waits.push(ms),
    requestImpl: async options => {
      if (options.method === 'POST') { tokenCalls += 1; return response(200, { token_type: 'Bearer', access_token: 'timeout-token', expires_in: 3600, scope: 'merchant' }); }
      resourceCalls += 1;
      if (resourceCalls < 3) throw timeout();
      return response(200, detail);
    }
  });
  const succeeded = await retryClient.getTracking(pin, credentials, { environment: 'test', allowMock: true });
  assert.strictEqual(succeeded.detail.pin, pin);
  assert.strictEqual(tokenCalls, 1, 'timeouts must not refresh OAuth tokens');
  assert.strictEqual(resourceCalls, 3);
  assert.deepStrictEqual(waits, [1000, 2000]);

  tokenCalls = 0; resourceCalls = 0;
  const exhausted = new TrackingClient({
    allowMock: true, baseUrl: 'http://127.0.0.1:1', tokenUrl: 'http://127.0.0.1:1/oauth2/token', random: () => 0, sleep: async () => {},
    requestImpl: async options => {
      if (options.method === 'POST') { tokenCalls += 1; return response(200, { token_type: 'Bearer', access_token: 'exhausted-token', expires_in: 3600, scope: 'merchant' }); }
      resourceCalls += 1; throw timeout();
    }
  });
  await assert.rejects(() => exhausted.getTracking(pin, credentials, { environment: 'test', allowMock: true }), error => error.diagnostic?.category === 'transport_timeout' && error.diagnostic?.attempts === 3);
  assert.strictEqual(tokenCalls, 1);
  assert.strictEqual(resourceCalls, 3);

  const controller = new AbortController();
  resourceCalls = 0;
  const cancelled = new TrackingClient({
    allowMock: true, baseUrl: 'http://127.0.0.1:1', tokenUrl: 'http://127.0.0.1:1/oauth2/token', random: () => 0,
    sleep: async (_ms, signal) => {
      controller.abort();
      const error = new Error('cancelled'); error.name = 'AbortError';
      if (signal.aborted) throw error;
    },
    requestImpl: async options => {
      if (options.method === 'POST') return response(200, { token_type: 'Bearer', access_token: 'cancel-token', expires_in: 3600, scope: 'merchant' });
      resourceCalls += 1;
      throw timeout();
    }
  });
  await assert.rejects(() => cancelled.getTracking(pin, credentials, { environment: 'test', allowMock: true, signal: controller.signal }), error => error.name === 'AbortError');
  assert.strictEqual(resourceCalls, 1);

  const breaker = new SystemicCircuitBreaker({ threshold: 3 });
  for (let index = 0; index < 3; index += 1) {
    try { await exhausted.getTracking(pin, credentials, { environment: 'test', allowMock: true }); }
    catch (error) {
      const state = breaker.record(error);
      assert.strictEqual(state.opened, index === 2);
    }
  }
  assert.strictEqual(breaker.diagnostic.category, 'transport_timeout');
  console.log('Tracking resource timeout retry, cancellation, and transient-circuit tests passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
