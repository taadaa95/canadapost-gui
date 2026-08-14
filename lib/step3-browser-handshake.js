'use strict';

const crypto = require('crypto');
const http = require('http');

class BrowserHandshakeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BrowserHandshakeError';
    this.code = code;
    this.details = details;
  }
}

function targetIdentityHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20);
}

function normalizeCdpEndpoint(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch (_) { throw new BrowserHandshakeError('CDP_ENDPOINT_UNAVAILABLE', 'The current Electron debugging endpoint is invalid.'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password) {
    throw new BrowserHandshakeError('CDP_ENDPOINT_UNAVAILABLE', 'The Electron debugging endpoint must be an unauthenticated IPv4 loopback HTTP endpoint.');
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BrowserHandshakeError('CDP_ENDPOINT_UNAVAILABLE', 'The Electron debugging endpoint does not contain a valid runtime port.');
  }
  return `http://127.0.0.1:${port}`;
}

function probeCdpVersion(endpoint, timeoutMs = 1000) {
  const url = new URL('/json/version', `${normalizeCdpEndpoint(endpoint)}/`);
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk.slice(0, 32768); });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
        try {
          const value = JSON.parse(body);
          if (!value.webSocketDebuggerUrl) throw new Error('Missing browser WebSocket endpoint.');
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('CDP endpoint probe timed out.')));
    request.on('error', reject);
  });
}

async function waitForCdpEndpoint(endpoint, options = {}) {
  const normalized = normalizeCdpEndpoint(endpoint);
  const timeoutMs = Math.max(100, Number(options.timeoutMs || 5000));
  const intervalMs = Math.max(10, Number(options.intervalMs || 50));
  const probe = options.probe || probeCdpVersion;
  const sleep = options.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)));
  const startedAt = Date.now();
  let attempts = 0;
  let lastError;
  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      const version = await probe(normalized, Math.min(1000, timeoutMs));
      return { endpoint: normalized, attempts, browser: String(version.Browser || '') };
    } catch (error) {
      lastError = error;
      if (Date.now() - startedAt >= timeoutMs) break;
      await sleep(intervalMs);
    }
  }
  throw new BrowserHandshakeError(
    'CDP_ENDPOINT_UNAVAILABLE',
    'The current Electron debugging endpoint did not become ready.',
    { endpoint: normalized, attempts, cause: String(lastError?.message || '') }
  );
}

async function exactWebContentsTargetId(webContents) {
  if (!webContents) throw new BrowserHandshakeError('BROWSER_VIEW_NOT_CREATED', 'The Step 3 browser view was not created.');
  if (webContents.isDestroyed()) throw new BrowserHandshakeError('BROWSER_WEBCONTENTS_DESTROYED', 'The Step 3 browser webContents was destroyed before handoff.');
  const electronDebugger = webContents.debugger;
  if (!electronDebugger) throw new BrowserHandshakeError('TARGET_NOT_PUBLISHED', 'The Step 3 browser target debugger is unavailable.');
  let attachedHere = false;
  try {
    if (!electronDebugger.isAttached()) {
      electronDebugger.attach('1.3');
      attachedHere = true;
    }
    const result = await electronDebugger.sendCommand('Target.getTargetInfo');
    const targetInfo = result?.targetInfo;
    if (!targetInfo?.targetId || targetInfo.type !== 'page') {
      throw new BrowserHandshakeError('TARGET_NOT_PUBLISHED', 'Electron did not publish the Step 3 webContents as a top-level page target.');
    }
    return String(targetInfo.targetId);
  } catch (error) {
    if (error instanceof BrowserHandshakeError) throw error;
    throw new BrowserHandshakeError('TARGET_NOT_PUBLISHED', 'The Step 3 browser target identity could not be published.', { cause: String(error?.message || '') });
  } finally {
    if (attachedHere && electronDebugger.isAttached()) {
      try { electronDebugger.detach(); } catch (_) {}
    }
  }
}

async function publishBrowserTarget(options = {}) {
  const view = options.view;
  const webContents = view?.webContents;
  if (!view || !webContents) throw new BrowserHandshakeError('BROWSER_VIEW_NOT_CREATED', 'The Step 3 browser view was not created.');
  if (webContents.isDestroyed()) throw new BrowserHandshakeError('BROWSER_WEBCONTENTS_DESTROYED', 'The Step 3 browser webContents was destroyed before handoff.');
  const nonce = String(options.nonce || '');
  if (!nonce) throw new BrowserHandshakeError('TARGET_NOT_PUBLISHED', 'The Step 3 browser target nonce is missing.');
  const marker = await webContents.executeJavaScript('window.name', true).catch(() => '');
  if (marker !== nonce) throw new BrowserHandshakeError('TARGET_NOT_PUBLISHED', 'The Step 3 browser marker was not bound to the target.');
  const endpointState = await waitForCdpEndpoint(options.endpoint, options.endpointOptions);
  const targetId = await exactWebContentsTargetId(webContents);
  if (webContents.isDestroyed()) throw new BrowserHandshakeError('BROWSER_WEBCONTENTS_DESTROYED', 'The Step 3 browser webContents was destroyed during handoff.');
  return Object.freeze({
    version: 1,
    endpoint: endpointState.endpoint,
    targetId,
    targetIdHash: targetIdentityHash(targetId),
    targetNonce: nonce,
    webContentsId: webContents.id,
    webContentsIdentityHash: targetIdentityHash(`${webContents.id}:${nonce}`),
    endpointAttempts: endpointState.attempts,
    publishedAt: new Date().toISOString()
  });
}

module.exports = {
  BrowserHandshakeError,
  targetIdentityHash,
  normalizeCdpEndpoint,
  probeCdpVersion,
  waitForCdpEndpoint,
  exactWebContentsTargetId,
  publishBrowserTarget
};
