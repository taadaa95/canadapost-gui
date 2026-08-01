'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PRODUCT_METADATA } = require('../lib/product-metadata');
const { expectedBinaryName } = require('../scripts/finalize-artifacts');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const guide = read('BETA_OPERATING_GUIDE.md');
const readme = read('README.md');
const html = read('index.html');
const renderer = read('renderer.js');

assert.strictEqual(require('../package.json').version, PRODUCT_METADATA.applicationVersion);
for (const document of [guide, readme]) {
  assert.ok(document.includes(PRODUCT_METADATA.applicationVersion), 'Current documentation must identify the package version.');
}
assert.ok(html.includes(`id="appVersion">${PRODUCT_METADATA.applicationVersion}<`));
assert.ok(renderer.includes(`cfg.appVersion || '${PRODUCT_METADATA.applicationVersion}'`));

const currentValues = [
  PRODUCT_METADATA.databaseSchemaVersion,
  PRODUCT_METADATA.estImportSchemaVersion,
  PRODUCT_METADATA.trackingApiVersion,
  PRODUCT_METADATA.trackingParserVersion,
  PRODUCT_METADATA.trackingRequestIntervalMs,
  PRODUCT_METADATA.trackingJitterMaxMs,
  PRODUCT_METADATA.trackingEnvironments.test,
  PRODUCT_METADATA.trackingEnvironments.production
];
for (const value of currentValues) assert.ok(guide.includes(String(value)), `Beta guide is missing current metadata value ${value}.`);

for (const platform of ['linux', 'windows']) {
  const artifact = expectedBinaryName({ version: PRODUCT_METADATA.applicationVersion, platform, channel: PRODUCT_METADATA.releaseChannel });
  assert.ok(guide.includes(artifact), `Beta guide is missing canonical ${platform} artifact name.`);
}

assert.doesNotMatch(guide, /0\.4\.0-dev|est-import-v[1-4]|schema version 7|3,?000 ms/i);
assert.match(read('RELEASE_NOTES.md'), /historical.+not current operator/is);
assert.match(read('AUTONOMOUS_PROGRESS.md'), /historical.+not an operating guide/is);

process.stdout.write('Current documentation and product metadata are consistent.\n');
