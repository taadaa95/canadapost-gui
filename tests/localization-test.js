'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { assertLocaleCompleteness, loadLocale, normalizeLocale, translate, interpolate } = require('../lib/i18n');

const root = path.resolve(__dirname, '..');
const keys = assertLocaleCompleteness();
assert.ok(keys.length >= 570, 'the complete interface localization catalogue must be present');
assert.strictEqual(normalizeLocale('fr'), 'fr-CA');
assert.strictEqual(normalizeLocale('en-US'), 'en-CA');
const french = loadLocale('fr-CA');
assert.strictEqual(translate(french, 'classification.REVIEW_REQUIRED'), 'Révision requise');
assert.strictEqual(translate(french, 'history.needsAttention'), 'Attention requise');
assert.strictEqual(translate(french, 'missing.key', 'Fallback text'), 'Fallback text');
assert.strictEqual(interpolate(translate(french, 'step3.selectedCount'), { selected: 2, total: 4 }), '2 sur 4 sélectionnés');
assert.strictEqual(interpolate('Keep {tracking} and {phone}', { tracking: '1234567890123456', phone: '1-888-550-6333' }), 'Keep 1234567890123456 and 1-888-550-6333');
assert.ok(french.messages['step3.supportGuidance'].includes('1-888-550-6333'));
assert.ok(!Object.values(french.messages).some(value => !String(value).trim()));

const english = loadLocale('en-CA').messages;
const identicalFrenchAllowlist = new Map([
  ['step3.queue.service', 'Service is the natural French cognate.'],
  ['app.version', 'Version is the natural French cognate.'],
  ['environment.production', 'Production is the natural French cognate.'],
  ['settings.sender.province', 'Province is the natural French cognate.'],
  ['common.source', 'Source is the natural French cognate.'],
  ['results.notificationCount', 'Notification is the natural French cognate and the value is parameterized.'],
  ['results.oneNotification', 'Notification is the natural French cognate.'],
  ['history.confirmation', 'Confirmation is the natural French cognate.'],
  ['history.message', 'Message is the natural French cognate.'],
  ['runStatus.captcha', 'CAPTCHA is an international technical acronym.'],
  ['common.absent', 'Absent is the natural French cognate.'],
  ['common.date', 'Date is the natural French cognate.']
]);
const identical = keys.filter(key => english[key] === french.messages[key]);
assert.deepStrictEqual(identical.sort(), [...identicalFrenchAllowlist.keys()].sort(), 'identical translations require a narrow, reviewed allowlist');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const localizedAttributes = [...html.matchAll(/data-i18n(?:-placeholder|-aria-label|-title|-alt)?="([^"]+)"/g)].map(match => match[1]);
const requiredLocalizedDomKeys = [
  'nav.settings.title', 'nav.step1.title', 'nav.step3.title', 'nav.history.title', 'nav.results.title',
  'settings.save', 'step1.title', 'step1.start', 'step1.stop', 'step1.shipmentsImported',
  'step1.checkedImported', 'step1.importProgress', 'step1.identifyProgress', 'step1.liveLog', 'step3.title'
];
assert(localizedAttributes.length > 0, 'interface must retain declarative localization attributes');
for (const key of requiredLocalizedDomKeys) {
  assert(localizedAttributes.includes(key), `major localized interface control is missing from the DOM: ${key}`);
}
for (const key of localizedAttributes) assert(Object.hasOwn(english, key), `HTML localization key is missing: ${key}`);

const visibleTextNodes = [...html.matchAll(/>([^<>]+)</g)]
  .map(match => match[1].replace(/&amp;/g, '&').trim())
  .filter(text => /[A-Za-zÀ-ÿ]/.test(text));
const intentionalTemplateText = new Set(['English (Canada)', 'Français (Canada)']);
assert.deepStrictEqual([...new Set(visibleTextNodes)].sort(), [...intentionalTemplateText].sort(), 'HTML must not contain hard-coded interface copy');

const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const updaterSource = fs.readFileSync(path.join(root, 'lib', 'github-release-updater.js'), 'utf8');
for (const forbidden of [
  '.textContent = \'No claim results yet.\'',
  '.textContent = \'View evidence\'',
  '.textContent = \'Database healthy\'',
  "window.confirm('Restore a backup?",
  "window.confirm('Log out and clear the Canada Post browser profile?"
]) assert(!rendererSource.includes(forbidden), `renderer still hard-codes user-visible English: ${forbidden}`);

for (const forbidden of [
  "title: 'Select tracking.csv'",
  "title: 'Export claim history'",
  "title: 'Create Canada Post Claim Runner backup'",
  "title: 'Restore Canada Post Claim Runner backup'",
  "title: 'Create sanitized support bundle'",
  "title: 'Database recovery required'",
  "buttons: ['Open data folder', 'Copy diagnostic', 'Exit']"
]) assert(!mainSource.includes(forbidden), `native dialog still hard-codes English: ${forbidden}`);
for (const forbidden of [
  "title: 'Check for updates'", "title: 'No update available'", "title: 'Update available'"
]) assert(!updaterSource.includes(forbidden), `native module still hard-codes English: ${forbidden}`);

const staticCodeKeys = new Set();
for (const source of [rendererSource, mainSource, updaterSource]) {
  for (const match of source.matchAll(/(?:tr|localizedText)\(\s*['"]([^'"]+)['"]/g)) staticCodeKeys.add(match[1]);
}
for (const key of staticCodeKeys) assert(Object.hasOwn(english, key), `code localization key is missing: ${key}`);

for (const key of [
  'update.check', 'update.packagedOnly', 'update.none.title', 'update.none.message',
  'update.available.title', 'update.available.message', 'update.available.downloadInstall'
]) {
  assert(Object.hasOwn(french.messages, key), `French native-confirmation localization is missing: ${key}`);
  assert.notStrictEqual(french.messages[key], english[key], `French native-confirmation text remained English: ${key}`);
}

const observedEnglish = [
  'Run Step 1 — Import Shipment History', 'Force Stop', 'Identify Late Candidates',
  'Stop After Current Item', 'Results & Evidence — click any row for details'
];
for (const text of observedEnglish) {
  assert(Object.values(english).includes(text), `English catalogue is missing reviewed copy: ${text}`);
  assert(!Object.values(french.messages).includes(text), `French catalogue retained English interface copy: ${text}`);
}

for (const key of [
  'step1.title', 'step1.createsTrackingCsv', 'step1.rollingWindow', 'step1.carryForward', 'step1.run', 'step1.statusTitle',
  'step1.ordersFound', 'step1.shipmentsImported', 'step1.workgroups', 'step1.warningsAria', 'step1.warningsInspect',
  'step1.progress', 'step1.liveLog', 'step1.exportStarting', 'step1.exportStartFailed', 'step1.historyImportStarting',
  'step1.historyStartFailed', 'step1.runFailed', 'step1.runBlocked', 'step2.title', 'step2.readsTrackingCsv', 'step2.run',
  'step2.statusTitle', 'step2.checked',
  'step2.lateClaims', 'step2.onTime', 'step2.notDelivered', 'step2.progress', 'step2.liveLog',
  'step2.comparingAction',
  'step2.startFailed', 'step2.runFailed', 'step2.runBlocked', 'step2.diagnostic.structureAction', 'step2.diagnostic.connectionAction',
  'step2.diagnostic.confirmedLog'
]) {
  assert(Object.hasOwn(french.messages, key), `French workflow localization is missing: ${key}`);
  assert.notStrictEqual(french.messages[key], english[key], `French workflow text remained English: ${key}`);
}
for (const key of [
  'build.signed', 'build.unsigned', 'step2.freshRun', 'step2.testConnection', 'step2.exportStructure',
  'step2.discardIncomplete', 'step2.diagnostic.title', 'step2.diagnostic.message', 'step2.diagnostic.rowLabel',
  'results.zeroNotifications', 'history.reconcile.markSubmitted', 'history.reconcile.markNotSubmitted',
  'history.reconcile.approveRetry', 'settings.savedEncrypted', 'settings.savedWithoutPassword'
]) {
  assert.ok(!Object.hasOwn(english, key), `unused product UI localization key must be removed: ${key}`);
  assert.ok(!Object.hasOwn(french.messages, key), `unused French product UI localization key must be removed: ${key}`);
}
assert.strictEqual(english['settings.savedStatus'], 'Settings saved');

assert.match(rendererSource, /let preferredLocale = '';/, 'renderer must retain the user-selected locale while config refreshes finish');
assert.match(rendererSource, /const requestVersion = \+\+localeRequestVersion;/, 'locale application must sequence asynchronous requests');
assert.match(rendererSource, /if \(requestVersion !== localeRequestVersion\) return false;/, 'stale locale responses must not overwrite a newer selection');
assert.match(rendererSource, /applyLocale\(preferredLocale \|\| cfg\.locale \|\| 'en-CA'\)/, 'config refresh must prefer an in-session language selection');
assert.match(rendererSource, /step1: \{ failed: 'step1\.runFailed', blocked: 'step1\.runBlocked' \}/, 'unkeyed Step 1 worker failures must use localized fallbacks');
assert.match(rendererSource, /step2: \{ failed: 'step2\.runFailed', blocked: 'step2\.runBlocked' \}/, 'unkeyed Step 2 worker failures must use localized fallbacks');
assert.match(rendererSource, /function setAction[\s\S]*?delete el\.dataset\.i18nCurrent;[\s\S]*?delete el\.dataset\.i18nValues;/, 'raw action updates must clear stale localization metadata');
assert.match(rendererSource, /setLocalizedText\(placeholder, localizationKey, \{\}, text\)/, 'dynamic browser placeholder text must retain its current localization key');
assert.ok(!html.includes('id="runSiteHealth"'));
assert.ok(!html.includes('id="siteHealthResult"'));
assert.ok(!Object.hasOwn(english, 'health.run'), 'obsolete manual health-check localization must be removed');
assert.ok(!Object.hasOwn(french.messages, 'health.run'), 'obsolete manual health-check French localization must be removed');
for (const locale of [english, french.messages]) {
  for (const key of ['history.filter.label', 'history.filter.all', 'history.filter.submitted', 'history.filter.needsAttention', 'history.filter.failed', 'history.filter.alreadySubmitted', 'history.filter.rejected']) {
    assert.ok(Object.hasOwn(locale, key) && String(locale[key] || '').trim(), `${key} must be localized`);
  }
  assert.ok(!Object.keys(locale).some(key => key.startsWith('history.manual.')), 'manual-shipment localization must be removed');
  for (const key of ['history.reconciliationQueue', 'history.classifications', 'history.clearFilters']) {
    assert.ok(!Object.hasOwn(locale, key), `${key} must be removed`);
  }
}

process.stdout.write(`Localization completeness tests passed for ${keys.length} keys and ${localizedAttributes.length} localized DOM attributes.\n`);
