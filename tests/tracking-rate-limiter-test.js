'use strict';

const assert = require('assert');
const {
  SAFE_TRACKING_REQUEST_INTERVAL_MS, DEFAULT_DELAY_MS, MIN_DELAY_MS, MAX_JITTER_MS,
  SLM_THROTTLE_MINIMUM_WAIT_MS, DEFAULT_TRANSIENT_RETRIES,
  normalizeDelayMs, parseRetryAfter, SequentialRateLimiter
} = require('../lib/tracking-rate-limiter');

function serviceError(status, category = '', retryAfterRaw = '') {
  const error = new Error(status ? `HTTP ${status}` : category);
  error.status = status;
  error.diagnostic = { status, category, retryAfterRaw };
  return error;
}

function fakeLimiter(options = {}) {
  let now = 1000;
  const waits = [];
  const events = [];
  const starts = [];
  const limiter = new SequentialRateLimiter({
    delayMs: SAFE_TRACKING_REQUEST_INTERVAL_MS,
    maxTransientRetries: options.maxTransientRetries,
    now: () => now,
    random: () => options.random ?? 0,
    sleep: async ms => { waits.push(ms); now += ms; },
    onEvent: event => events.push(event)
  });
  return { limiter, waits, events, starts, now: () => now, operation: fn => async context => { starts.push(now); return fn(context); } };
}

async function main() {
  assert.strictEqual(SAFE_TRACKING_REQUEST_INTERVAL_MS, 3100);
  assert.strictEqual(DEFAULT_DELAY_MS, 3100);
  assert.strictEqual(MIN_DELAY_MS, 3100);
  assert.strictEqual(DEFAULT_TRANSIENT_RETRIES, 2);
  assert.strictEqual(MAX_JITTER_MS, 100);
  assert.strictEqual(normalizeDelayMs(), 3100);
  assert.strictEqual(normalizeDelayMs('3100'), 3100);
  for (const invalid of [0, 500, 3099, -1, 3100.5, 'fast', 60001]) assert.throws(() => normalizeDelayMs(invalid));
  assert.strictEqual(parseRetryAfter('12', 0), 12000);
  assert.strictEqual(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', Date.parse('2026-01-01T00:00:00Z')), 60000);

  const spacing = fakeLimiter();
  await spacing.limiter.run(spacing.operation(async () => 'one'));
  await spacing.limiter.run(spacing.operation(async () => 'two'));
  await spacing.limiter.run(spacing.operation(async () => 'three'));
  assert.deepStrictEqual(spacing.starts, [1000, 4100, 7200]);
  assert(spacing.starts.slice(1).every((value, index) => value - spacing.starts[index] >= 3100));

  const jittered = fakeLimiter({ random: 0.999999 });
  await jittered.limiter.run(jittered.operation(async () => 'one'));
  await jittered.limiter.run(jittered.operation(async () => 'two'));
  assert.strictEqual(jittered.starts[1] - jittered.starts[0], 3200, 'jitter must only lengthen the interval');

  let calls = 0;
  const retry = fakeLimiter();
  await retry.limiter.run(retry.operation(async () => {
    calls += 1;
    if (calls < 3) throw serviceError(504, 'gateway_timeout');
    return 'ok';
  }));
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(retry.starts, [1000, 4100, 7200], 'retry starts must retain the 3.1-second floor');
  assert.deepStrictEqual(retry.waits, [1000, 2100, 2000, 1100], 'backoff and base pacing are both obeyed');
  assert.strictEqual(retry.events.filter(event => event.stage === 'tracking_backoff').length, 2);

  const timeout = fakeLimiter();
  let timeoutCalls = 0;
  await timeout.limiter.run(timeout.operation(async () => {
    timeoutCalls += 1;
    if (timeoutCalls === 1) throw serviceError(0, 'transport_timeout');
    return 'ok';
  }));
  assert.strictEqual(timeoutCalls, 2);
  assert(timeout.starts[1] - timeout.starts[0] >= 3100);
  assert.strictEqual(timeout.events.find(event => event.stage === 'tracking_backoff').retrySource, 'bounded_timeout_backoff');

  const throttle = fakeLimiter();
  let throttleCalls = 0;
  await throttle.limiter.run(throttle.operation(async () => {
    throttleCalls += 1;
    if (throttleCalls === 1) throw serviceError(504, 'slm_throttle');
    return 'ok';
  }));
  assert.strictEqual(throttleCalls, 2);
  assert(throttle.starts[1] - throttle.starts[0] >= SLM_THROTTLE_MINIMUM_WAIT_MS);
  const throttleEvent = throttle.events.find(event => event.stage === 'tracking_backoff');
  assert.strictEqual(throttleEvent.retrySource, 'slm_monitor_minimum_60_seconds');

  const terminalFailure = fakeLimiter();
  let terminalCalls = 0;
  await assert.rejects(() => terminalFailure.limiter.run(terminalFailure.operation(async () => {
    terminalCalls += 1;
    throw serviceError(503, 'transient_gateway');
  })), /HTTP 503/);
  assert.strictEqual(terminalCalls, 3, 'one initial request plus two documented retries');

  let active = 0;
  let peak = 0;
  const sequential = fakeLimiter();
  await Promise.all(Array.from({ length: 5 }, (_, index) => sequential.limiter.run(sequential.operation(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return index;
  }))));
  assert.strictEqual(peak, 1);

  const controller = new AbortController();
  let cancellationCalls = 0;
  let cancelNow = 1000;
  const cancelLimiter = new SequentialRateLimiter({
    delayMs: 3100,
    now: () => cancelNow,
    random: () => 0,
    sleep: async (_ms, signal) => await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
      controller.abort();
    })
  });
  await cancelLimiter.run(async () => { cancellationCalls += 1; return 'first'; }, { signal: controller.signal });
  await assert.rejects(() => cancelLimiter.run(async () => { cancellationCalls += 1; }, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.strictEqual(cancellationCalls, 1, 'cancel during pacing must not start another request');

  console.log('Safe sequential Tracking API pacing and retry tests passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
