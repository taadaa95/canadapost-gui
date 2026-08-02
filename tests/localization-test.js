'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { assertLocaleCompleteness, loadLocale, normalizeLocale, translate, interpolate } = require('../lib/i18n');

const root = path.resolve(__dirname, '..');
const keys = assertLocaleCompleteness();
assert.ok(keys.length >= 640, 'the complete interface localization catalogue must be present');
assert.strictEqual(normalizeLocale('fr'), 'fr-CA');
assert.strictEqual(normalizeLocale('en-US'), 'en-CA');
const french = loadLocale('fr-CA');
assert.strictEqual(translate(french, 'classification.REVIEW_REQUIRED'), 'Révision requise');
assert.strictEqual(translate(french, 'history.clearFilters'), 'Effacer les filtres');
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
  ['history.manual.note', 'Note is the natural French cognate.'],
  ['results.notificationCount', 'Notification is the natural French cognate and the value is parameterized.'],
  ['results.oneNotification', 'Notification is the natural French cognate.'],
  ['history.confirmation', 'Confirmation is the natural French cognate.'],
  ['history.message', 'Message is the natural French cognate.'],
  ['history.actions', 'Actions is the natural French cognate.'],
  ['runStatus.captcha', 'CAPTCHA is an international technical acronym.'],
  ['common.absent', 'Absent is the natural French cognate.'],
  ['common.date', 'Date is the natural French cognate.']
]);
const identical = keys.filter(key => english[key] === french.messages[key]);
assert.deepStrictEqual(identical.sort(), [...identicalFrenchAllowlist.keys()].sort(), 'identical translations require a narrow, reviewed allowlist');

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const localizedAttributes = [...html.matchAll(/data-i18n(?:-placeholder|-aria-label|-title|-alt)?="([^"]+)"/g)].map(match => match[1]);
assert(localizedAttributes.length >= 270, 'major interface text and accessibility attributes must use declarative localization');
for (const key of localizedAttributes) assert(Object.hasOwn(english, key), `HTML localization key is missing: ${key}`);

const visibleTextNodes = [...html.matchAll(/>([^<>]+)</g)]
  .map(match => match[1].replace(/&amp;/g, '&').trim())
  .filter(text => /[A-Za-zÀ-ÿ]/.test(text));
const intentionalTemplateText = new Set(['English (Canada)', 'Français (Canada)', '0.4.0-beta.1']);
assert.deepStrictEqual([...new Set(visibleTextNodes)].sort(), [...intentionalTemplateText].sort(), 'HTML must not contain hard-coded interface copy');

const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const updaterSource = fs.readFileSync(path.join(root, 'lib', 'github-release-updater.js'), 'utf8');
const nativeAuthorizationSource = fs.readFileSync(path.join(root, 'lib', 'live-submission-authorization.js'), 'utf8');
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
  "title: 'Check for updates'", "title: 'No update available'", "title: 'Update available'",
  "title: 'Final live-submission confirmation'", "buttons: ['Cancel'"
]) assert(!`${updaterSource}\n${nativeAuthorizationSource}`.includes(forbidden), `native module still hard-codes English: ${forbidden}`);

const staticCodeKeys = new Set();
for (const source of [rendererSource, mainSource, updaterSource, nativeAuthorizationSource]) {
  for (const match of source.matchAll(/(?:tr|localizedText)\(\s*['"]([^'"]+)['"]/g)) staticCodeKeys.add(match[1]);
}
for (const key of staticCodeKeys) assert(Object.hasOwn(english, key), `code localization key is missing: ${key}`);

for (const key of [
  'dialog.liveSubmit.title', 'dialog.liveSubmit.message', 'dialog.liveSubmit.canaryMessage',
  'dialog.liveSubmit.detail', 'dialog.liveSubmit.action', 'dialog.liveSubmit.canaryAction',
  'update.check', 'update.packagedOnly', 'update.none.title', 'update.none.message',
  'update.available.title', 'update.available.message', 'update.available.download', 'update.available.openRelease'
]) {
  assert(Object.hasOwn(french.messages, key), `French native-confirmation localization is missing: ${key}`);
  assert.notStrictEqual(french.messages[key], english[key], `French native-confirmation text remained English: ${key}`);
}

const observedEnglish = [
  'Run Step 1 — Import EST History', 'Force Stop', 'Step 2 — Check Tracking / Create Claims',
  'Test API connection with one shipment', 'Export sanitized response structure', 'Discard incomplete Step 2 run',
  'Use built-in browser inside the app', 'Stop After Current Item',
  'Check Browser Session', 'Manually add or annotate a shipment', 'Results & Evidence — click any row for details'
];
for (const text of observedEnglish) {
  assert(Object.values(english).includes(text), `English catalogue is missing reviewed copy: ${text}`);
  assert(!Object.values(french.messages).includes(text), `French catalogue retained English interface copy: ${text}`);
}

for (const key of [
  'step1.title', 'step1.createsTrackingCsv', 'step1.fromDate', 'step1.toDate', 'step1.run', 'step1.statusTitle',
  'step1.ordersFound', 'step1.shipmentsImported', 'step1.workgroups', 'step1.warningsAria', 'step1.warningsInspect',
  'step1.progress', 'step1.liveLog', 'step1.exportStarting', 'step1.exportStartFailed', 'step1.historyImportStarting',
  'step1.historyStartFailed', 'step1.runFailed', 'step1.runBlocked', 'step2.title', 'step2.readsTrackingCsv', 'step2.freshRun', 'step2.run',
  'step2.testConnection', 'step2.exportStructure', 'step2.discardIncomplete', 'step2.statusTitle', 'step2.checked',
  'step2.lateClaims', 'step2.onTime', 'step2.notDelivered', 'step2.progress', 'step2.liveLog',
  'step2.diagnostic.title', 'step2.diagnostic.message', 'step2.diagnostic.rowLabel', 'step2.comparingAction',
  'step2.startFailed', 'step2.runFailed', 'step2.runBlocked', 'step2.diagnostic.structureAction', 'step2.diagnostic.connectionAction',
  'step2.diagnostic.confirmedLog'
]) {
  assert(Object.hasOwn(french.messages, key), `French workflow localization is missing: ${key}`);
  assert.notStrictEqual(french.messages[key], english[key], `French workflow text remained English: ${key}`);
}

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

process.stdout.write(`Localization completeness tests passed for ${keys.length} keys and ${localizedAttributes.length} localized DOM attributes.\n`);
