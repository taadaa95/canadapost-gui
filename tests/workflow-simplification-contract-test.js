'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = source('index.html');
const css = source('renderer/base.css');
const renderer = source('renderer.js');
const main = source('main.js');
const preload = source('preload.js');
const queue = source('renderer/step3-queue.js');
const worker = source('scripts/submit-claims.js');
const english = require('../locales/en-CA.json');
const french = require('../locales/fr-CA.json');

assert.strictEqual(english['step1.title'], 'Step 1 — Import Shipment History');
assert.strictEqual(english['nav.step1.detail'], 'Import Shipment History');
assert.strictEqual(french['step1.title'], 'Étape 1 — Importer l’historique des envois');
assert.strictEqual(french['nav.step1.detail'], 'Importer l’historique des envois');
assert.doesNotMatch(JSON.stringify({ english, french }), /Import EST history|Importer l.historique EST/i);

assert.match(css, /input\[type="date"\][\s\S]*?height:\s*42px/);
assert.match(css, /\.step1-fields\s*\{[\s\S]*?repeat\(2, minmax\(0, 184px\)\)[\s\S]*?justify-content:\s*start/);
assert.match(css, /@media \(max-width: 420px\)[\s\S]*?\.step1-fields[\s\S]*?minmax\(0, 184px\)/);
assert.match(css, /input\[type="date"\]:hover[\s\S]*?border-color:\s*var\(--accent-2\)/);
assert.match(css, /input\[type="date"\]:focus/);
assert.match(css, /::-webkit-calendar-picker-indicator[\s\S]*?cursor:\s*pointer[\s\S]*?opacity:\s*1/);
assert.match(css, /:root\s*\{[\s\S]*?color-scheme:\s*dark/);
assert.match(css, /\[data-theme="light"\]\s*\{[\s\S]*?color-scheme:\s*light/);
assert.match(css, /\[data-theme="high-contrast"\]\s*\{[\s\S]*?color-scheme:\s*dark/);

const lightTheme = css.match(/\[data-theme="light"\]\s*\{[\s\S]*?\n\}/)?.[0] || '';
assert.match(lightTheme, /--success-text:\s*#166534/);
assert.match(lightTheme, /--warning-text:\s*#854d0e/);
assert.match(lightTheme, /--danger-text:\s*#991b1b/);
assert.match(lightTheme, /--info-text:\s*#1e40af/);
for (const semantic of ['log-on-time', 'log-not-delivered', 'log-late', 'log-already']) assert.match(css, new RegExp(`\\.${semantic}`));

const removedIds = [
  'checkStep3BrowserSession', 'step3BrowserSessionStatus', 'claimQueueSearch', 'claimQueueServiceFilter',
  'claimQueueUrgencyFilter', 'claimQueueDateFrom', 'claimQueueDateTo', 'builtinBrowser', 'dryRun',
  'liveSubmitModal', 'liveSubmitAcknowledge', 'confirmLiveSubmit', 'cancelLiveSubmit'
];
for (const id of removedIds) assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id} must be removed`);
assert.doesNotMatch(html, /id="clearStep3BrowserSession"/);
assert.match(main, /browser:clearSession/, 'low-level browser-session recovery must remain internal');
assert.match(html, /class="step-workspace step3-workspace"/);
assert.doesNotMatch(`${renderer}\n${css}`, /builtin-browser-enabled/);

const activate = renderer.match(/function activateTab\(tabId\)[\s\S]*?function stepForStage/)?.[0] || '';
assert.doesNotMatch(activate, /browserSessionStatus|sessionStatus/);
assert.doesNotMatch(`${preload}\n${main}`, /browser:sessionStatus/);
assert.match(renderer, /function useBuiltinBrowser\(\)\s*\{\s*return true;/);

assert.doesNotMatch(queue, /visible\(|filters|search|urgency|dateFrom|dateTo|\.sort\(/);
for (const method of ['load', 'items', 'selectAll', 'clear', 'set', 'selectedRecords', 'snapshot']) assert.match(queue, new RegExp(`\\b${method}\\b`));

const submit = renderer.match(/async function startSubmitOnly\(\)[\s\S]*?async function refreshConfig/)?.[0] || '';
assert.ok(submit.indexOf('await runStep3Preflight(basePreflightOptions)') < submit.indexOf('window.cpApp.runSubmit(buildSubmitOnlyOptions())'));
assert.doesNotMatch(submit, /confirm|acknowledge|dialog|dryRun/);
assert.doesNotMatch(`${renderer}\n${main}`, /requestNativeAuthorization|LIVE_SUBMISSION_AUTHORIZATION_FAILED|LIVE_SUBMISSION_CANCELLED/);
assert.match(main, /DRY_RUN: 'false'/);
assert.match(main, /MAX_CLAIMS: ''/);
assert.doesNotMatch(main, /selection\.slice\(0, 1\)/);

for (const protection of [
  /classification !== 'LATE_CANDIDATE'/,
  /STEP3_EVIDENCE_CHANGED/,
  /createRunSnapshot/,
  /STEP3_UNRESOLVED_ATTEMPT/,
  /STEP3_TERMINAL_OUTCOME/
]) assert.match(source('lib/step3-queue-service.js'), protection);
assert.match(worker, /CAPTCHA/);
assert.match(worker, /Never retry the financially significant action/);
assert.match(main, /persist:canadapost-claims-builtin/);

process.stdout.write('Workflow simplification, theme, and retained-safety contracts passed.\n');
