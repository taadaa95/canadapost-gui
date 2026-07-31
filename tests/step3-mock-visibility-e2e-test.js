'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { _electron: electron } = require('playwright');
const claimDb = require('../lib/claim-database');
const { classifyEligibility } = require('../lib/policy-engine');
const { createMockPortal } = require('../mock-portal/server');

const TEST_TIMEOUT_MS = Number(process.env.CPCR_STEP3_E2E_TIMEOUT_MS || 360000);
let currentPhase = 'initialization';

function phase(name) {
  currentPhase = name;
  process.stdout.write(`[step3-e2e] ${name}\n`);
}

function withTimeout(promise, label, timeoutMs) {
  let timeout = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs} ms during ${currentPhase}.`)),
        timeoutMs
      );
    })
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function forceKillApplication(application) {
  const child = application?.process?.();
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch (_error) {
    // GitHub runner cleanup remains the final fallback.
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function removeDirectoryWithRetries(directory, attempts = 12) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      });
      return true;
    } catch (error) {
      if (attempt === attempts) {
        process.stderr.write(
          `[step3-e2e] temporary-directory cleanup warning after ${attempts} attempts: ${error.message}\n`
        );
        return false;
      }
      await delay(Math.min(1000, attempt * 150));
    }
  }
  return false;
}

const watchdog = setTimeout(() => {
  process.stderr.write(`[step3-e2e] global watchdog expired during ${currentPhase}.\n`);
  process.exit(1);
}, TEST_TIMEOUT_MS);

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
  const classificationInput = {
    trackingNumber,
    referenceNumber: 'SYNTHETIC-REFERENCE',
    destinationPostalCode: 'K1A0B1',
    destinationProvince: 'ON',
    serviceCode: 'DOM.EP',
    originalExpectedDeliveryDate: '2026-07-15',
    expectedDeliveryDate: '2026-07-15',
    firstAttemptDate: '2026-07-16',
    actualDeliveryDate: '2026-07-18',
    exclusionSignals: [],
    conflictCodes: [],
    normalizedEvents: []
  };
  const classification = classifyEligibility(classificationInput, {
    asOf: '2026-07-20',
    classificationTimestamp: '2026-07-20T12:00:00.000Z'
  });
  const classificationRecord = claimDb.recordClassification(dbPath, trackingNumber, classification, classificationInput, { runId: trackingRunId });
  claimDb.finishRun(dbPath, trackingRunId, 'complete', { total: 1, success: 1 }, { synthetic: true });
  const selectedClassificationRecords = [{ recordId: classificationRecord.id, evidenceHash: classification.evidenceHash }];

  const portal = createMockPortal({ defaultScenario: 'text-verification' });
  phase('starting mock portal');
  const origin = await withTimeout(portal.start(), 'Mock portal startup', 10000);
  let application;
  try {
    phase('launching Electron');
    application = await withTimeout(electron.launch({
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
    }), 'Electron launch', 60000);
    phase('waiting for first window');
    const window = await withTimeout(application.firstWindow(), 'First Electron window', 30000);
    phase('waiting for renderer DOM');
    await withTimeout(
      window.waitForLoadState('domcontentloaded'),
      'Renderer DOM content loaded',
      30000
    );
    phase('installing renderer event probes');
    await withTimeout(window.evaluate(() => {
      window.__step3Events = [];
      window.__step3Runs = [];
      window.cpApp.onEvent(payload => {
        if (payload?.stage === 'submit') window.__step3Events.push(payload.event);
      });
      window.cpApp.onRun(payload => window.__step3Runs.push(payload));
    }), 'Renderer event probe installation', 15000);

    phase('validating hidden browser rejection');
    const hiddenStart = await withTimeout(window.evaluate(selection => window.cpApp.runSubmit({
      webUsername: 'synthetic-user', webPassword: 'synthetic-password', rememberSettings: false,
      claimStreetNumber: '1', claimStreetName: 'Example Street', claimCity: 'Ottawa', claimProvince: 'ON',
      claimPostalCode: 'K1A0B1', claimContactName: 'Synthetic Operator', claimContactEmail: 'operator@example.invalid',
      dryRun: true, liveSubmissionConfirmed: false, canaryMode: true,
      selectedClassificationRecords: selection, expectedClaimCount: selection.length, afterSubmitMs: 5000
    }), selectedClassificationRecords), 'Hidden-slot submission rejection', 45000);
    assert.strictEqual(hiddenStart.ok, false, 'submission must not start while the browser slot cannot be displayed');
    assert.strictEqual(hiddenStart.code, 'BROWSER_VISIBILITY_REQUIRED');
    assert.strictEqual(portal.stats().requests, 0, 'visibility watchdog failure must occur before portal navigation');

    phase('activating Step 3 browser slot');
    await withTimeout(window.evaluate(() => {
      window.activateTab('step3');
      document.getElementById('builtinBrowserSlot').scrollIntoView({ block: 'center' });
    }), 'Step 3 browser-slot activation', 15000);

    phase('starting executable dry run');
    const started = await withTimeout(window.evaluate(selection => window.cpApp.runSubmit({
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
      selectedClassificationRecords: selection,
      expectedClaimCount: selection.length,
      afterSubmitMs: 5000
    }), selectedClassificationRecords), 'Executable dry-run start', 60000);
    assert.strictEqual(started.ok, true, started.error || 'mock dry run did not start');

    phase('waiting for manual verification event');
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
    phase('waiting for verification browser display readiness');
    await window.waitForFunction(async () => {
      const state = await window.cpApp.builtinBrowserTargetState();
      const placeholder = document.querySelector('#builtinBrowserSlot .browser-slot-placeholder');
      const status = document.getElementById('builtinBrowserStatus')?.textContent || '';
      const slot = document.getElementById('builtinBrowserSlot')?.getBoundingClientRect();
      return Boolean(
        state?.attached &&
        state?.visible &&
        state?.bounds?.width > 0 &&
        state?.bounds?.height > 0 &&
        placeholder?.hidden &&
        slot &&
        slot.top < window.innerHeight &&
        /Manual verification required|Browser ready|Loading Canada Post|Waiting for manual action|Canada Post loaded/.test(status)
      );
    }, null, { timeout: 30000, polling: 100 });

    phase('validating stable verification browser');
    const verificationDisplay = await withTimeout(window.evaluate(async () => ({
      state: await window.cpApp.builtinBrowserTargetState(),
      placeholderHidden: document.querySelector('#builtinBrowserSlot .browser-slot-placeholder').hidden,
      status: document.getElementById('builtinBrowserStatus').textContent,
      slot: document.getElementById('builtinBrowserSlot').getBoundingClientRect().toJSON()
    })), 'Verification browser display read', 15000);
    process.stdout.write(
      `[step3-e2e] verification display ${JSON.stringify(verificationDisplay)}\n`
    );
    const targetState = verificationDisplay.state;
    assert.strictEqual(targetState.attached, true, 'manual verification target was not attached');
    assert.strictEqual(targetState.visible, true, 'manual verification target was not visible');
    assert(targetState.bounds.width > 0 && targetState.bounds.height > 0, 'manual verification target had empty bounds');
    assert.strictEqual(verificationDisplay.placeholderHidden, true, 'placeholder covered the visible native browser');
    assert.match(
      verificationDisplay.status,
      /Manual verification required|Browser ready|Loading Canada Post|Waiting for manual action|Canada Post loaded/
    );
    assert(verificationDisplay.slot.top < await window.evaluate(() => window.innerHeight));

    phase('validating synthetic verification page contents');
    const mockPage = await withTimeout(application.evaluate(({ webContents }, expectedOrigin) => {
      const target = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(expectedOrigin));
      if (!target) return { found: false };
      const bounds = target.getOwnerBrowserWindow ? target.getOwnerBrowserWindow()?.getContentBounds?.() : null;
      return target.executeJavaScript(`({
        title: document.title,
        text: document.body.innerText,
        buttonVisible: Boolean(document.getElementById('complete_verification')?.getBoundingClientRect().height)
      })`, true).then(value => ({ found: true, ...value, ownerBounds: bounds }));
    }, origin), 'Synthetic verification page inspection', 30000);
    assert.strictEqual(mockPage.found, true);
    assert.match(mockPage.title, /Text verification/);
    assert.match(mockPage.text, /Verification code required/);
    assert.strictEqual(mockPage.buttonVisible, true, 'mock verification page was loaded but not visibly laid out');

    phase('completing synthetic verification');
    await withTimeout(application.evaluate(async ({ webContents }, expectedOrigin) => {
      const target = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(expectedOrigin));
      if (!target) throw new Error('Synthetic verification target disappeared.');
      await target.executeJavaScript("document.getElementById('complete_verification').click(); true", true);
    }, origin), 'Synthetic verification completion', 30000);

    phase('waiting for dry-run completion');
    await window.waitForFunction(() => window.__step3Events.some(event => event?.type === 'submit_complete'), null, { timeout: 90000 });
    await window.waitForFunction(() => window.__step3Runs.some(run => run?.status === 'complete'), null, { timeout: 30000 });
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

    phase('validating history and diagnostics');
    const history = claimDb.listClaimHistory(dbPath, { status: 'dry_run_ready' });
    assert.strictEqual(history.length, 1);
    const diagnosticRoot = path.join(userData, 'logs', 'step3-runs');
    const latest = fs.readdirSync(diagnosticRoot).sort().at(-1);
    const runDirectory = path.join(diagnosticRoot, latest);
    const electronDiagnostics = fs.readFileSync(path.join(runDirectory, 'electron-browser.jsonl'), 'utf8');
    const timeline = fs.readFileSync(path.join(runDirectory, 'timeline.jsonl'), 'utf8');
    for (const expected of [
      'browser-visibility-measurement', 'worker-browser-display-ready',
      'manual-verification-detected', 'verification-browser-display-ready'
    ]) assert(electronDiagnostics.includes(expected), `missing visibility diagnostic ${expected}`);
    // Windows may attach the native view before the active run diagnostic directory
    // is selected. The live state assertions above prove attachment; require either
    // the attachment transition or the subsequent visible-view diagnostic here.
    assert(
      electronDiagnostics.includes('browser-child-view-attached') || electronDiagnostics.includes('browser-view-visible'),
      'missing native browser attachment/visibility diagnostic'
    );
    assert(timeline.includes('manual-verification-display-ready'));
    assert(timeline.includes('safety-barrier-reached'));
    const diagnosticText = `${electronDiagnostics}\n${timeline}`;
    for (const forbidden of ['synthetic-password', 'operator@example.invalid', 'Example Street']) {
      assert(!diagnosticText.includes(forbidden), `diagnostics exposed sensitive fixture value ${forbidden}`);
    }

    phase('assertions complete');
    process.stdout.write('Step 3 visible mock verification and dry-run hard stop passed without review or submission.\n');
  } catch (error) {
    error.step3Phase = currentPhase;
    throw error;
  } finally {
    phase('cleanup');
    if (application) {
      try {
        await withTimeout(application.close(), 'Electron application close', 15000);
      } catch (error) {
        process.stderr.write(`[step3-e2e] graceful Electron close failed: ${error.message}\n`);
        forceKillApplication(application);
        await delay(1000);
      }
    }
    await portal.close({ timeoutMs: 5000 }).catch(error => {
      process.stderr.write(`[step3-e2e] mock portal cleanup warning: ${error.message}\n`);
    });
    await removeDirectoryWithRetries(userData);
  }
})().then(() => {
  clearTimeout(watchdog);
}).catch(error => {
  clearTimeout(watchdog);
  process.stderr.write(
    `[step3-e2e] failed during ${error.step3Phase || currentPhase}: ${error.stack || error.message}\n`
  );
  process.exit(1);
});
