'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'onboarding.js'), 'utf8'), sandbox);
const onboarding = sandbox.window.Onboarding;
assert.deepStrictEqual(Array.from(onboarding.THEMES), ['system', 'dark', 'light', 'high-contrast']);
assert.strictEqual(onboarding.normalizeTheme('tokyo-night'), 'system');
assert.strictEqual(onboarding.normalizeTheme('high-contrast'), 'high-contrast');
const incomplete = onboarding.readinessSummary({ dataDirectory: true });
assert.strictEqual(incomplete.ready, false);
assert.ok(incomplete.blockingCount > 0);
const complete = onboarding.readinessSummary({
  dataDirectory: true, databaseHealth: true, secureStorage: true, accountFields: true,
  apiCredentials: true, customerNumber: true, senderInformation: true, contactInformation: true,
  browserAvailable: true, policyAvailable: true, safetyAcknowledged: true
});
assert.strictEqual(complete.ready, true);
assert.strictEqual(complete.steps.some(step => step.id === 'diagnostic'), false,
  'Removed normal-user API diagnostics must not block onboarding');
assert.strictEqual(onboarding.readinessSummary({ ...Object.fromEntries(complete.steps.flatMap(step => step.readiness).map(key => [key, true])), safetyAcknowledged: false }).ready, false);
assert.strictEqual(complete.steps.find(step => step.id === 'external').ready, null);

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'base.css'), 'utf8');
assert.deepStrictEqual([...html.matchAll(/<option value="([^"]+)" data-i18n="theme\.(?:system|dark|light|highContrast)"><\/option>/g)].map(match => match[1]), ['system', 'dark', 'light', 'high-contrast']);
const french = require('../locales/fr-CA.json');
assert.deepStrictEqual(['theme.system', 'theme.dark', 'theme.light', 'theme.highContrast'].map(key => french[key]), ['Système', 'Sombre', 'Clair', 'Contraste élevé']);
for (const removed of ['tokyo-night', 'catppuccin-mocha', 'dracula', 'amoled']) assert.ok(!css.includes(`[data-theme="${removed}"]`));
assert.match(html, /id="setupSafetyAcknowledge"[^>]*type="checkbox"/);

process.stdout.write('First-run onboarding readiness tests passed.\n');
