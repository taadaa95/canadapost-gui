'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const claimDb = require('../lib/claim-database');
const { createMockPortal } = require('../mock-portal/server');

(async () => {
  const root = path.resolve(__dirname, '..');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-step3-visible-dry-run-'));
  const dataDir = path.join(userData, 'data');
  const dbPath = path.join(userData, 'database', 'app.sqlite');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({ setupCompleted: true, rememberSettings: false, dryRunDefault: true })}\n`, { mode: 0o600 });
  const trackingNumber = '9900000000000001';
  fs.writeFileSync(path.join(dataDir, 'claims.csv'), [
    'Tracking PIN,Destination Postal Code,Expected Delivery Date,Original Delivery Standard Date,Actual Delivery Date,Reference #,Service Code,Status,Eligibility Reason',
    `${trackingNumber},K1A0B1,2026-07-15,2026-07-15,2026-07-18,SYNTHETIC-REFERENCE,DOM.EP,LATE CANDIDATE,Synthetic late delivery`
  ].join('\n') + '\n', { mode: 0o600 });
  const trackingRunId = claimDb.startRun(dbPath, 'tracking', { synthetic: true });
  claimDb.finishRun(dbPath, trackingRunId, 'complete', { total: 1, success: 1 }, { synthetic: true });

  const portal = createMockPortal({ defaultScenario: 'text-verification' });
  const origin = await portal.start();
  let application;
  try {
    application = await electron.launch({
      args: [root],
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CPCR_TEST_USER_DATA: userData,
        XDG_CONFIG_HOME: path.join(userData, 'xdg-config'),
        XDG_CACHE_HOME: path.join(userData, 'xdg-cache'),
        MOCK_PORTAL_ORIGIN: origin
      }
    });
    const window = await application.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.evaluate(() => {
      window.__step3Events = [];
      window.__step3Runs = [];
      window.cpApp.onEvent(payload => {
        if (payload?.stage === 'submit') window.__step3Events.push(payload.event);
      });
      window.cpApp.onRun(payload => window.__step3Runs.push(payload));
    });

    const hiddenStart = await window.evaluate(number => window.cpApp.runSubmit({
      webUsername: 'synthetic-user', webPassword: 'synthetic-password', rememberSettings: false,
      claimStreetNumber: '1', claimStreetName: 'Example Street', claimCity: 'Ottawa', claimProvince: 'ON',
      claimPostalCode: 'K1A0B1', claimContactName: 'Synthetic Operator', claimContactEmail: 'operator@example.invalid',
      dryRun: true, liveSubmissionConfirmed: false, canaryMode: true,
      selectedTrackingNumbers: [number], expectedClaimCount: 1, afterSubmitMs: 5000
    }), trackingNumber);
    assert.strictEqual(hiddenStart.ok, false, 'submission must not start while the browser slot cannot be displayed');
    assert.strictEqual(hiddenStart.code, 'BROWSER_VISIBILITY_REQUIRED');
    assert.strictEqual(portal.stats().requests, 0, 'visibility watchdog failure must occur before portal navigation');

    await window.evaluate(() => {
      window.activateTab('step3');
      document.getElementById('builtinBrowserSlot').scrollIntoView({ block: 'center' });
    });

    const started = await window.evaluate(number => window.cpApp.runSubmit({
      webUsername: 'synthetic-user',
      webPassword: 'synthetic-password',
      rememberSettings: false,
      claimStreetNumber: '1',
      claimStreetName: 'Example Street',
      claimCity: 'Ottawa',
      claimProvince: 'ON',
      claimPostalCode: 'K1A0B1',
      claimContactName: 'Synthetic Operator',
      claimContactEmail: 'operator@example.invalid',
      dryRun: true,
      liveSubmissionConfirmed: false,
      canaryMode: true,
      selectedTrackingNumbers: [number],
      expectedClaimCount: 1,
      afterSubmitMs: 5000
    }), trackingNumber);
    assert.strictEqual(started.ok, true, started.error || 'mock dry run did not start');

    try {
      await window.waitForFunction(() => window.__step3Events.some(event => event?.type === 'manual_verification_required'), null, { timeout: 60000 });
    } catch (_error) {
      const debug = await window.evaluate(async () => ({
        events: window.__step3Events,
        runs: window.__step3Runs,
        target: await window.cpApp.builtinBrowserTargetState()
      }));
      const embedded = await application.evaluate(({ webContents }) => webContents.getAllWebContents()
        .filter(contents => contents.getType() !== 'window')
        .map(contents => ({ type: contents.getType(), url: contents.getURL(), title: contents.getTitle() })));
      throw new Error(`Manual verification event timed out: ${JSON.stringify({ debug, embedded, portal: portal.stats() })}`);
    }
    const verificationDisplay = await window.evaluate(async () => ({
      state: await window.cpApp.builtinBrowserTargetState(),
      placeholderHidden: document.querySelector('#builtinBrowserSlot .browser-slot-placeholder').hidden,
      status: document.getElementById('builtinBrowserStatus').textContent,
      slot: document.getElementById('builtinBrowserSlot').getBoundingClientRect().toJSON()
    }));
    const targetState = verificationDisplay.state;
    assert.strictEqual(targetState.attached, true, 'manual verification target was not attached');
    assert.strictEqual(targetState.visible, true, 'manual verification target was not visible');
    assert(targetState.bounds.width > 0 && targetState.bounds.height > 0, 'manual verification target had empty bounds');
    assert.strictEqual(verificationDisplay.placeholderHidden, true, 'placeholder covered the visible native browser');
    assert.match(verificationDisplay.status, /Manual verification required|Browser ready|Loading Canada Post/);
    assert(verificationDisplay.slot.top < await window.evaluate(() => window.innerHeight));

    const mockPage = await application.evaluate(({ webContents }, expectedOrigin) => {
      const target = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(expectedOrigin));
      if (!target) return { found: false };
      const bounds = target.getOwnerBrowserWindow ? target.getOwnerBrowserWindow()?.getContentBounds?.() : null;
      return target.executeJavaScript(`({
        title: document.title,
        text: document.body.innerText,
        buttonVisible: Boolean(document.getElementById('complete_verification')?.getBoundingClientRect().height)
      })`, true).then(value => ({ found: true, ...value, ownerBounds: bounds }));
    }, origin);
    assert.strictEqual(mockPage.found, true);
    assert.match(mockPage.title, /Text verification/);
    assert.match(mockPage.text, /Verification code required/);
    assert.strictEqual(mockPage.buttonVisible, true, 'mock verification page was loaded but not visibly laid out');

    await application.evaluate(async ({ webContents }, expectedOrigin) => {
      const target = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(expectedOrigin));
      if (!target) throw new Error('Synthetic verification target disappeared.');
      await target.executeJavaScript("document.getElementById('complete_verification').click(); true", true);
    }, origin);

    await window.waitForFunction(() => window.__step3Events.some(event => event?.type === 'submit_complete'), null, { timeout: 90000 });
    const result = await window.evaluate(() => ({
      complete: window.__step3Events.find(event => event?.type === 'submit_complete'),
      claim: window.__step3Events.find(event => event?.type === 'claim_dry_run'),
      errors: window.__step3Events.filter(event => event?.type === 'error' || event?.type === 'claim_error'),
      runs: window.__step3Runs
    }));
    assert.strictEqual(result.complete.total, 1, JSON.stringify(result));
    assert.strictEqual(result.complete.dryRunReady, 1);
    assert.strictEqual(result.complete.succeeded, 0);
    assert.strictEqual(result.complete.failed, 0);
    assert.ok(result.claim, 'mock dry run did not stop at the sender/contact checkpoint');
    assert.strictEqual(result.errors.length, 0, JSON.stringify(result.errors));

    const stats = portal.stats();
    assert(stats.claimStages.receiver >= 1);
    assert(stats.claimStages.reference >= 1);
    assert(stats.claimStages.sender >= 1);
    assert.strictEqual(Number(stats.claimStages.review || 0), 0, 'dry run crossed into mock review');
    assert.strictEqual(stats.finalReviewVisits, 0, 'dry run reached mock final review');
    assert.strictEqual(stats.submittedClaims, 0, 'mock claim was submitted');

    const history = claimDb.listClaimHistory(dbPath, { status: 'dry_run_ready' });
    assert.strictEqual(history.length, 1);
    const diagnosticRoot = path.join(userData, 'logs', 'step3-runs');
    const latest = fs.readdirSync(diagnosticRoot).sort().at(-1);
    const runDirectory = path.join(diagnosticRoot, latest);
    const electronDiagnostics = fs.readFileSync(path.join(runDirectory, 'electron-browser.jsonl'), 'utf8');
    const timeline = fs.readFileSync(path.join(runDirectory, 'timeline.jsonl'), 'utf8');
    for (const expected of [
      'browser-visibility-measurement', 'browser-child-view-attached', 'worker-browser-display-ready',
      'manual-verification-detected', 'verification-browser-display-ready'
    ]) assert(electronDiagnostics.includes(expected), `missing visibility diagnostic ${expected}`);
    assert(timeline.includes('manual-verification-display-ready'));
    assert(timeline.includes('safety-barrier-reached'));
    const diagnosticText = `${electronDiagnostics}\n${timeline}`;
    for (const forbidden of ['synthetic-password', 'operator@example.invalid', 'Example Street']) {
      assert(!diagnosticText.includes(forbidden), `diagnostics exposed sensitive fixture value ${forbidden}`);
    }

    process.stdout.write('Step 3 visible mock verification and dry-run hard stop passed without review or submission.\n');
  } finally {
    if (application) await application.close().catch(() => {});
    await portal.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
