'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAX_TEXT_LENGTH = 12000;
const MAX_DETAIL_DEPTH = 5;
const MAX_ARRAY_ITEMS = 100;
const MAX_PAGE_STATES = 80;
const MAX_TIMELINE_EVENTS = 25000;

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch (_) {}
}

function ensurePrivateFile(filePath) {
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function maskTracking(value) {
  const text = String(value || '').replace(/\s+/g, '');
  if (!text) return '';
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${'*'.repeat(Math.min(12, text.length - 4))}${text.slice(-4)}`;
}

function sanitizePath(value) {
  const text = String(value || '');
  const home = os.homedir();
  return home && text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function sanitizeUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!/^https?:$/.test(parsed.protocol)) return parsed.protocol || '';
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch (_) {
    const text = String(value || '');
    return text ? text.split(/[?#]/, 1)[0].slice(0, 500) : '';
  }
}

function normalizeSensitiveValues(values = []) {
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(value => value.length >= 3)
    .sort((a, b) => b.length - a.length))];
}

function redactText(value, sensitiveValues = []) {
  let text = String(value ?? '');
  for (const sensitive of sensitiveValues) {
    if (!sensitive) continue;
    text = text.split(sensitive).join('[REDACTED]');
  }

  text = text
    .replace(/(authorization|cookie|set-cookie|password|passwd|secret|token|api[-_ ]?key|session[-_ ]?id)(\s*[:=]\s*)[^\s,;}{]+/gi, '$1$2[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[PHONE]')
    .replace(/\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi, '[POSTAL]')
    .replace(/\b[A-Z]{2}\d{9}[A-Z]{2}\b/gi, match => maskTracking(match))
    .replace(/\b\d{11,20}\b/g, match => maskTracking(match));

  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…[TRUNCATED]` : text;
}

function sensitiveKey(key) {
  return /password|passwd|secret|token|cookie|authorization|username|email|phone|postal|street|address|contact|business|company|credential|session/i.test(String(key || ''));
}

function sanitizeDetails(value, sensitiveValues = [], depth = 0, seen = new WeakSet()) {
  if (depth > MAX_DETAIL_DEPTH) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value, sensitiveValues);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      code: redactText(value.code || '', sensitiveValues),
      message: redactText(value.message || '', sensitiveValues),
      stack: redactText(value.stack || '', sensitiveValues)
    };
  }
  if (Buffer.isBuffer(value)) return `[BUFFER:${value.length}]`;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitizeDetails(item, sensitiveValues, depth + 1, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      if (sensitiveKey(key)) {
        if (typeof item === 'boolean') output[key] = item;
        else if (typeof item === 'number') output[key] = item;
        else output[key] = item ? '[CONFIGURED]' : '';
      } else if (/url|uri|href/i.test(key) && typeof item === 'string') {
        output[key] = sanitizeUrl(item);
      } else if (/path|directory|file/i.test(key) && typeof item === 'string') {
        output[key] = redactText(sanitizePath(item), sensitiveValues);
      } else if (/tracking|pin/i.test(key) && typeof item === 'string') {
        output[key] = maskTracking(item);
      } else {
        output[key] = sanitizeDetails(item, sensitiveValues, depth + 1, seen);
      }
    }
    return output;
  }
  return redactText(String(value), sensitiveValues);
}

function safeFileName(value) {
  return String(value || 'event').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'event';
}

function classifyKnownPageIssue(text = '', url = '') {
  const combined = `${String(text || '')} ${String(url || '')}`;
  const rules = [
    ['canada-post-auth-config', /issuer\s+must use HTTPS|requireHttps/i],
    ['cookie-banner-sdk', /TenantFeatures|otBannerSdk\.js/i],
    ['canada-post-missing-oam-script', /oamSubmit\.js|setHiddenInput/i],
    ['electron-development-csp', /Electron Security Warning \(Insecure Content-Security-Policy\)/i],
    ['canada-post-angular-theme', /Could not find Angular Material core theme/i],
    ['canada-post-session-check-config', /sessionChecksEnabled.*sessionCheckIFrameUrl/i]
  ];
  const match = rules.find(([, pattern]) => pattern.test(combined));
  return match ? match[0] : '';
}


function pruneStep3DiagnosticRuns(rootDirectory, options = {}) {
  const root = path.resolve(rootDirectory || '');
  if (!rootDirectory || !fs.existsSync(root)) return { removed: [], retained: [] };
  const maxAgeDays = Math.max(1, Number(options.maxAgeDays || 30));
  const maxRuns = Math.max(1, Number(options.maxRuns || 20));
  const protectedPaths = new Set((options.protectedPaths || []).filter(Boolean).map(item => path.resolve(item)));
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^step3-/i.test(entry.name))
    .map(entry => {
      const directory = path.join(root, entry.name);
      try {
        const stat = fs.statSync(directory);
        return { directory, mtimeMs: stat.mtimeMs };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed = [];
  const retained = [];
  entries.forEach((entry, index) => {
    const protectedRun = protectedPaths.has(path.resolve(entry.directory));
    const expired = entry.mtimeMs < cutoff;
    const exceedsLimit = index >= maxRuns;
    if (!protectedRun && (expired || exceedsLimit)) {
      try {
        fs.rmSync(entry.directory, { recursive: true, force: true });
        removed.push(entry.directory);
        return;
      } catch (_) {}
    }
    retained.push(entry.directory);
  });
  return { removed, retained };
}

function describeEvent(event) {
  const details = event.details && Object.keys(event.details).length ? ` ${JSON.stringify(event.details)}` : '';
  const claim = event.claim?.trackingMasked ? ` claim=${event.claim.trackingMasked}` : '';
  return `[${event.at}] [+${event.elapsedMs}ms] [${event.level.toUpperCase()}] [${event.category}.${event.action}]${claim}${details}\n`;
}

class Step3Diagnostics {
  constructor(options = {}) {
    const runDirectory = options.runDirectory
      ? path.resolve(options.runDirectory)
      : path.resolve(options.rootDir || process.cwd(), `step3-${timestampForFile()}-${process.pid}`);

    ensurePrivateDirectory(runDirectory);
    this.directory = runDirectory;
    this.pageStateDirectory = path.join(runDirectory, 'page-states');
    ensurePrivateDirectory(this.pageStateDirectory);
    this.timelinePath = path.join(runDirectory, 'timeline.jsonl');
    this.humanLogPath = path.join(runDirectory, 'step3-detailed.log');
    this.summaryPath = path.join(runDirectory, 'summary.json');
    this.liveStatusPath = path.join(runDirectory, 'live-status.json');
    this.manifestPath = path.join(runDirectory, 'manifest.json');
    this.startedAt = Date.now();
    this.sequence = 0;
    this.pageStateCount = 0;
    this.eventCount = 0;
    this.droppedEvents = 0;
    this.currentClaim = null;
    this.sensitiveValues = [];
    this.operationStats = new Map();
    this.attachedPages = new WeakSet();
    this.levelCounts = { debug: 0, info: 0, warn: 0, error: 0 };
    this.categoryCounts = {};
    this.errors = [];
    this.warnings = [];
    this.siteIssues = [];
    this.lastState = 'initializing';
    this.finalized = false;

    this.timelineStream = fs.createWriteStream(this.timelinePath, { flags: 'a', mode: 0o600 });
    this.humanStream = fs.createWriteStream(this.humanLogPath, { flags: 'a', mode: 0o600 });
    this.timelineStream.on('error', () => {});
    this.humanStream.on('error', () => {});

    const manifest = {
      format: 'canadapost-step3-diagnostics',
      version: 1,
      createdAt: new Date(this.startedAt).toISOString(),
      appVersion: String(options.appVersion || ''),
      runId: options.runId || null,
      dryRun: Boolean(options.dryRun),
      browserMode: String(options.browserMode || ''),
      process: {
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        electron: process.versions.electron || '',
        chrome: process.versions.chrome || ''
      },
      privacy: {
        passwords: 'never recorded',
        cookies: 'never recorded',
        formValues: 'never recorded',
        trackingNumbers: 'masked',
        addressesAndContactDetails: 'redacted',
        urls: 'query strings and fragments removed',
        screenshots: 'not captured by this detailed logger; existing claim evidence remains separate'
      }
    };
    fs.writeFileSync(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(runDirectory, 'README.txt'), [
      'Canada Post Claim Runner — Step 3 detailed diagnostics',
      '',
      'timeline.jsonl: machine-readable chronological events',
      'step3-detailed.log: human-readable chronological events',
      'page-states/: redacted page structure and visible-control snapshots',
      'live-status.json: latest state if the process is interrupted',
      'summary.json: final timing, error, and operation summary',
      '',
      'Passwords, cookies, input values, full tracking numbers, addresses and contact details are not intentionally recorded.'
    ].join('\n') + '\n', { mode: 0o600 });

    this.record('info', 'diagnostics', 'started', {
      directory: runDirectory,
      appVersion: options.appVersion || '',
      runId: options.runId || null,
      dryRun: Boolean(options.dryRun),
      browserMode: options.browserMode || ''
    }, { critical: true });
  }

  setSensitiveValues(values = []) {
    this.sensitiveValues = normalizeSensitiveValues([...this.sensitiveValues, ...values]);
    this.record('debug', 'diagnostics', 'sensitive-values-configured', {
      count: this.sensitiveValues.length
    });
  }

  setClaim(claim = null) {
    if (!claim) {
      this.currentClaim = null;
      return;
    }
    this.setSensitiveValues([claim.trackingNumber, claim.referenceNumber, claim.postalCode]);
    this.currentClaim = {
      index: Number(claim.index || 0),
      total: Number(claim.total || 0),
      row: claim.row ?? '',
      trackingMasked: maskTracking(claim.trackingNumber)
    };
    this.record('info', 'claim', 'context-started', this.currentClaim, { critical: true });
  }

  clearClaim(result = {}) {
    if (this.currentClaim) this.record('info', 'claim', 'context-finished', result, { critical: true });
    this.currentClaim = null;
  }

  state(nextState, details = {}) {
    const previous = this.lastState;
    this.lastState = String(nextState || 'unknown');
    this.record('info', 'state', 'transition', { from: previous, to: this.lastState, ...details }, { critical: true });
  }

  record(level, category, action, details = {}, options = {}) {
    if (this.finalized) return null;
    if (this.eventCount >= MAX_TIMELINE_EVENTS) {
      this.droppedEvents += 1;
      return null;
    }

    const cleanLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
    const event = {
      seq: ++this.sequence,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      level: cleanLevel,
      category: safeFileName(category || 'general'),
      action: safeFileName(action || 'event'),
      claim: this.currentClaim ? { ...this.currentClaim } : null,
      details: sanitizeDetails(details, this.sensitiveValues)
    };

    this.eventCount += 1;
    this.levelCounts[cleanLevel] = (this.levelCounts[cleanLevel] || 0) + 1;
    const categoryKey = `${event.category}.${event.action}`;
    this.categoryCounts[categoryKey] = (this.categoryCounts[categoryKey] || 0) + 1;
    if (cleanLevel === 'error') this.errors.push({ at: event.at, category: categoryKey, details: event.details });
    if (cleanLevel === 'warn') this.warnings.push({ at: event.at, category: categoryKey, details: event.details });
    if (event.category === 'site') this.siteIssues.push({ at: event.at, category: categoryKey, details: event.details });

    const jsonLine = `${JSON.stringify(event)}\n`;
    this.timelineStream.write(jsonLine);
    this.humanStream.write(describeEvent(event));

    if (options.critical || cleanLevel === 'error' || this.eventCount % 25 === 0) this.writeLiveStatus();
    return event;
  }

  writeLiveStatus(extra = {}) {
    const status = {
      updatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      state: this.lastState,
      currentClaim: this.currentClaim,
      eventCount: this.eventCount,
      droppedEvents: this.droppedEvents,
      levelCounts: this.levelCounts,
      latestError: this.errors.at(-1) || null,
      latestWarning: this.warnings.at(-1) || null,
      ...sanitizeDetails(extra, this.sensitiveValues)
    };
    const temp = `${this.liveStatusPath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.liveStatusPath);
      ensurePrivateFile(this.liveStatusPath);
    } catch (_) {
      try { fs.rmSync(temp, { force: true }); } catch (_) {}
    }
  }

  async operation(name, details, fn) {
    const started = Date.now();
    const operationName = safeFileName(name || 'operation');
    this.record('debug', 'operation', 'start', { name: operationName, ...details });
    try {
      const result = await fn();
      const durationMs = Date.now() - started;
      this.addOperationMetric(operationName, durationMs, true);
      this.record(durationMs >= 5000 ? 'warn' : 'debug', 'operation', 'complete', {
        name: operationName,
        durationMs,
        slow: durationMs >= 5000
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      this.addOperationMetric(operationName, durationMs, false);
      this.record('error', 'operation', 'failed', { name: operationName, durationMs, error }, { critical: true });
      throw error;
    }
  }

  addOperationMetric(name, durationMs, ok) {
    const existing = this.operationStats.get(name) || { count: 0, success: 0, failure: 0, totalMs: 0, minMs: null, maxMs: 0 };
    existing.count += 1;
    existing[ok ? 'success' : 'failure'] += 1;
    existing.totalMs += durationMs;
    existing.minMs = existing.minMs === null ? durationMs : Math.min(existing.minMs, durationMs);
    existing.maxMs = Math.max(existing.maxMs, durationMs);
    this.operationStats.set(name, existing);
  }

  attachPage(page, label = 'page') {
    if (!page || this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    const pageLabel = safeFileName(label);
    this.record('info', 'browser', 'page-attached', { label: pageLabel, url: sanitizeUrl(page.url?.()) });

    page.on('framenavigated', frame => {
      this.record('info', 'browser', 'frame-navigated', {
        page: pageLabel,
        mainFrame: frame === page.mainFrame(),
        frameName: frame.name?.() || '',
        url: sanitizeUrl(frame.url?.())
      });
    });
    page.on('domcontentloaded', () => this.record('debug', 'browser', 'domcontentloaded', { page: pageLabel, url: sanitizeUrl(page.url?.()) }));
    page.on('load', () => this.record('debug', 'browser', 'load', { page: pageLabel, url: sanitizeUrl(page.url?.()) }));
    page.on('popup', popup => {
      this.record('info', 'browser', 'popup', { page: pageLabel, url: sanitizeUrl(popup.url?.()) });
      this.attachPage(popup, `${pageLabel}-popup`);
    });
    page.on('dialog', dialog => this.record('warn', 'browser', 'dialog', {
      page: pageLabel,
      type: dialog.type?.(),
      message: dialog.message?.()
    }));
    page.on('console', message => {
      const type = message.type?.() || 'log';
      if (!['warning', 'error', 'assert'].includes(type)) return;
      const text = message.text?.() || '';
      const location = message.location?.() || {};
      const knownIssue = classifyKnownPageIssue(text, location.url || '');
      if (knownIssue) {
        this.record('warn', 'site', 'known-console-issue', {
          page: pageLabel,
          issue: knownIssue,
          originalType: type,
          text,
          location
        });
        return;
      }
      this.record(type === 'error' ? 'error' : 'warn', 'browser-console', type, {
        page: pageLabel,
        text,
        location
      });
    });
    page.on('pageerror', error => {
      const knownIssue = classifyKnownPageIssue(error?.message || '', error?.stack || '');
      if (knownIssue) {
        this.record('warn', 'site', 'known-page-error', { page: pageLabel, issue: knownIssue, error });
        return;
      }
      this.record('error', 'browser', 'pageerror', { page: pageLabel, error }, { critical: true });
    });
    page.on('requestfailed', request => {
      const rawUrl = String(request.url?.() || '');
      const failureText = String(request.failure?.()?.errorText || request.failure?.()?.error || '');
      const telemetryNoise = /(?:google\.com\/(?:ccm|rmkt)|doubleclick\.net|facebook\.com\/tr|linkedin\.com\/wa|a\.run\.app\/events|recaptcha\/api2\/clr)/i.test(rawUrl)
        && /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/i.test(failureText);
      const knownIssue = classifyKnownPageIssue(failureText, rawUrl);
      if (knownIssue) {
        this.record('warn', 'site', 'known-request-failure', {
          page: pageLabel,
          issue: knownIssue,
          method: request.method?.(),
          resourceType: request.resourceType?.(),
          url: sanitizeUrl(rawUrl),
          failure: request.failure?.()
        });
        return;
      }
      this.record(telemetryNoise ? 'debug' : 'warn', 'network', telemetryNoise ? 'telemetry-request-aborted' : 'request-failed', {
        page: pageLabel,
        method: request.method?.(),
        resourceType: request.resourceType?.(),
        url: sanitizeUrl(rawUrl),
        failure: request.failure?.()
      });
    });
    page.on('response', response => {
      const status = response.status?.() || 0;
      if (status < 400) return;
      const request = response.request?.();
      const rawUrl = response.url?.() || '';
      const knownIssue = classifyKnownPageIssue(`${status} ${response.statusText?.() || ''}`, rawUrl);
      if (knownIssue) {
        this.record('warn', 'site', 'known-http-error', {
          page: pageLabel,
          issue: knownIssue,
          status,
          statusText: response.statusText?.(),
          method: request?.method?.(),
          resourceType: request?.resourceType?.(),
          url: sanitizeUrl(rawUrl)
        });
        return;
      }
      this.record(status >= 500 ? 'error' : 'warn', 'network', 'http-error', {
        page: pageLabel,
        status,
        statusText: response.statusText?.(),
        method: request?.method?.(),
        resourceType: request?.resourceType?.(),
        url: sanitizeUrl(rawUrl)
      });
    });
    page.on('crash', () => this.record('error', 'browser', 'crash', { page: pageLabel }, { critical: true }));
    page.on('close', () => this.record('warn', 'browser', 'close', { page: pageLabel }, { critical: true }));
  }

  async capturePageState(page, label, options = {}) {
    if (!page || this.pageStateCount >= MAX_PAGE_STATES) return '';
    const seq = ++this.pageStateCount;
    const safeLabel = safeFileName(label || 'page-state');
    const destination = path.join(this.pageStateDirectory, `${String(seq).padStart(3, '0')}-${safeLabel}.json`);
    const started = Date.now();

    const snapshot = {
      capturedAt: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      label: safeLabel,
      pageUrl: sanitizeUrl(page.url?.()),
      pageTitle: redactText(await page.title?.().catch(() => ''), this.sensitiveValues),
      frameCount: page.frames?.().length || 0,
      frames: []
    };

    for (const frame of page.frames?.() || []) {
      const frameSnapshot = await frame.evaluate(({ includeText, maxText }) => {
        const visible = element => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number.parseFloat(style.opacity || '1') > 0
            && rect.width > 1
            && rect.height > 1;
        };
        const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
        const labelFor = element => {
          const inputType = clean(element.getAttribute('type')).toLowerCase();
          const safeControlValue = element.tagName === 'INPUT' && /^(?:button|submit|reset)$/.test(inputType)
            ? element.value
            : '';
          return clean([
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.getAttribute('placeholder'),
            element.labels ? [...element.labels].map(item => item.innerText).join(' ') : '',
            element.innerText,
            element.textContent,
            safeControlValue
          ].filter(Boolean).join(' ')).slice(0, 240);
        };
        const controls = [...document.querySelectorAll('input, select, textarea, button, a, [role="button"], [role="link"], [role="combobox"]')]
          .filter(visible)
          .slice(0, 100)
          .map(element => ({
            tag: element.tagName.toLowerCase(),
            type: clean(element.getAttribute('type')).slice(0, 60),
            id: clean(element.id).slice(0, 100),
            name: clean(element.getAttribute('name')).slice(0, 100),
            role: clean(element.getAttribute('role')).slice(0, 60),
            label: labelFor(element),
            enabled: !element.disabled,
            readOnly: Boolean(element.readOnly),
            checked: typeof element.checked === 'boolean' ? element.checked : undefined,
            optionCount: element.tagName === 'SELECT' ? element.options.length : undefined,
            valuePresent: Boolean(element.value),
            valueLength: typeof element.value === 'string' ? element.value.length : undefined
          }));
        return {
          url: location.href,
          name: window.name || '',
          forms: document.forms.length,
          controls,
          visibleText: includeText ? clean(document.body?.innerText || '').slice(0, maxText) : ''
        };
      }, { includeText: options.includeText !== false, maxText: 8000 }).catch(error => ({ error: error.message }));
      snapshot.frames.push(frameSnapshot);
    }

    const sanitized = sanitizeDetails(snapshot, this.sensitiveValues);
    fs.writeFileSync(destination, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
    ensurePrivateFile(destination);
    this.record('info', 'page-state', 'captured', {
      label: safeLabel,
      file: path.relative(this.directory, destination),
      durationMs: Date.now() - started,
      frameCount: snapshot.frameCount
    });
    return destination;
  }

  locatorResult(name, details = {}) {
    const level = details.found === false && !details.expectedMissing ? 'warn' : 'debug';
    this.record(level, 'locator', details.found === false ? 'not-found' : 'found', { name, ...details });
  }

  async finalize(extra = {}) {
    if (this.finalized) return this.summaryPath;
    this.finalized = true;
    const endedAt = Date.now();
    const operations = [...this.operationStats.entries()].map(([name, stats]) => ({
      name,
      ...stats,
      averageMs: stats.count ? Math.round(stats.totalMs / stats.count) : 0
    })).sort((a, b) => b.maxMs - a.maxMs);

    const summary = sanitizeDetails({
      format: 'canadapost-step3-diagnostics-summary',
      version: 1,
      startedAt: new Date(this.startedAt).toISOString(),
      completedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - this.startedAt,
      finalState: this.lastState,
      eventCount: this.eventCount,
      droppedEvents: this.droppedEvents,
      pageStateCount: this.pageStateCount,
      levelCounts: this.levelCounts,
      automationErrorCount: this.errors.length,
      siteIssueCount: this.siteIssues.length,
      categoryCounts: this.categoryCounts,
      operations,
      slowestOperations: operations.slice(0, 20).map(item => ({ ...item })),
      errors: this.errors.slice(-100),
      warnings: this.warnings.slice(-100),
      siteIssues: this.siteIssues.slice(-100),
      host: {
        platform: process.platform,
        arch: process.arch,
        cpuCount: os.cpus().length,
        memoryTotalMb: Math.round(os.totalmem() / 1024 / 1024),
        memoryFreeMb: Math.round(os.freemem() / 1024 / 1024),
        hostnameHash: crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12)
      },
      ...extra
    }, this.sensitiveValues);

    fs.writeFileSync(this.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    ensurePrivateFile(this.summaryPath);
    this.writeLiveStatus({ completed: true, summaryPath: this.summaryPath });

    await Promise.all([
      new Promise(resolve => this.timelineStream.end(resolve)),
      new Promise(resolve => this.humanStream.end(resolve))
    ]);
    ensurePrivateFile(this.timelinePath);
    ensurePrivateFile(this.humanLogPath);
    return this.summaryPath;
  }
}

module.exports = {
  Step3Diagnostics,
  maskTracking,
  sanitizeUrl,
  sanitizePath,
  redactText,
  sanitizeDetails,
  pruneStep3DiagnosticRuns,
  classifyKnownPageIssue
};
