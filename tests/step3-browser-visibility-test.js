'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  calculateBrowserDisplay,
  boundsIntersectContent
} = require('../lib/browser-visibility');

const viewport = { width: 1280, height: 720 };
const visible = calculateBrowserDisplay({
  step3Active: true,
  browserEnabled: true,
  rawDomRect: { left: 80, top: 120, width: 1100, height: 650 },
  viewport
}, viewport);
assert.strictEqual(visible.displayable, true);
assert.deepStrictEqual(visible.appliedBounds, { x: 80, y: 120, width: 1100, height: 600 });
assert.strictEqual(boundsIntersectContent(visible.appliedBounds, viewport), true);

const offscreen = calculateBrowserDisplay({
  step3Active: true,
  browserEnabled: true,
  rawDomRect: { left: 80, top: 900, width: 1100, height: 650 },
  viewport
}, viewport);
assert.strictEqual(offscreen.displayable, false);
assert.strictEqual(offscreen.reason, 'slot-offscreen');

const inactive = calculateBrowserDisplay({
  step3Active: false,
  browserEnabled: true,
  rawDomRect: { left: 80, top: 120, width: 1100, height: 650 },
  viewport
}, viewport);
assert.strictEqual(inactive.displayable, false);
assert.strictEqual(inactive.reason, 'step3-inactive');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-browser-visibility-'));
  const acknowledgementPath = path.join(directory, 'browser-visibility.json');
  process.env.BROWSER_MODE = 'builtin';
  process.env.BROWSER_VISIBILITY_ACK_FILE = acknowledgementPath;
  process.env.ELECTRON_TARGET_WEB_CONTENTS_HASH = 'fixture-webcontents-hash';
  const { requireBuiltinBrowserVisibility } = require('../scripts/submit-claims');
  const originalWrite = process.stdout.write.bind(process.stdout);
  let requestId = '';
  process.stdout.write = chunk => {
    try {
      const event = JSON.parse(String(chunk));
      if (event.type === 'manual_verification_required') requestId = event.requestId;
    } catch (_) {}
    return true;
  };
  try {
    const readyPromise = requireBuiltinBrowserVisibility('text-verification', 'Synthetic verification');
    while (!requestId) await new Promise(resolve => setTimeout(resolve, 5));
    fs.writeFileSync(acknowledgementPath, JSON.stringify({
      requestId,
      visible: true,
      webContentsIdentityHash: 'fixture-webcontents-hash'
    }));
    const result = await readyPromise;
    assert.strictEqual(result.visible, true, 'manual verification must wait for a matching visible-view acknowledgement');

    requestId = '';
    const rejectedPromise = requireBuiltinBrowserVisibility('text-verification', 'Synthetic visibility failure');
    while (!requestId) await new Promise(resolve => setTimeout(resolve, 5));
    fs.writeFileSync(acknowledgementPath, JSON.stringify({
      requestId,
      visible: false,
      errorCode: 'BROWSER_VISIBILITY_REQUIRED',
      webContentsIdentityHash: 'fixture-webcontents-hash'
    }));
    await assert.rejects(rejectedPromise, error => error.code === 'BROWSER_VISIBILITY_REQUIRED');
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const root = path.resolve(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(mainSource, /prepareBuiltinBrowserForWorker\(\{ reason: 'submission' \}\)[\s\S]*requestBuiltinBrowserVisibility\([\s\S]*spawnJsonProcess\('submitClaims'/,
    'main must synchronize visible bounds after the target handshake and before worker spawn');
  assert.match(mainSource, /attachBuiltinBrowserView\(reason[\s\S]*addChildView\(view\)/,
    'positive visibility synchronization must attach the native child view');
  assert.doesNotMatch(mainSource, /if \(!builtinBrowserView \|\| !builtinBrowserAttached\) return \{ ok: true, hidden: true \}/,
    'a detached target must be reattachable by a later bounds update');
  assert.match(rendererSource, /step3-run-start[\s\S]*scrollIntoView: true/,
    'run start must force a fresh slot measurement and scroll the slot into view');
  assert.match(rendererSource, /browser-slot-placeholder[\s\S]*placeholder\.hidden = !visible/,
    'placeholder visibility must follow the native display state');
  assert.match(rendererSource, /Manual verification required/);

  process.stdout.write('Step 3 browser visibility geometry, acknowledgement, and lifecycle tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
