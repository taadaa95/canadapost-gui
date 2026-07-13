'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const {
  classifyClaimOutcome,
  classifyAutomationFailure,
  extractConfirmationNumber,
  isCanadaPostUrl
} = require('../scripts/submit-claims');
const { readRuntimeSecrets } = require('../lib/runtime-secrets');

async function main() {
  assert.strictEqual(isCanadaPostUrl('https://www.canadapost-postescanada.ca/dash/en'), true);
  assert.strictEqual(isCanadaPostUrl('https://canadapost-postescanada.ca.evil.example/'), false);
  assert.strictEqual(isCanadaPostUrl('http://www.canadapost-postescanada.ca/dash/en'), false);

  assert.strictEqual(extractConfirmationNumber('Service ticket number: CP-1234567'), 'CP-1234567');
  assert.strictEqual(extractConfirmationNumber('Confirmation # ABCD-9988'), 'ABCD-9988');
  assert.strictEqual(extractConfirmationNumber('Reference Number 1 4437985733418118'), '');

  const submitted = classifyClaimOutcome('Thank you. Service ticket number: CP-1234567');
  assert.strictEqual(submitted.status, 'submitted');
  assert.strictEqual(submitted.confirmationNumber, 'CP-1234567');

  const missingNumber = classifyClaimOutcome('Thank you. Your service ticket has been created.');
  assert.strictEqual(missingNumber.status, 'unknown');
  assert.strictEqual(missingNumber.errorCode, 'CONFIRMATION_NUMBER_MISSING');

  const duplicate = classifyClaimOutcome('An inquiry of this type already exists for this tracking number.');
  assert.strictEqual(duplicate.status, 'already_submitted');
  assert.strictEqual(duplicate.errorCode, 'DUPLICATE_CLAIM');

  const failure = classifyClaimOutcome('Something went wrong. Please try again later.');
  assert.strictEqual(failure.status, 'failed');

  const stopped = classifyAutomationFailure(Object.assign(new Error('Stopped'), { code: 'STOP_REQUESTED' }));
  assert.deepStrictEqual(stopped, { errorCode: 'STOP_REQUESTED', status: 'unknown' });

  const protectedSecrets = await readRuntimeSecrets({
    env: { CANADAPOST_SECRETS_STDIN: '1' },
    stream: Readable.from([JSON.stringify({ username: 'protected-user', password: 'protected-pass' })])
  });
  assert.deepStrictEqual(protectedSecrets, { username: 'protected-user', password: 'protected-pass' });

  const legacySecrets = await readRuntimeSecrets({
    env: { CANADAPOST_USERNAME: 'legacy-user', CANADAPOST_PASSWORD: 'legacy-pass' },
    stream: Readable.from([])
  });
  assert.deepStrictEqual(legacySecrets, { username: 'legacy-user', password: 'legacy-pass' });

  const root = path.resolve(__dirname, '..');
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const submitSource = fs.readFileSync(path.join(root, 'scripts', 'submit-claims.js'), 'utf8');
  const healthSource = fs.readFileSync(path.join(root, 'scripts', 'site-health-check.js'), 'utf8');

  assert.match(mainSource, /setPermissionRequestHandler/);
  assert.match(mainSource, /setPermissionCheckHandler/);
  assert.match(mainSource, /will-download/);
  assert.match(mainSource, /BUILTIN_BROWSER_TARGET_TOKEN/);
  assert.match(mainSource, /stdinJson/);
  assert.match(mainSource, /process\.kill\(-child\.pid/);
  assert.match(mainSource, /render-process-gone/);
  assert.match(submitSource, /CANADAPOST_SECRETS_STDIN|readRuntimeSecrets/);
  assert.match(submitSource, /ELECTRON_TARGET_TOKEN/);
  assert.match(submitSource, /Raw HTML can/);
  assert.doesNotMatch(submitSource.match(/async function collectVisibleText[\s\S]*?\n}/)?.[0] || '', /page\.content\(/);
  assert.match(submitSource, /Never retry the financially significant action/);
  assert.match(healthSource, /readRuntimeSecrets/);
  assert.match(healthSource, /TARGET_TOKEN/);

  console.log('Step 3 browser hardening tests passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
