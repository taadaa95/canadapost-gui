'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isFinalSubmissionLabel } = require('../scripts/submit-claims');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  assert(start >= 0, `${name} must exist`);
  const end = nextName ? source.indexOf(`async function ${nextName}`, start + 1) : source.length;
  assert(end > start, `${name} source boundary must exist`);
  return source.slice(start, end);
}

function main() {
  assert.strictEqual(isFinalSubmissionLabel('Create Ticket'), true);
  assert.strictEqual(isFinalSubmissionLabel('Submit claim'), true);
  assert.strictEqual(isFinalSubmissionLabel('Send request'), true);
  assert.strictEqual(isFinalSubmissionLabel('Confirm'), true);
  assert.strictEqual(isFinalSubmissionLabel('Complete submission'), true);
  assert.strictEqual(isFinalSubmissionLabel('Continue'), false);
  assert.strictEqual(isFinalSubmissionLabel('Open a ticket'), false, 'launcher navigation must not be treated as final submission');

  const root = path.resolve(__dirname, '..');
  const submitSource = fs.readFileSync(path.join(root, 'scripts', 'submit-claims.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const englishLocale = fs.readFileSync(path.join(root, 'locales', 'en-CA.json'), 'utf8');

  const fillClaim = functionSource(submitSource, 'fillClaim', 'findCreateTicketControl');
  const dryReturnIndex = fillClaim.indexOf("if (dryRun) {");
  assert(dryReturnIndex >= 0, 'dry run must stop on the sender/contact page');
  const afterDryReturn = fillClaim.slice(dryReturnIndex);
  assert.strictEqual(afterDryReturn.match(/await clickVisibleContinue\(claimPage\);/g)?.length, 2,
    'live mode may use at most two guarded review transitions');
  assert.match(afterDryReturn, /findCreateTicketControl\(claimPage, 1800\)/,
    'live mode must check for the final control before a second Continue');
  assert.strictEqual(fillClaim.slice(0, dryReturnIndex).match(/await clickVisibleContinue\(claimPage\);/g)?.length, 2,
    'dry run may only traverse the two non-final claim setup transitions');
  assert.match(fillClaim, /reference-page-ready/, 'reference diagnostics must be captured after the reference field is ready');
  assert.match(fillClaim, /sender-contact-page-ready/, 'sender diagnostics must be captured after the sender field is ready');
  assert.match(fillClaim, /CreateTicket:receiverPostalCode/, 'known Canada Post receiver field IDs should be preferred');
  assert.match(fillClaim, /claimAddressAndContacts:userAddress:streetNumber/, 'known Canada Post sender field IDs should be preferred');
  assert.doesNotMatch(fillClaim, /findTextboxControl\(claimPage, referencePattern, 500\)/,
    'the runner must not spend time probing for the next page before the first Continue');
  assert.doesNotMatch(fillClaim, /findTextboxControl\(claimPage, streetNumberPattern, 500\)/,
    'the runner must not spend time probing for the next page before the second Continue');

  assert.match(submitSource, /installDryRunFinalActionGuard/);
  assert.match(submitSource, /__cpDryRunBlockedActions/);
  assert.match(submitSource, /resetToTicketLauncher/);
  assert.match(submitSource, /waitForClaimFormReady/);
  assert.match(submitSource, /findReceiverCountryControl/);
  assert.doesNotMatch(submitSource, /getByLabel\(\/Receiver'\?s country\/i\)\.first\(\)\.selectOption/);
  assert.match(submitSource, /BUILTIN_BROWSER_REQUIRED/);
  assert.doesNotMatch(submitSource, /launchPersistentContext|launchClaimContext|browser-profile-temp/);
  assert.match(submitSource, /require\('playwright-core'\)/);
  assert.match(mainSource, /BETWEEN_CLAIMS_MS: String\(options\.betweenClaimsMs \|\| 750\)/);
  assert.match(rendererSource, /step3\.dryRunStarting/);
  assert.match(englishLocale, /stopping before final review\/submission/);
  assert.match(htmlSource, /data-i18n="step3\.dryRun"/);
  assert.match(englishLocale, /"step3\.dryRun": "Dry run — fill fields only; stop before final review or submission"/);

  console.log('Step 3 dry-run and multi-claim regression tests passed.');
}

main();
