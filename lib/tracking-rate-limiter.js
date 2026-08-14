'use strict';

const { setTimeout: sleepTimer } = require('timers/promises');

// Canada Post's legacy Tracking throttle group documents 20 transactions per
// rolling 60-second window. A 3.1-second start-to-start floor stays below it.
const SAFE_TRACKING_REQUEST_INTERVAL_MS = 3100;
const DEFAULT_DELAY_MS = SAFE_TRACKING_REQUEST_INTERVAL_MS;
const MIN_DELAY_MS = SAFE_TRACKING_REQUEST_INTERVAL_MS;
const MAX_DELAY_MS = 60000;
const MAX_JITTER_MS = 100;
const RETRY_JITTER_MAX_MS = 250;
const SLM_THROTTLE_MINIMUM_WAIT_MS = 60000;
// Two retries means at most three resource attempts for one shipment.
const DEFAULT_TRANSIENT_RETRIES = 2;

function normalizeDelayMs(value, fallback = DEFAULT_DELAY_MS) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < MIN_DELAY_MS || parsed > MAX_DELAY_MS) {
    throw new Error(`Tracking request interval must be an integer from ${MIN_DELAY_MS} to ${MAX_DELAY_MS} milliseconds.`);
  }
  return parsed;
}

function parseRetryAfter(value, nowMs = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Math.ceil(Number(text) * 1000));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.max(0, parsed - nowMs) : null;
}

function abortError() {
  const error = new Error('Tracking operation was cancelled.');
  error.name = 'AbortError';
  return error;
}

function transientKind(error) {
  const diagnostic = error?.diagnostic || {};
  if (diagnostic.category === 'slm_throttle') return 'slm_throttle';
  if (Number(diagnostic.status || error?.status || 0) === 429) return 'rate_limit';
  if ([502, 503, 504].includes(Number(diagnostic.status || error?.status || 0))) return 'gateway';
  if (diagnostic.category === 'transport_timeout' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT') return 'timeout';
  return '';
}

class SequentialRateLimiter {
  constructor(options = {}) {
    this.delayMs = normalizeDelayMs(options.delayMs);
    this.random = options.random || Math.random;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((ms, signal) => sleepTimer(ms, undefined, { signal }));
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.maxTransientRetries = Math.max(0, Math.min(4, Number(options.maxTransientRetries ?? DEFAULT_TRANSIENT_RETRIES)));
    this.lastStartedAt = 0;
    this.tail = Promise.resolve();
    this.inFlight = 0;
  }

  async wait(ms, signal, reason, metadata = {}) {
    if (signal?.aborted) throw abortError();
    this.onEvent({ stage: reason, delayMs: ms, ...metadata });
    try { await this.sleep(ms, signal); }
    catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw abortError();
      throw error;
    }
  }

  async waitForRequestStart(signal) {
    if (this.lastStartedAt) {
      const jitterMs = Math.max(0, Math.min(MAX_JITTER_MS, Math.floor(Number(this.random()) * (MAX_JITTER_MS + 1))));
      const remaining = (this.lastStartedAt + this.delayMs + jitterMs) - this.now();
      if (remaining > 0) await this.wait(remaining, signal, 'tracking_rate_limit_wait', { baseDelayMs: this.delayMs, jitterMs });
    }
    if (signal?.aborted) throw abortError();
    this.lastStartedAt = this.now();
  }

  retryDelay(error, attempt) {
    const diagnostic = error?.diagnostic || {};
    const kind = transientKind(error);
    const status = Number(diagnostic.status || error?.status || 0);
    const jitterMs = Math.max(0, Math.min(RETRY_JITTER_MAX_MS, Math.floor(Number(this.random()) * (RETRY_JITTER_MAX_MS + 1))));
    if (kind === 'slm_throttle') return { waitMs: SLM_THROTTLE_MINIMUM_WAIT_MS + jitterMs, retrySource: 'slm_monitor_minimum_60_seconds', status, kind, jitterMs };
    if (kind === 'rate_limit') {
      const parsed = parseRetryAfter(diagnostic.retryAfterRaw ?? error?.retryAfter, this.now());
      const base = parsed === null ? SLM_THROTTLE_MINIMUM_WAIT_MS : Math.max(parsed, SLM_THROTTLE_MINIMUM_WAIT_MS);
      return { waitMs: base + jitterMs, retrySource: parsed === null ? 'minimum_60_seconds' : 'retry_after_minimum_60_seconds', status, kind, jitterMs };
    }
    const base = Math.min(30000, 1000 * (2 ** attempt));
    return { waitMs: base + jitterMs, retrySource: kind === 'timeout' ? 'bounded_timeout_backoff' : 'bounded_exponential_backoff', status, kind, jitterMs };
  }

  async execute(operation, { signal } = {}) {
    let attempt = 0;
    for (;;) {
      await this.waitForRequestStart(signal);
      this.inFlight += 1;
      if (this.inFlight !== 1) throw new Error('Tracking rate limiter concurrency invariant failed.');
      try {
        return await operation({ attempt, signal });
      } catch (error) {
        const kind = transientKind(error);
        if (attempt >= this.maxTransientRetries || !kind) throw error;
        const retry = this.retryDelay(error, attempt);
        attempt += 1;
        await this.wait(retry.waitMs, signal, 'tracking_backoff', {
          status: retry.status,
          category: retry.kind,
          retryAttempt: attempt,
          maxRetries: this.maxTransientRetries,
          retrySource: retry.retrySource,
          jitterMs: retry.jitterMs
        });
      } finally {
        this.inFlight -= 1;
      }
    }
  }

  run(operation, options = {}) {
    const queued = this.tail.then(() => this.execute(operation, options));
    this.tail = queued.catch(() => {});
    return queued;
  }
}

module.exports = {
  SAFE_TRACKING_REQUEST_INTERVAL_MS,
  DEFAULT_DELAY_MS,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  MAX_JITTER_MS,
  RETRY_JITTER_MAX_MS,
  SLM_THROTTLE_MINIMUM_WAIT_MS,
  DEFAULT_TRANSIENT_RETRIES,
  normalizeDelayMs,
  parseRetryAfter,
  transientKind,
  SequentialRateLimiter
};
