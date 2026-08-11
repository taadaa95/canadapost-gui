'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = source('index.html');
const renderer = source('renderer.js');
const main = source('main.js');
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

assert.match(html, /id="dryRun"[^>]*checked/, 'dry run must remain the default');
const startSubmit = renderer.match(/async function startSubmitOnly\(\)[\s\S]*?async function refreshConfig/)?.[0] || '';
assert.doesNotMatch(`${html}\n${renderer}\n${main}`, /portalCompatibility|portal-compatibility|runSiteHealth|siteHealth:run/,
  'health and portal-compatibility systems must be absent');
assert.doesNotMatch(html, /manualReviewList|manualReviewCountPill|Eligibility Manual Review/,
  'eligibility manual-review UI must be absent');
assert.match(html, /id="checkStep3BrowserSession"/, 'browser-session inspection must remain independent');
assert.match(startSubmit, /confirmLiveSubmission/);
assert.match(startSubmit, /buildSubmitOnlyOptions\(\{ liveSubmissionConfirmed, canaryMode \}\)/);

assert.match(html, /id="claimQueueList"[^>]*aria-live="polite"[\s\S]*?step3\.queue\.refreshEmpty/,
  'missing candidates must remain an inline queue state');
assert.match(renderer, /runButton\.disabled = executable < 1 \|\| state\.isolatedTestMode === true/,
  'submission may be disabled only when no executable candidate exists or isolated test mode is active');

for (const locale of [english, french]) {
  assert.strictEqual(Object.keys(locale).some(key => key.startsWith('step3.compatibility.') || key.startsWith('step3.portalValidation.')), false);
  assert.strictEqual(Object.keys(locale).some(key => key.startsWith('history.review.') || key.startsWith('history.manualReview')), false);
}

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

process.stdout.write('Workflow navigation and removed-feature safety tests passed.\n');
