'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  BrowserHandshakeError,
  normalizeCdpEndpoint,
  waitForCdpEndpoint,
  publishBrowserTarget
} = require('../lib/step3-browser-handshake');
const { CdpTargetError, inspectPageTargets, waitForExactPageTarget } = require('../lib/cdp-page-target');

function mockPage(targetId, nonce, url = 'about:blank#canadapost-claim-runner-step3-target') {
  let closed = false;
  return {
    __targetId: targetId,
    url: () => url,
    isClosed: () => closed,
    closeForTest: () => { closed = true; },
    evaluate: async callback => callback.toString().includes('window.name') ? nonce : '',
    once: () => {}
  };
}

function mockBrowser(pages, extraTargets = []) {
  const context = {
    pages: () => pages,
    newCDPSession: async page => ({
      send: async command => {
        assert.strictEqual(command, 'Target.getTargetInfo');
        return { targetInfo: { targetId: page.__targetId, type: 'page', url: page.url() } };
      },
      detach: async () => {}
    })
  };
  return {
    contexts: () => [context],
    newBrowserCDPSession: async () => ({
      send: async command => {
        assert.strictEqual(command, 'Target.getTargets');
        return {
          targetInfos: [
            ...pages.map(page => ({ targetId: page.__targetId, type: 'page', url: page.url() })),
            ...extraTargets
          ]
        };
      },
      detach: async () => {}
    })
  };
}

(async () => {
  assert.strictEqual(normalizeCdpEndpoint('http://127.0.0.1:41476'), 'http://127.0.0.1:41476');
  assert.throws(() => normalizeCdpEndpoint('http://localhost:24001'), error => error.code === 'CDP_ENDPOINT_UNAVAILABLE');
  assert.throws(() => normalizeCdpEndpoint('https://127.0.0.1:41476'), error => error.code === 'CDP_ENDPOINT_UNAVAILABLE');

  let endpointAttempts = 0;
  const endpoint = await waitForCdpEndpoint('http://127.0.0.1:41476', {
    timeoutMs: 500,
    intervalMs: 1,
    sleep: async () => {},
    probe: async value => {
      endpointAttempts += 1;
      if (endpointAttempts < 3) throw new Error('creation delayed');
      assert.strictEqual(value, 'http://127.0.0.1:41476');
      return { Browser: 'Electron/test', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/test' };
    }
  });
  assert.strictEqual(endpoint.attempts, 3, 'endpoint wait must tolerate delayed browser creation');

  await assert.rejects(
    waitForCdpEndpoint('http://127.0.0.1:24001', {
      timeoutMs: 100,
      intervalMs: 25,
      probe: async () => { throw new Error('stale endpoint'); }
    }),
    error => error instanceof BrowserHandshakeError && error.code === 'CDP_ENDPOINT_UNAVAILABLE'
  );

  let debuggerAttached = false;
  const webContents = {
    id: 77,
    isDestroyed: () => false,
    executeJavaScript: async () => 'nonce-77',
    debugger: {
      isAttached: () => debuggerAttached,
      attach: () => { debuggerAttached = true; },
      detach: () => { debuggerAttached = false; },
      sendCommand: async command => {
        assert.strictEqual(command, 'Target.getTargetInfo');
        return { targetInfo: { targetId: 'EXACT-EMBEDDED-TARGET', type: 'page' } };
      }
    }
  };
  const publication = await publishBrowserTarget({
    view: { webContents }, endpoint: 'http://127.0.0.1:41476', nonce: 'nonce-77',
    endpointOptions: { probe: async () => ({ Browser: 'Electron/test', webSocketDebuggerUrl: 'ws://test' }) }
  });
  assert.strictEqual(publication.targetId, 'EXACT-EMBEDDED-TARGET');
  assert.strictEqual(publication.webContentsId, 77);
  assert.strictEqual(debuggerAttached, false, 'temporary debugger attachment must be released before worker connection');
  await assert.rejects(
    publishBrowserTarget({ view: { webContents: { ...webContents, isDestroyed: () => true } }, endpoint: publication.endpoint, nonce: 'nonce-77' }),
    error => error.code === 'BROWSER_WEBCONTENTS_DESTROYED'
  );
  await assert.rejects(
    publishBrowserTarget({ endpoint: publication.endpoint, nonce: 'nonce-77' }),
    error => error.code === 'BROWSER_VIEW_NOT_CREATED'
  );

  const nonce = 'exact-nonce';
  const embedded = mockPage('EMBEDDED-TARGET', nonce);
  const appPage = mockPage('MAIN-APPLICATION', '');
  const otherRenderer = mockPage('OTHER-RENDERER', '');
  const browser = mockBrowser([appPage, embedded, otherRenderer], [
    { targetId: 'RECAPTCHA-FRAME', type: 'iframe', url: 'https://recaptcha.example.invalid/' },
    { targetId: 'ANALYTICS-FRAME', type: 'iframe', url: 'https://canadapost.demdex.net/' },
    { targetId: 'WORKER-1', type: 'worker', url: 'https://example.invalid/worker.js' }
  ]);
  const inventory = await inspectPageTargets(browser, 'EMBEDDED-TARGET', nonce);
  assert.strictEqual(inventory.targetCount, 6);
  assert.strictEqual(inventory.pageTargetCount, 3);
  assert.strictEqual(inventory.exactMatchCount, 1);
  assert.strictEqual(inventory.matches[0], embedded, 'Canada Post-like iframe targets must never be selected');
  assert(inventory.candidates.some(item => item.reason === 'target-id-mismatch'));
  assert(inventory.candidates.every(item => !Object.prototype.hasOwnProperty.call(item, 'targetId')), 'safe inventory must hash target IDs');

  const selected = await waitForExactPageTarget(browser, { targetId: 'EMBEDDED-TARGET', targetNonce: nonce, timeoutMs: 200 });
  assert.strictEqual(selected.page, embedded);
  assert.strictEqual(embedded.url().startsWith('about:blank#'), true, 'deterministic target may begin at the internal marker');

  let delayedInspections = 0;
  const delayed = await waitForExactPageTarget(browser, {
    targetId: 'EMBEDDED-TARGET', targetNonce: nonce, timeoutMs: 500, intervalMs: 1, sleep: async () => {},
    inspect: async () => {
      delayedInspections += 1;
      if (delayedInspections < 3) return { targetCount: 2, pageTargetCount: 1, typeCounts: { page: 1 }, publishedMatchCount: 0, exactMatchCount: 0, candidates: [], matches: [] };
      return inventory;
    }
  });
  assert.strictEqual(delayed.attempt, 3, 'worker target wait must begin before delayed publication and attach after readiness');

  await assert.rejects(
    waitForExactPageTarget(browser, {
      targetId: 'MISSING', targetNonce: nonce, timeoutMs: 100, intervalMs: 25
    }),
    error => error instanceof CdpTargetError && error.code === 'TARGET_NOT_FOUND'
  );
  await assert.rejects(
    waitForExactPageTarget(browser, { targetId: '', targetNonce: '' }),
    error => error instanceof CdpTargetError && error.code === 'TARGET_NOT_PUBLISHED'
  );
  await assert.rejects(
    waitForExactPageTarget(browser, {
      targetId: 'EMBEDDED-TARGET', targetNonce: 'wrong-nonce', timeoutMs: 100, intervalMs: 25
    }),
    error => error instanceof CdpTargetError && error.code === 'TARGET_NOT_PUBLISHED'
  );
  await assert.rejects(
    waitForExactPageTarget(browser, {
      targetId: 'DUPLICATE', targetNonce: nonce, timeoutMs: 100,
      inspect: async () => ({ targetCount: 2, pageTargetCount: 2, typeCounts: { page: 2 }, publishedMatchCount: 2, exactMatchCount: 2, candidates: [], matches: [embedded, embedded] })
    }),
    error => error.code === 'MULTIPLE_MATCHING_TARGETS'
  );
  const closed = mockPage('CLOSED', nonce);
  closed.closeForTest();
  await assert.rejects(
    waitForExactPageTarget(browser, {
      targetId: 'CLOSED', targetNonce: nonce, timeoutMs: 100,
      inspect: async () => ({ targetCount: 1, pageTargetCount: 1, typeCounts: { page: 1 }, publishedMatchCount: 1, exactMatchCount: 1, candidates: [], matches: [closed] })
    }),
    error => error.code === 'TARGET_CLOSED_DURING_CONNECTION'
  );

  const root = path.resolve(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const submitSource = fs.readFileSync(path.join(root, 'scripts', 'submit-claims.js'), 'utf8');
  assert.match(mainSource, /await prepareBuiltinBrowserForWorker\(\{ reason: 'submission' \}\)[\s\S]*spawnJsonProcess\('submitClaims'/,
    'main process must finish browser readiness before spawning the Step 3 worker');
  assert.match(mainSource, /ELECTRON_CDP_URL: browserHandshake\.endpoint/);
  assert.match(mainSource, /ELECTRON_TARGET_ID: browserHandshake\.targetId/);
  assert.match(mainSource, /webContents\.once\('destroyed',[\s\S]*sendStopSignalToChild/,
    'destroying the published webContents must stop an active submission worker');
  assert.doesNotMatch(mainSource, /readFileSync[^\n]*(?:launch|terminal|debug)[^\n]*(?:port|endpoint)/i,
    'runtime CDP endpoint discovery must not parse old launch or terminal logs');
  assert.doesNotMatch(submitSource, /canadaPostPages\.length === 1|contexts\(\).*pages\(\).*isCanadaPostUrl/s,
    'worker must not fall back to URL- or target-order-based page selection');

  process.stdout.write('Step 3 main/worker browser handshake and deterministic CDP target tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
