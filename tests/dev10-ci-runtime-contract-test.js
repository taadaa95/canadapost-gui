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
  5,
  'test, three platform packaging jobs, and the pinned Windows transfer rebuild must preinstall Electron'
);
assert.match(
  workflow,
  /name: Step 3 mock visibility E2E \(Linux\)[\s\S]{0,180}runner\.os == 'Linux'[\s\S]{0,180}xvfb-run -a npm run test:step3-mock-visibility/,
  'Linux Electron visibility E2E must run under Xvfb'
);
assert.strictEqual((workflow.match(/npm run release:guard/g) || []).length, 3, 'all current platform package jobs must enforce the canonical clean source guard');
assert.strictEqual((workflow.match(/npm run release:provenance/g) || []).length, 4, 'all current packages and the pinned Windows rebuild must record provenance');
assert.match(workflow, /release-provenance-linux\.json/);
assert.match(workflow, /release-provenance-windows\.json/);
assert.match(workflow, /release-provenance-macos\.json/);
assert.match(workflow, /ci-transfer-linux-/);
assert.match(workflow, /ci-transfer-windows-/);
assert.match(workflow, /ci-transfer-macos-/);
assert.doesNotMatch(workflow, /RELEASE_CHANNEL|beta-unsigned|package-manifest/, 'stable CI packaging must not retain channel or custom-manifest machinery');
assert.match(workflow, /RELEASE_SOURCE_COMMIT:\s*\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
assert.match(
  workflow,
  /name: Step 3 mock visibility E2E \(Windows\)[\s\S]{0,180}runner\.os == 'Windows'[\s\S]{0,180}npm run test:step3-mock-visibility/,
  'Windows Electron visibility E2E must remain native and bounded'
);

const visibilityE2E = fs.readFileSync(
  path.join(root, 'tests', 'step3-mock-visibility-e2e-test.js'),
  'utf8'
);
assert.match(
  visibilityE2E,
  /global watchdog expired during \$\{currentPhase\}/,
  'Step 3 visibility E2E must identify the phase of a global timeout'
);
assert.match(
  visibilityE2E,
  /Hidden-slot submission rejection[\s\S]{0,80}45000/,
  'hidden-slot submission validation must be bounded'
);
assert.match(
  visibilityE2E,
  /Executable dry-run start[\s\S]{0,80}60000/,
  'executable dry-run start must be bounded'
);
assert.match(
  visibilityE2E,
  /waiting for verification browser display readiness[\s\S]{0,800}waitForFunction[\s\S]{0,800}placeholder\?\.hidden/,
  'verification assertions must wait for the native browser display to stabilize'
);
assert.match(
  visibilityE2E,
  /error\.step3Phase = currentPhase/,
  'cleanup must preserve the original failing E2E phase'
);
assert.match(
  visibilityE2E,
  /removeDirectoryWithRetries[\s\S]{0,500}maxRetries:\s*3/,
  'Windows temporary-directory cleanup must retry locked files without masking test failures'
);
assert.match(
  workflow,
  /GITLEAKS_ENABLE_UPLOAD_ARTIFACT:\s*["']false["']/,
  'Gitleaks must not consume artifact storage for its SARIF report'
);

assert.ok((workflow.match(/ci-transfer\.js pack/g) || []).length >= 3, 'platform validation must create verified chunked transfers when Actions artifact storage is unavailable');
assert.match(workflow, /node - pack \.ci-transfer/, 'the exact-source rebuild must use the current verified transfer script');
assert.ok((workflow.match(/refs\/heads\/\$tag/g) || []).length >= 4, 'manual dispatch transfers must use isolated temporary branches');
assert.doesNotMatch(workflow, /gh release create/, 'CI transfers must never create application releases');

process.stdout.write(
  'Dev.10 Electron preinstall, E2E isolation, Gitleaks and artifact-transfer contracts passed.\n'
);
