'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const renderer = read('renderer.js');
const main = read('main.js');
const preload = read('preload.js');
const claimDatabase = read('lib/claim-database.js');
const migrations = read('lib/database-migrations.js');
const english = require('../locales/en-CA.json');
const { runtimeTrackingEnvironment, legacyTrackingEnvironmentNeedsNormalization } = require('../lib/runtime-tracking-environment');

function functionSource(source, name, nextName) {
  const functionStart = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 && asyncStart < functionStart ? asyncStart : functionStart;
  const normalEnd = source.indexOf(`\nfunction ${nextName}(`, start);
  const asyncEnd = source.indexOf(`\nasync function ${nextName}(`, start);
  const candidates = [normalEnd, asyncEnd].filter(index => index > start);
  const end = candidates.length ? Math.min(...candidates) : -1;
  assert(start >= 0, `Could not find function ${name}`);
  assert(end > start, `Could not find function following ${name}`);
  return source.slice(start, end);
}

function makeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    contains: name => values.has(name),
    toggle: (name, force) => {
      const enabled = force === undefined ? !values.has(name) : Boolean(force);
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
    values
  };
}

function makeElement({ id = '', tab = '', classes = [] } = {}) {
  const attributes = {};
  const element = {
    id,
    dataset: { tab },
    classList: makeClassList(classes),
    textContent: '',
    hidden: false,
    tabIndex: -1,
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name]; }
  };
  Object.defineProperty(element, 'className', {
    get() { return [...element.classList.values].join(' '); },
    set(value) { element.classList = makeClassList(String(value).split(/\s+/).filter(Boolean)); }
  });
  return element;
}

function assertProductSurfaceCleanup() {
  const removedIds = [
    'freshTracking', 'testTrackingConnection', 'exportTrackingStructure', 'discardIncompleteTracking',
    'trackingDiagnosticModal', 'trackingDiagnosticRow', 'trackingDiagnosticGate', 'buildTrustStatus'
  ];
  for (const id of removedIds) assert.ok(!html.includes(`id="${id}"`), `Product HTML still contains #${id}`);
  for (const key of [
    'step2.freshRun', 'step2.testConnection', 'step2.exportStructure', 'step2.discardIncomplete',
    'step2.diagnostic.title', 'step2.diagnostic.message', 'step2.diagnostic.rowLabel', 'build.unsigned'
  ]) assert.ok(!html.includes(`data-i18n="${key}"`), `Product HTML still contains removed copy ${key}`);
  assert.doesNotMatch(html, /id="runTrackingOnly"/, 'Tracking starts automatically after Step 1 import');
  assert.doesNotMatch(html, /id="tabStep2"/, 'Tracking no longer has a standalone customer-facing tab');
  assert.match(renderer, /function mergeTrackingIntoStep1/);
  assert.match(renderer, /autoTrackingAfterImport/);
  assert.match(html, /id="forceStopStep1"[^>]*data-force-stop="step1"/, 'Step 1 must expose one stop control for both import and tracking');
  assert.doesNotMatch(html, /id="forceStopStep2"/, 'The removed standalone tracking phase must not expose a second stop button');

  assert.ok(!renderer.includes('function reconciliationActionButton('));
  for (const label of ['Mark submitted', 'Mark not submitted', 'Approve retry']) {
    assert.ok(!`${renderer}\n${JSON.stringify(english)}`.includes(label), `Product renderer/catalogue still contains ${label}`);
  }
  assert.match(renderer, /function renderHistory[\s\S]*?history\.viewEvidence/);
  for (const key of ['history.status.unknown', 'history.status.notSubmitted', 'history.status.retryApproved']) {
    assert.ok(Object.hasOwn(english, key), `Historical status localization was removed: ${key}`);
  }
  assert.match(claimDatabase, /function reconcileAttempt\(/);
  assert.match(claimDatabase, /\['not_submitted', 'not_submitted'\]/);
  assert.match(claimDatabase, /\['retry', 'retry_approved'\]/);
  assert.match(preload, /reconcileAttempt/);
  assert.match(main, /reconciliation:update/);

  assert.match(html, /id="appTitle"[^>]*data-i18n="app\.title"/);
  assert.match(html, /id="appSubtitle"[^>]*data-i18n="app\.subtitle"/);
  assert.ok(!Object.hasOwn(english, 'build.unsigned'));
  assert.match(main, /signedBuild:\s*false/);
  assert.ok(fs.existsSync(path.join(root, 'lib', 'release-safety.js')));
  assert.ok(fs.existsSync(path.join(root, 'electron-builder.release.yml')));

  assert.match(renderer, /async function testTrackingConnection\(\)/);
  assert.match(renderer, /async function exportTrackingStructure\(\)/);
  assert.match(renderer, /async function discardIncompleteTracking\(\)/);
  assert.match(preload, /tracking:diagnosticDefaultRow/);
  assert.match(preload, /tracking:discardIncomplete/);
  assert.match(main, /const diagnosticMode = options\.diagnosticMode === true/);
  assert.doesNotMatch(main, /Step 2 is blocked until .*Test API connection with one shipment/,
    'Normal Step 2 must not depend on removed diagnostic controls');
  assert.match(main, /tracking:discardIncomplete/);
  assert.match(migrations, /const SCHEMA_VERSION = 8;/);
}

function testFreshTrackingDefault() {
  const normalStep2Run = functionSource(renderer, 'startTrackingOnly', 'requestTrackingDiagnosticRow');
  assert.match(normalStep2Run, /window\.cpApp\.runTracking\(buildTrackingOnlyOptions\(\)\)/);
  const context = vm.createContext({
    $: () => null,
    getFieldValue: () => '',
    state: { trackingApiEnvironment: 'test' },
    Number
  });
  vm.runInContext(functionSource(renderer, 'buildTrackingOnlyOptions', 'renderTrackingApiCredentialMetadata'), context);
  const options = vm.runInContext('buildTrackingOnlyOptions()', context);
  assert.strictEqual(options.fresh, true, 'Normal Step 2 must default to fresh=true without a checkbox');
  assert.strictEqual(options.trackingApiEnvironment, 'production', 'Normal Step 2 must always use production');
}

function testProductionRuntimeInvariant() {
  for (const legacy of [undefined, '', 'production', 'test', 'sandbox', 'development', 'another obsolete environment']) {
    assert.strictEqual(runtimeTrackingEnvironment(legacy), 'production');
  }
  assert.strictEqual(legacyTrackingEnvironmentNeedsNormalization(undefined), false);
  assert.strictEqual(legacyTrackingEnvironmentNeedsNormalization('production'), false);
  for (const legacy of ['test', 'sandbox', 'development']) {
    assert.strictEqual(legacyTrackingEnvironmentNeedsNormalization(legacy), true);
  }
  assert.doesNotMatch(html, /id="trackingApiEnvironment"/);
  assert.match(main, /const trackingApiEnvironment = runtimeTrackingEnvironment\(options\.trackingApiEnvironment \|\| config\.trackingApiEnvironment\)/);
  assert.match(main, /sanitized\.trackingApiEnvironment = runtimeTrackingEnvironment/);
  assert.match(main, /persist:canadapost-claims-builtin/);
}

async function testSettingsSaveStatus() {
  const settingsStatus = makeElement();
  let saveResult = { ok: true, warning: 'The OS keyring is unavailable.', passwordStored: true };
  const context = vm.createContext({
    $: id => id === 'settingsStatus' ? settingsStatus : null,
    collectUserSettingsOptions: () => ({ rememberSettings: true, webPassword: 'secret' }),
    window: { cpApp: { saveConfig: async () => saveResult } },
    state: {},
    tr: (key, fallback) => fallback || key,
    setLocalizedText: (element, key, values, fallback) => { element.textContent = key === 'settings.savedStatus' ? 'Settings saved' : fallback; },
    renderTrackingApiCredentialMetadata: () => {},
    applyStoredCredentialMasks: () => {},
    log: () => {}
  });
  vm.runInContext(functionSource(renderer, 'saveUserSettings', 'clearTrackingApiCredentials'), context);

  await vm.runInContext('saveUserSettings(true)', context);
  assert.strictEqual(settingsStatus.textContent, 'Settings saved');
  assert.strictEqual(settingsStatus.className, 'pill good');

  saveResult = { ok: false, error: 'Could not encrypt credentials.' };
  await vm.runInContext('saveUserSettings(true)', context);
  assert.strictEqual(settingsStatus.textContent, 'Could not encrypt credentials.');
  assert.strictEqual(settingsStatus.className, 'pill bad');
}

function testResultNotifications() {
  const badge = makeElement({ id: 'notificationsBadge', classes: ['notification-badge', 'hidden'] });
  const pill = makeElement({ id: 'notificationsCountPill', classes: ['pill', 'hidden'] });
  const resultsTabButton = makeElement({ id: 'tabResults', tab: 'resultsTab', classes: ['step-tab'] });
  const settingsTabButton = makeElement({ id: 'tabSettings', tab: 'settingsTab', classes: ['step-tab', 'active'] });
  const resultsPanel = makeElement({ id: 'resultsTab' });
  const settingsPanel = makeElement({ id: 'settingsTab', classes: ['active'] });
  const elements = { notificationsBadge: badge, notificationsCountPill: pill, tabResults: resultsTabButton };
  const operations = {
    recentResults: [], needsReview: [], detailItems: new Map(), detailCounter: 0,
    selectedDetailId: null, unreadNotifications: 0
  };
  let detailCounter = 0;
  const context = vm.createContext({
    $: id => elements[id] || null,
    activeTabId: 'settingsTab',
    operations,
    registerDetailItem: item => ({ ...item, id: `test-detail-${++detailCounter}` }),
    setLocalizedText: (element, key, values) => { element.textContent = key === 'results.oneNotification' ? '1 notification' : `${values.count} notifications`; },
    document: {
      documentElement: { classList: makeClassList() },
      body: { classList: makeClassList() },
      querySelectorAll: selector => selector === '.step-tab'
        ? [settingsTabButton, resultsTabButton]
        : [settingsPanel, resultsPanel]
    },
    state: { claimQueueLoaded: true },
    refreshHistory: async () => {},
    refreshClaimQueue: async () => {},
    requestBuiltinBrowserLayout: () => {},
    rendererEvents: { emit: () => {} },
    showOperationsList: () => { operations.selectedDetailId = null; operations.unreadNotifications = 0; },
    selectedDetail: null,
    Map
  });
  vm.runInContext(functionSource(renderer, 'updateNotificationIndicator', 'processedClaims'), context);
  vm.runInContext(functionSource(renderer, 'addRecentResult', 'addNeedsReview'), context);
  vm.runInContext(functionSource(renderer, 'resetResultsData', 'resetStepUi'), context);
  vm.runInContext(functionSource(renderer, 'activateTab', 'stepForStage'), context);

  vm.runInContext('updateNotificationIndicator()', context);
  assert.strictEqual(badge.hidden, true);
  assert.strictEqual(badge.textContent, '');
  assert.strictEqual(badge.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(pill.hidden, true);
  assert.strictEqual(pill.textContent, '');

  vm.runInContext("addRecentResult('submitted', 'TRACKING-1', 'Submitted', 1, { eventType: 'claim_submitted' })", context);
  assert.strictEqual(operations.unreadNotifications, 1);
  assert.strictEqual(badge.hidden, false);
  assert.strictEqual(badge.textContent, '1');
  assert.strictEqual(badge.getAttribute('aria-hidden'), 'false');

  vm.runInContext("addRecentResult('failed', 'TRACKING-2', 'Failed', 2, { eventType: 'claim_error' })", context);
  assert.strictEqual(operations.unreadNotifications, 2);
  assert.strictEqual(badge.textContent, '2');
  assert.strictEqual(pill.hidden, false);
  assert.strictEqual(pill.textContent, '2 notifications');

  vm.runInContext("activateTab('resultsTab')", context);
  assert.strictEqual(operations.unreadNotifications, 0);
  assert.strictEqual(badge.hidden, true);
  assert.strictEqual(badge.textContent, '');
  assert.strictEqual(pill.hidden, false);
  assert.strictEqual(pill.textContent, '2 notifications');

  vm.runInContext('resetResultsData()', context);
  assert.strictEqual(operations.recentResults.length, 0);
  assert.strictEqual(operations.unreadNotifications, 0);
  assert.strictEqual(badge.hidden, true);
  assert.strictEqual(badge.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(pill.hidden, true);
  assert.strictEqual(pill.getAttribute('aria-hidden'), 'true');
  assert.strictEqual(pill.textContent, '');

  const eventFlow = functionSource(renderer, 'describeEvent', 'historyDate');
  const resultEventTypes = ['captcha_detected', 'claim_submitted', 'claim_already_submitted', 'claim_rejected', 'claim_error'];
  for (let index = 0; index < resultEventTypes.length; index += 1) {
    const type = resultEventTypes[index];
    const start = eventFlow.indexOf(`type === '${type}'`);
    const next = index + 1 < resultEventTypes.length
      ? eventFlow.indexOf(`type === '${resultEventTypes[index + 1]}'`, start)
      : eventFlow.indexOf("type === 'submit_complete'", start);
    const branch = eventFlow.slice(start, next);
    assert.strictEqual((branch.match(/addRecentResult\(/g) || []).length, 1,
      `${type} must create at most one user-visible result and unread notification`);
  }
}

(async () => {
  assertProductSurfaceCleanup();
  testFreshTrackingDefault();
  testProductionRuntimeInvariant();
  await testSettingsSaveStatus();
  testResultNotifications();
  process.stdout.write('Dev11 product UI cleanup tests passed.\n');
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
