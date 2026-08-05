'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = source('index.html');
const renderer = source('renderer.js');
const main = source('main.js');
const preflight = source('lib/preflight.js');
const queueService = source('lib/step3-queue-service.js');
const submitWorker = source('scripts/submit-claims.js');
const english = require('../locales/en-CA.json');
const french = require('../locales/fr-CA.json');

const tabs = [...html.matchAll(/<button id="tab(Settings|Step1|Step2|Step3|History|Results)"([^>]*)>/g)];
assert.strictEqual(tabs.length, 6, 'all primary workflow tabs must be present');
for (const [, name, attributes] of tabs) {
  assert.doesNotMatch(attributes, /\bdisabled\b|aria-disabled="true"/, `${name} must never be disabled by readiness state`);
}

const activateTab = renderer.match(/function activateTab\(tabId\)[\s\S]*?function stepForStage/)?.[0] || '';
assert.doesNotMatch(activateTab, /readiness|prerequi|credential|setupCompleted|activateTab\('settingsTab'\)/i,
  'tab activation must not contain readiness gates or Settings redirects');
assert.doesNotMatch(activateTab, /if\s*\([^)]*compatib|show.*modal|return\s*;/i,
  'compatibility refresh during tab activation must never gate page entry');
assert.match(renderer, /button\.addEventListener\('click', \(\) => activateTab\(button\.dataset\.tab\)\)/);
for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert(renderer.includes(`'${key}'`), `${key} tab navigation must remain available`);
assert.doesNotMatch(renderer, /if \(!cfg\.setupCompleted[^\n]*showSetupWizard/, 'incomplete onboarding must not auto-open a blocking modal');

assert.ok(!html.includes('step3PreflightModal'), 'the blocking Step 3 preflight modal must be removed');
assert.ok(!html.includes('step3.preflight.blockedTitle'));
assert.ok(!Object.hasOwn(english, 'step3.preflight.blockedTitle'));
assert.ok(!Object.hasOwn(french, 'step3.preflight.blockedTitle'));
assert.doesNotMatch(`${html}\n${renderer}\n${JSON.stringify(english)}\n${JSON.stringify(french)}`, /Step 3 cannot continue|Impossible de poursuivre l’étape 3/i);
assert.match(html, /id="step3ActionAdvisory"[^>]*class="step3-action-advisory hidden"/,
  'action-specific prerequisite failures must render inline');
assert.match(renderer, /function showStep3ActionIssues/);

const sandbox = { window: {} };
vm.runInNewContext(source('renderer/portal-advisory.js'), sandbox);
const describe = sandbox.window.PortalAdvisory.describe;
assert.deepStrictEqual({ ...describe({ ok: true }) }, { id: 'compatible', kind: 'good', requiresOverride: false });
assert.strictEqual(describe({ ok: false, code: 'PORTAL_COMPATIBILITY_REQUIRED' }).id, 'notChecked');
assert.strictEqual(describe({ ok: false, code: 'PORTAL_COMPATIBILITY_STALE' }).id, 'stale');
assert.strictEqual(describe({ ok: false, code: 'PORTAL_COMPATIBILITY_FAILED' }).id, 'incompatible');
assert.strictEqual(describe({ ok: false, code: 'UNEXPECTED' }).id, 'warning');
assert.match(html, /id="portalCompatibilityAdvisory"/);
for (const id of ['checkStep3BrowserSession', 'refreshPortalCompatibility', 'openSettingsFromPortalAdvisory', 'dismissPortalCompatibility']) {
  assert(html.includes(`id="${id}"`), `inline compatibility action ${id} must be available`);
}

assert.match(html, /id="dryRun"[^>]*checked/, 'dry run must remain the default');
assert.doesNotMatch(renderer.match(/function updateClaimQueueCount\(\)[\s\S]*?function queueCell/)?.[0] || '', /compatib/i,
  'compatibility state must never disable dry-run or queue actions');
assert.match(html, /id="portalCompatibilityOverrideModal"/);
assert.match(html, /id="cancelPortalCompatibilityOverride"[^>]*data-i18n="action.cancel"/);
assert.match(html, /id="continuePortalCompatibilityOverride"[^>]*data-i18n="step3.compatibility.continueAnyway"/);
const startSubmit = renderer.match(/async function startSubmitOnly\(\)[\s\S]*?async function refreshConfig/)?.[0] || '';
assert.ok(startSubmit.indexOf('confirmPortalCompatibilityOverride') < startSubmit.indexOf('confirmLiveSubmission'),
  'Continue Anyway must lead to the normal live acknowledgement flow');
assert.match(startSubmit, /portalCompatibilityOverride = await confirmPortalCompatibilityOverride\(\)/);
assert.match(startSubmit, /buildSubmitOnlyOptions\(\{ liveSubmissionConfirmed, canaryMode, portalCompatibilityOverride \}\)/);
assert.doesNotMatch(startSubmit, /runSiteHealth/, 'live mode must not require an automatic workflow health check');
assert.match(main, /!compatibilityGate\.ok && !options\.portalCompatibilityOverride/,
  'main process must require a validated explicit override for an unverified live run');
assert.match(preflight, /'portal-compatibility'[\s\S]*?severity: 'warning'/,
  'portal compatibility must be advisory rather than a blocking preflight check');

assert.match(html, /id="claimQueueList"[^>]*aria-live="polite"[\s\S]*?step3\.queue\.refreshEmpty/,
  'missing candidates must remain an inline queue state');
assert.match(renderer, /runButton\.disabled = executable < 1 \|\| state\.isolatedTestMode === true/,
  'submission may be disabled only when no executable candidate exists or isolated test mode is active');

for (const key of [
  'step3.compatibility.message.notChecked', 'step3.compatibility.message.stale',
  'step3.compatibility.message.incompatible', 'step3.compatibility.override.risk',
  'step3.compatibility.continueAnyway'
]) {
  assert.ok(english[key]);
  assert.ok(french[key]);
  assert.notStrictEqual(english[key], french[key], `${key} must switch dynamically between English and French`);
}
assert.strictEqual(french['step3.compatibility.message.notChecked'], 'La compatibilité du portail n’a pas été vérifiée.');
assert.strictEqual(french['step3.compatibility.continueAnyway'], 'Continuer quand même');

for (const [sourceText, pattern, safeguard] of [
  [queueService, /already_submitted|submitted/, 'submitted-record and duplicate blocking'],
  [queueService, /reconciliation_required|unresolved_attempt/, 'reconciliation blocking'],
  [queueService, /evidenceHash|evidence_hash/, 'evidence-hash validation'],
  [queueService, /promoted|sourceRunId|source_run_id/, 'promoted Step 2 authority'],
  [queueService, /createRunSnapshot/, 'immutable execution snapshots'],
  [submitWorker, /CAPTCHA/, 'CAPTCHA pause'],
  [submitWorker, /Never retry the financially significant action/, 'uncertain-final-action no-retry protection'],
  [main, /requestNativeAuthorization/, 'native final confirmation'],
  [main, /MAX_CLAIMS: effectiveCanaryMode \? '1' : ''/, 'one-record canary limit'],
  [main, /persist:canadapost-claims-builtin/, 'browser-session isolation']
]) assert.match(sourceText, pattern, `${safeguard} must remain intact`);

process.stdout.write('Workflow navigation and advisory-only compatibility tests passed.\n');
