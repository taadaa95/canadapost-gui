'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'cpcr-sbom-'));
try {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'generate-sbom.js'), output]);
  const sbom = JSON.parse(fs.readFileSync(path.join(output, 'sbom.cyclonedx.json'), 'utf8'));
  const licences = JSON.parse(fs.readFileSync(path.join(output, 'dependency-licenses.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const expected = Object.entries(lock.packages)
    .filter(([location, info]) => location.startsWith('node_modules/') && info.dev !== true)
    .map(([location, info]) => `${location.replace(/^.*node_modules\//, '')}@${info.version || ''}`);
  const actual = sbom.components.map(item => `${item.name}@${item.version}`);

  assert.strictEqual(actual.length, expected.length, 'SBOM must contain exactly the production dependency entries from the lockfile');
  assert(sbom.components.some(item => item.name === 'playwright-core'));
  for (const developmentOnly of ['electron', 'electron-builder', 'eslint', 'playwright']) {
    assert(!sbom.components.some(item => item.name === developmentOnly), `${developmentOnly} must not be represented as a packaged dependency`);
  }
  assert.deepStrictEqual(
    licences.dependencies.map(item => `${item.name}@${item.version}`),
    actual,
    'licence inventory and SBOM must describe the same production dependency set'
  );
} finally {
  fs.rmSync(output, { recursive: true, force: true });
}

process.stdout.write('Production SBOM dependency-set tests passed.\n');
