'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const workflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'ci.yml'),
  'utf8'
);

assert.strictEqual(
  pkg.scripts['test:mock-portal'],
  'node tests/mock-portal-test.js && node tests/mock-portal-shutdown-test.js',
  'pure mock-portal tests must not launch Electron'
);
assert.strictEqual(
  pkg.scripts['test:step3-mock-visibility'],
  'node tests/step3-mock-visibility-e2e-test.js',
  'Electron visibility E2E must have a dedicated command'
);

const installSteps =
  workflow.match(/name: Install Electron runtime[\s\S]{0,120}npx install-electron --no/g) || [];
assert.strictEqual(
  installSteps.length,
  3,
  'test and both packaging jobs must preinstall the Electron runtime'
);
assert.match(
  workflow,
  /name: Step 3 mock visibility E2E[\s\S]{0,120}timeout-minutes: 8[\s\S]{0,120}npm run test:step3-mock-visibility/,
  'Electron visibility E2E must be isolated and bounded'
);
assert.match(
  workflow,
  /GITLEAKS_ENABLE_UPLOAD_ARTIFACT:\s*["']false["']/,
  'Gitleaks must not consume artifact storage for its SARIF report'
);

const requiredArtifactUploads =
  workflow.match(/if-no-files-found: error[\s\S]{0,60}retention-days: 7/g) || [];
assert.ok(
  requiredArtifactUploads.length >= 3,
  'required release artifacts must use bounded retention'
);

process.stdout.write(
  'Dev.10 Electron preinstall, E2E isolation, Gitleaks and artifact-retention contracts passed.\n'
);
