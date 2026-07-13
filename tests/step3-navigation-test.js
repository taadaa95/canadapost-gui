'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { claimNavigationUrlContext, stageOrderForPage } = require('../lib/canadapost-navigation');
const { classifyAutomationFailure, finishCli } = require('../scripts/submit-claims');

assert.strictEqual(
  claimNavigationUrlContext('https://www.canadapost-postescanada.ca/cpc/en/support/kb/claims/late-packages.page'),
  'late-page'
);
assert.strictEqual(
  claimNavigationUrlContext('https://www.canadapost-postescanada.ca/cpc/en/support.page'),
  'support-page'
);
assert.deepStrictEqual(
  stageOrderForPage({ url: () => 'https://www.canadapost-postescanada.ca/cpc/en/support/kb/claims/late-packages.page' }),
  ['ticket'],
  'the late-package article must never fall back to Support or Late breadcrumb controls'
);
assert.deepStrictEqual(
  stageOrderForPage({ url: () => 'https://www.canadapost-postescanada.ca/businesshome-boutiquedaffaires/en/' }),
  ['ticket', 'support']
);

assert.deepStrictEqual(
  classifyAutomationFailure(new Error('Canada Post claim navigation did not reach the ticket launcher.'), 'reCAPTCHA footer text', ''),
  { errorCode: 'CLAIM_NAVIGATION_CHANGED', status: 'failed' },
  'navigation failures must not be mislabeled as CAPTCHA'
);
const explicit = new Error('stalled');
explicit.code = 'CLAIM_NAVIGATION_STALLED';
assert.deepStrictEqual(
  classifyAutomationFailure(explicit, 'captcha', ''),
  { errorCode: 'CLAIM_NAVIGATION_STALLED', status: 'failed' }
);

const submitSource = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'submit-claims.js'), 'utf8');
assert.match(submitSource, /LATE_PACKAGE_SUPPORT_URL/);
assert.match(submitSource, /canonical-route-ready/);
assert.match(submitSource, /claimNavigationUrlContext\(page\.url\(\)\) === 'late-page'/);
assert.match(submitSource, /\.finally\(\(\) => finishCli\(\)\)/);

const originalExitCode = process.exitCode;
process.exitCode = 1;
let flushed = false;
let exited = null;
finishCli(code => { exited = code; }, {
  write(value, callback) {
    assert.strictEqual(value, '');
    flushed = true;
    callback();
  }
});
assert.strictEqual(flushed, true);
assert.strictEqual(exited, 1);
process.exitCode = originalExitCode;

console.log('Step 3 navigation stability tests passed.');
