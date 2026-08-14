#!/usr/bin/env node
'use strict';

const path = require('path');
const { trackedFiles, auditFileList } = require('../lib/release-safety');
const { scanPaths } = require('../lib/secret-scanner');

const root = path.resolve(__dirname, '..');
const files = trackedFiles(root);
const audit = auditFileList(files);
const findings = scanPaths(root, files);
if (!audit.ok || findings.length) {
  if (audit.prohibited.length) process.stderr.write(`Prohibited release paths: ${audit.prohibited.join(', ')}\n`);
  if (audit.unexpected.length) process.stderr.write(`Unexpected release paths: ${audit.unexpected.join(', ')}\n`);
  findings.forEach(item => process.stderr.write(`${item.path}:${item.line} ${item.rule} ${item.redacted}\n`));
  process.exit(1);
}
process.stdout.write(`Release source audit passed for ${files.length} tracked allowlisted files.\n`);
