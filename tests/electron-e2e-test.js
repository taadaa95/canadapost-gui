'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { createMockPortal } = require('../mock-portal/server');

(async () => {
  const root = path.resolve(__dirname, '..');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-electron-e2e-'));
  const portal = createMockPortal();
  const origin = await portal.start();
  let application;
  try {
    const executablePath = String(process.env.CPCR_E2E_EXECUTABLE || '');
    application = await electron.launch({
      ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [root], cwd: root,
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
    assert.strictEqual(await window.evaluate(() => typeof globalThis.require), 'undefined');
    assert.strictEqual(await window.evaluate(() => typeof globalThis.process), 'undefined');
    await window.locator('#setupWizard:not(.hidden)').waitFor({ state: 'visible' });
    assert.strictEqual(await window.getByRole('button', { name: 'Finish Setup' }).isDisabled(), true, 'incomplete readiness must not be marked finished');
    await window.getByRole('button', { name: 'Continue later' }).click();
    await window.locator('#setupWizard').waitFor({ state: 'hidden' });
    const setupConfigPath = path.join(userData, 'config.json');
    const setupConfig = fs.existsSync(setupConfigPath) ? JSON.parse(fs.readFileSync(setupConfigPath, 'utf8')) : {};
    assert.notStrictEqual(setupConfig.setupCompleted, true, 'continue later must preserve resumable onboarding');
    const forgedCompletion = await window.evaluate(() => window.cpApp.saveConfig({ setupCompleted: true, setupSafetyAcknowledged: true }));
    assert.strictEqual(forgedCompletion.ok, false, 'renderer input must not bypass authoritative onboarding readiness gates');
    const configAfterForgedCompletion = fs.existsSync(setupConfigPath) ? JSON.parse(fs.readFileSync(setupConfigPath, 'utf8')) : {};
    assert.notStrictEqual(configAfterForgedCompletion.setupCompleted, true);
    const beforeStep3Target = await window.evaluate(() => window.cpApp.builtinBrowserTargetState());
    assert.strictEqual(beforeStep3Target.created, false, 'native browser must be created deliberately, not by unrelated startup');

    await window.evaluate(() => window.activateTab('step3'));
    await window.waitForTimeout(300);
    const offscreenBeforePrepare = await window.evaluate(() => window.cpApp.builtinBrowserTargetState());
    assert.strictEqual(offscreenBeforePrepare.created, false, 'an offscreen browser slot should not be the only creation trigger');
    const preparedTarget = await window.evaluate(() => window.cpApp.prepareBuiltinBrowser());
    assert.strictEqual(preparedTarget.ok, true);
    assert.ok(preparedTarget.targetIdHash);
    assert.ok(preparedTarget.webContentsIdentityHash);
    const preparedState = await window.evaluate(() => window.cpApp.builtinBrowserTargetState());
    assert.strictEqual(preparedState.created, true);
    assert.strictEqual(preparedState.destroyed, false);
    assert.strictEqual(preparedState.attached, false, 'offscreen preparation must not overlay unrelated UI');
    assert.strictEqual(await window.locator('#builtinBrowserSlot .browser-slot-placeholder').isVisible(), true);
    assert.strictEqual(preparedState.targetIdHash, preparedTarget.targetIdHash);
    const rendererTargetCount = await application.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents => contents.getType() === 'window' || contents.getType() === 'webview').length);
    assert(rendererTargetCount >= 2, 'test must include multiple Electron renderer targets');
    const renderCandidates = async count => {
      await window.evaluate(candidateCount => window.renderClaimQueue(Array.from({ length: candidateCount }, (_, index) => ({
        recordId: index + 1,
        evidenceHash: String(index + 1).padStart(64, '0'),
        trackingNumber: `E2E${String(index).padStart(13, '0')}`, referenceNumber: `REFERENCE-${index}-${'x'.repeat(100)}`,
        serviceCode: 'DOM.EP', firstAttemptDate: '2026-07-20', deliveryDate: '2026-07-21', deadline: '2026-09-01',
        deadlineState: 'known_active', businessDaysRemaining: 24, eligibilityReason: `Synthetic ${'long-reason/'.repeat(30)}`
      }))), count);
    };
    for (const count of [0, 1, 19, 50]) {
      await renderCandidates(count);
      assert.strictEqual(await window.locator('#claimQueueList .claim-queue-row:not(.header)').count(), count);
    }
    await window.evaluate(() => {
      for (let index = 0; index < 500; index += 1) window.log(`Electron Step 3 ${index} ${'long-output-'.repeat(60)}`, '', 'step3');
    });

    const assertStep3Layout = async (width, height) => {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: size.width, height: size.height }), { width, height });
      await window.waitForTimeout(150);
      const layout = await window.evaluate(() => {
        const queue = document.getElementById('claimQueueList');
        const slot = document.getElementById('builtinBrowserSlot');
        const log = document.getElementById('step3Log');
        return {
          documentHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
          queueOverflowY: getComputedStyle(queue).overflowY, queueScrollable: queue.scrollHeight > queue.clientHeight,
          browserHeight: slot.clientHeight, browserOverflow: getComputedStyle(slot).overflow,
          logOverflowY: getComputedStyle(log).overflowY, logScrollable: log.scrollHeight > log.clientHeight,
          inactiveHidden: [...document.querySelectorAll('.tab-panel:not(.active)')].every(element => getComputedStyle(element).display === 'none')
        };
      });
      assert(layout.documentHeight > layout.viewportHeight, `${width}x${height} should use page-level Step 3 scrolling`);
      assert(layout.documentWidth <= layout.viewportWidth + 1, `${width}x${height} developed horizontal overflow`);
      assert.strictEqual(layout.queueOverflowY, 'auto');
      assert.strictEqual(layout.queueScrollable, true);
      assert(layout.browserHeight >= 650);
      assert.strictEqual(layout.browserOverflow, 'hidden');
      assert.strictEqual(layout.logOverflowY, 'auto');
      assert.strictEqual(layout.logScrollable, true);
      assert.strictEqual(layout.inactiveHidden, true);
      return layout;
    };

    for (const viewport of [{ width: 980, height: 680 }, { width: 1280, height: 720 }, { width: 1600, height: 1000 }]) await assertStep3Layout(viewport.width, viewport.height);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await window.waitForTimeout(150);
    const maximized = await window.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));
    await assertStep3Layout(maximized.width, maximized.height);

    await window.evaluate(() => document.getElementById('builtinBrowserSlot').scrollIntoView({ block: 'center' }));
    await window.waitForTimeout(200);
    const visibleBounds = await window.evaluate(() => window.builtinBrowserBounds());
    assert(visibleBounds && visibleBounds.height > 0 && visibleBounds.y >= 0);
    assert(visibleBounds.y + visibleBounds.height <= await window.evaluate(() => window.innerHeight));
    const browserResult = await window.evaluate(() => window.synchronizeBuiltinBrowserVisibility({ reason: 'e2e-visible-slot', force: true, requireVisible: true }));
    assert.strictEqual(browserResult.ok, true);
    assert.strictEqual(browserResult.visible, true);
    assert.strictEqual(browserResult.attached, true);
    assert(browserResult.bounds.width > 0 && browserResult.bounds.height > 0);
    assert(browserResult.childViewIndex >= 0, 'native view must be an attached child above the renderer');
    assert.strictEqual(browserResult.targetIdHash, preparedTarget.targetIdHash, 'scrolling into view must preserve target identity');
    assert.strictEqual(await window.locator('#builtinBrowserSlot .browser-slot-placeholder').isHidden(), true, 'positive visible bounds must hide the placeholder');
    const beforeTall = await window.evaluate(() => document.documentElement.scrollHeight);
    await application.evaluate(async ({ webContents }) => {
      const embedded = webContents.getAllWebContents().find(contents => contents.getType() !== 'window');
      if (embedded) await embedded.executeJavaScript("document.body.style.minHeight='9000px'; document.body.append(document.createTextNode('synthetic tall mock page'));", true);
    });
    await window.waitForTimeout(100);
    assert.strictEqual(await window.evaluate(() => document.documentElement.scrollHeight), beforeTall, 'tall embedded document changed host layout');

    await window.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '1800px';
      document.body.appendChild(spacer);
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await window.waitForTimeout(200);
    assert.strictEqual(await window.evaluate(() => window.builtinBrowserBounds()), null);
    const hiddenState = await window.evaluate(() => window.cpApp.builtinBrowserTargetState());
    assert.strictEqual(hiddenState.attached, false);
    assert.strictEqual(hiddenState.visible, false);
    assert.strictEqual(hiddenState.targetIdHash, preparedTarget.targetIdHash, 'offscreen hiding must not destroy target identity');
    assert.strictEqual(await window.locator('#builtinBrowserSlot .browser-slot-placeholder').isVisible(), true, 'offscreen native view must restore the placeholder');

    const restoredState = await window.evaluate(async () => {
      document.getElementById('builtinBrowserSlot').scrollIntoView({ block: 'center' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return window.synchronizeBuiltinBrowserVisibility({ reason: 'e2e-restored-onscreen', force: true, requireVisible: true });
    });
    assert.strictEqual(restoredState.visible, true, 'scrolling the slot onscreen must reattach the detached view');
    assert.strictEqual(restoredState.targetIdHash, preparedTarget.targetIdHash);

    await window.evaluate(() => {
      window.activateTab('historyTab');
      window.__e2eHistory = Array.from({ length: 500 }, (_, index) => ({ trackingNumber: `H${index}${'9'.repeat(index === 499 ? 160 : 0)}`, attemptedAt: new Date().toISOString(), status: 'rejected', confirmationNumber: '', message: 'Long outcome '.repeat(40) }));
      window.renderHistory(window.__e2eHistory);
    });
    const assertHistoryLayout = async (width, height) => {
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: size.width, height: size.height }), { width, height });
      await window.waitForTimeout(100);
      const history = await window.evaluate(() => {
        if (document.querySelectorAll('#historyList .history-row:not(.head)').length !== 500) window.renderHistory(window.__e2eHistory);
        const list = document.getElementById('historyList');
        const head = list.querySelector('.history-row.head');
        list.scrollTop = 500;
        return {
          documentHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
          height: list.clientHeight, maxHeight: Math.min(window.innerHeight * 0.6, 640),
          scrollable: list.scrollHeight > list.clientHeight,
          overflowX: getComputedStyle(list).overflowX, overflowY: getComputedStyle(list).overflowY,
          sticky: getComputedStyle(head).position,
          stickyOffset: Math.abs(head.getBoundingClientRect().top - list.getBoundingClientRect().top),
          clearVisible: document.getElementById('clearHistoryFilters').getBoundingClientRect().height > 0,
          hasBadge: Boolean(document.getElementById('reconciliationBadge'))
        };
      });
      assert(history.documentHeight > history.viewportHeight);
      assert(history.documentWidth <= history.viewportWidth + 1);
      assert(history.height >= 258 && history.height <= history.maxHeight + 2);
      assert.strictEqual(history.scrollable, true);
      assert.strictEqual(history.overflowX, 'auto');
      assert.strictEqual(history.overflowY, 'auto');
      assert.strictEqual(history.sticky, 'sticky');
      assert(history.stickyOffset <= 2);
      assert.strictEqual(history.clearVisible, true);
      assert.strictEqual(history.hasBadge, false);
    };
    for (const viewport of [{ width: 980, height: 680 }, { width: 1280, height: 720 }, { width: 1600, height: 1000 }, { width: 2560, height: 1440 }]) await assertHistoryLayout(viewport.width, viewport.height);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await window.waitForTimeout(100);
    const maximizedHistory = await window.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));
    await assertHistoryLayout(maximizedHistory.width, maximizedHistory.height);
    const historyTargetState = await window.evaluate(() => window.cpApp.builtinBrowserTargetState());
    assert.strictEqual(historyTargetState.attached, false, 'switching tabs must detach the native view');
    assert.strictEqual(historyTargetState.targetIdHash, preparedTarget.targetIdHash, 'switching tabs must preserve the live target');
    await window.evaluate(() => window.activateTab('step3'));
    await window.evaluate(() => document.getElementById('builtinBrowserSlot').scrollIntoView({ block: 'center' }));
    await window.waitForTimeout(200);
    const returnedTarget = await window.evaluate(() => window.cpApp.prepareBuiltinBrowser());
    assert.strictEqual(returnedTarget.targetIdHash, preparedTarget.targetIdHash, 'returning to Step 3 must preserve the safe live target');
    const returnedDisplay = await window.evaluate(() => window.synchronizeBuiltinBrowserVisibility({ reason: 'e2e-tab-return', force: true, requireVisible: true }));
    assert.strictEqual(returnedDisplay.visible, true, 'returning to Step 3 must restore native visibility');

    const status = await window.evaluate(() => window.cpApp.browserSessionStatus());
    assert.strictEqual(status.ok, true);
    const cleared = await window.evaluate(() => window.cpApp.clearBrowserSession({ confirmed: true, resetProfile: true }));
    assert.strictEqual(cleared.ok, true);
    assert.strictEqual(cleared.claimHistoryPreserved, true);
    const destroyedTarget = await window.evaluate(() => window.cpApp.builtinBrowserTargetState());
    assert.strictEqual(destroyedTarget.created, false);
    const republishedTarget = await window.evaluate(() => window.cpApp.prepareBuiltinBrowser());
    assert.strictEqual(republishedTarget.ok, true);
    assert.notStrictEqual(republishedTarget.targetIdHash, preparedTarget.targetIdHash, 'recreated webContents must publish a new target identity');
    assert.ok(fs.existsSync(path.join(userData, 'database', 'app.sqlite')));
    process.stdout.write(`Electron spacious Step 3 and bounded History E2E passed; maximized ${maximized.width}x${maximized.height}.\n`);
  } finally {
    if (application) await application.close().catch(() => {});
    await portal.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
