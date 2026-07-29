'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const tests = [
  'tracking-normalizer-test.js', 'policy-engine-test.js', 'claim-queue-test.js',
  'encrypted-backup-test.js', 'financial-report-test.js', 'product-readiness-test.js', 'localization-test.js'
];
for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(__dirname, test)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
