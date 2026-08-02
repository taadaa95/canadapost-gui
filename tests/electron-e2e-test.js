'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { createMockPortal } = require('../mock-portal/server');
const { loadLocale } = require('../lib/i18n');

(async () => {
  const root = path.resolve(__dirname, '..');
  const frenchMessages = loadLocale('fr-CA', root).messages;
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

    await window.evaluate(() => window.activateTab('step1'));
    await window.locator('#localeSelect').selectOption('fr-CA');
    await window.locator('html[lang="fr-CA"]').waitFor();
    const localizationMismatches = await window.evaluate(messages => {
      const mismatches = [];
      document.querySelectorAll('[data-i18n]').forEach(element => {
        if (element.dataset.i18nCurrent) return;
        if (element.textContent !== messages[element.dataset.i18n]) mismatches.push(`${element.dataset.i18n}: ${element.textContent}`);
      });
      for (const attribute of ['placeholder', 'aria-label', 'title', 'alt']) {
        document.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
          const key = element.getAttribute(`data-i18n-${attribute}`);
          if (element.getAttribute(attribute) !== messages[key]) mismatches.push(`${key}/${attribute}: ${element.getAttribute(attribute)}`);
        });
      }
      return mismatches;
    }, frenchMessages);
    assert.deepStrictEqual(localizationMismatches, [], 'all declarative text, placeholders, tooltips, and accessibility labels must switch to French');
    await window.evaluate(() => Promise.all([window.applyLocale('en-CA'), window.applyLocale('fr-CA')]));
    assert.strictEqual(await window.locator('html').getAttribute('lang'), 'fr-CA', 'the newest asynchronous locale request must win');
    const assertFrenchKeys = async keys => {
      const mismatches = await window.evaluate(({ expected, localeMessages }) => expected.flatMap(key => {
        const element = document.querySelector(`[data-i18n="${key}"]`);
        return !element || element.textContent !== localeMessages[key] ? [`${key}: ${element?.textContent || '<missing>'}`] : [];
      }), { expected: keys, localeMessages: frenchMessages });
      assert.deepStrictEqual(mismatches, []);
    };
    await assertFrenchKeys([
      'step1.title', 'step1.createsTrackingCsv', 'step1.fromDate', 'step1.toDate', 'step1.run', 'action.forceStop',
      'step1.statusTitle', 'runStatus.idle', 'step1.ordersFound', 'step1.shipmentsImported', 'step1.workgroups',
      'step1.warningsInspect', 'step1.progress', 'status.waiting', 'step1.liveLog'
    ]);
    assert.strictEqual(await window.locator('#step1WarningsCard').getAttribute('aria-label'), frenchMessages['step1.warningsAria']);
    await window.evaluate(() => window.activateTab('step2'));
    await assertFrenchKeys([
      'step2.title', 'step2.readsTrackingCsv', 'step2.freshRun', 'step2.candidateExplanation', 'step2.run',
      'step2.testConnection', 'step2.exportStructure', 'step2.discardIncomplete', 'action.forceStop', 'step2.statusTitle',
      'runStatus.idle', 'step2.checked', 'step2.lateClaims', 'step2.onTime', 'step2.notDelivered', 'step2.progress',
      'status.waiting', 'step2.liveLog', 'step2.diagnostic.title', 'step2.diagnostic.message',
      'step2.diagnostic.rowLabel', 'action.cancel', 'action.continue'
    ]);
    assert.strictEqual(await window.locator('#importEstHistory').textContent(), 'Exécuter l’étape 1 — Importer l’historique EST');
    assert.strictEqual(await window.locator('#runTrackingOnly').textContent(), 'Exécuter l’étape 2 — Vérifier le suivi');
    assert.strictEqual(await window.locator('#stop').textContent(), 'Arrêter après l’élément en cours');
    assert.strictEqual(await window.locator('#runSiteHealth').count(), 0, 'manual workflow health-check button must be removed');
    assert.strictEqual(await window.locator('#siteHealthResult').count(), 0, 'standalone workflow health-check result must be removed');
    const emptyHistoryToolbars = await window.evaluate(() => [...document.querySelectorAll('#historyTab .history-toolbar')]
      .filter(element => !element.querySelector('button, input, select, textarea, [role="status"]')).length);
    assert.strictEqual(emptyHistoryToolbars, 0, 'health-check removal must not leave an empty History toolbar');
    assert.strictEqual(await window.locator('#resultsList .ops-head').textContent(), 'HeureLigneSuiviRésultatDétailsPreuve');
    await window.evaluate(() => window.renderClaimQueue([{
      recordId: 8001, evidenceHash: '8'.repeat(64), trackingNumber: 'FRENCH0000000001', referenceNumber: 'REF-FR',
      serviceCode: 'DOM.EP', firstAttemptDate: '2026-07-20', deliveryDate: '2026-07-21', deadline: '2026-09-01',
      deadlineState: 'known_active', businessDaysRemaining: 24, eligibilityReason: 'Synthetic localized candidate'
    }]));
    assert((await window.locator('#claimQueueList .claim-queue-row.header').textContent()).includes('Suivi'));
    assert((await window.locator('#claimQueueList .claim-queue-row.header').textContent()).includes('livraison réussie'));
    await window.evaluate(() => window.renderHistory([{ trackingNumber: 'FRENCH0000000001', attemptedAt: '2026-07-21T12:00:00Z', status: 'submitted', confirmationNumber: 'CONFIRMATION', message: '' }]));
    assert((await window.locator('#historyList .history-row.head').textContent()).includes('Heure de la tentative'));
    assert((await window.locator('#historyList .history-row:not(.head)').textContent()).includes('Soumise'));
    const dynamicFrench = await window.evaluate(() => {
      const tracking = window.describeEvent('tracking', { type: 'tracking_start', total: 1, requestIntervalMs: 3100, jitterMaxMs: 100 });
      window.setStatus('Running', 'warn', 'step1');
      window.setActionLocalized('step1.exportStarting', {}, '', 'step1');
      const step1 = {
        status: document.getElementById('step1RunStatus').textContent,
        action: document.getElementById('step1CurrentAction').textContent
      };
      window.UpdateProgress.render(document, { stage: 'checking' }, key => window.tr(key), () => {});
      const result = {
        tracking,
        step1,
        status: document.getElementById('step2RunStatus').textContent,
        updater: document.getElementById('updateProgressTitle').textContent,
        updaterStage: document.getElementById('updateProgressStage').textContent
      };
      window.UpdateProgress.render(document, { stage: 'hidden' }, key => window.tr(key), () => {});
      return result;
    });
    assert(dynamicFrench.tracking.startsWith('Étape de suivi démarrée.'));
    assert.strictEqual(dynamicFrench.step1.status, 'En cours');
    assert.strictEqual(dynamicFrench.step1.action, frenchMessages['step1.exportStarting']);
    assert.strictEqual(dynamicFrench.status, 'En cours');
    assert.strictEqual(dynamicFrench.updater, 'Mise à jour de l’application');
    assert.strictEqual(dynamicFrench.updaterStage, 'Vérification des versions GitHub…');
    const localizedStates = await window.evaluate(() => {
      const result = {};
      for (const [label, key] of [
        ['Running', 'running'], ['Complete', 'complete'], ['Failed', 'failed'], ['Blocked', 'blocked'], ['Stopped', 'stopped'],
        ['Diagnostic passed', 'diagnosticPassed'], ['Diagnostic failed', 'diagnosticFailed'],
        ['Diagnostic running', 'diagnosticRunning'], ['Diagnostic blocked', 'diagnosticBlocked']
      ]) {
        window.setStatus(label, '', 'step2');
        result[key] = document.getElementById('step2RunStatus').textContent;
      }
      window.setLocalizedText(document.getElementById('step2RunStatus'), 'step2.discardedStatus');
      result.discarded = document.getElementById('step2RunStatus').textContent;
      document.getElementById('forceStopStep2').disabled = true;
      result.disabledForceStop = document.getElementById('forceStopStep2').textContent;
      return result;
    });
    for (const [state, key] of [
      ['running', 'runStatus.running'], ['complete', 'runStatus.complete'], ['failed', 'runStatus.failed'],
      ['blocked', 'runStatus.blocked'], ['stopped', 'runStatus.stopped'], ['diagnosticPassed', 'runStatus.diagnosticPassed'],
      ['diagnosticFailed', 'runStatus.diagnosticFailed'], ['diagnosticRunning', 'runStatus.diagnosticRunning'],
      ['diagnosticBlocked', 'runStatus.diagnosticBlocked'], ['discarded', 'step2.discardedStatus']
    ]) assert.strictEqual(localizedStates[state], frenchMessages[key]);
    assert.strictEqual(localizedStates.disabledForceStop, frenchMessages['action.forceStop']);
    const frenchConfirmationPromise = window.waitForEvent('dialog');
    const discardPromise = window.evaluate(() => window.discardIncompleteTracking());
    const frenchConfirmation = await frenchConfirmationPromise;
    assert.match(frenchConfirmation.message(), /Abandonner l’état de préparation incomplet de l’étape 2/);
    await frenchConfirmation.dismiss();
    await discardPromise;
    await window.evaluate(() => window.describeEvent('tracking', { type: 'tracking_circuit_open', attempted: 1, total: 2, remaining: 1, errors: 1, queuePreserved: true }));
    assert.match(await window.locator('#step2CurrentAction').textContent(), /défaillance systémique de l’intégration/);
    await window.evaluate(async () => window.showSetupWizard(await window.cpApp.loadConfig()));
    assert.strictEqual(await window.locator('#setupWizardTitle').textContent(), 'Bienvenue — configuration de l’état de préparation');
    assert.strictEqual(await window.locator('#setupLater').textContent(), 'Continuer plus tard');
    await window.locator('#setupLater').click();
    const mixedEnglish = await window.evaluate(() => {
      const banned = ['Run Step 1', 'Force Stop', 'Step 2 Status', 'Stop After Current Item', 'Support bundle', 'Check Browser Session', 'Results & Evidence'];
      const copy = document.body.textContent;
      return banned.filter(text => copy.includes(text));
    });
    assert.deepStrictEqual(mixedEnglish, [], 'major French workflow surfaces must not retain observed English copy');
    await window.locator('#localeSelect').selectOption('en-CA');
    await window.locator('html[lang="en-CA"]').waitFor();
    assert.strictEqual(await window.locator('#importEstHistory').textContent(), 'Run Step 1 — Import EST History');
    assert.strictEqual(await window.locator('#step1CurrentAction').textContent(), 'Exporting EST Desktop history and generating tracking.csv.');
    assert.strictEqual(await window.locator('#runTrackingOnly').textContent(), 'Run Step 2 — Check Tracking');
    assert.match(await window.locator('#step2CurrentAction').textContent(), /systemic integration failure/,
      'visible dynamic status text must be regenerated immediately after a language switch');

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
