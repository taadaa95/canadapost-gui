#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { scanPaths } = require('../lib/secret-scanner');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
let candidates;
try {
  candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
    .toString('utf8').split('\0').filter(Boolean);
} catch (_) {
  candidates = undefined;
}
const findings = scanPaths(root, candidates);
if (findings.length) {
  process.stderr.write(`Secret scan failed with ${findings.length} redacted finding(s).\n`);
  for (const finding of findings) process.stderr.write(`${finding.path}:${finding.line} ${finding.rule} ${finding.redacted}\n`);
  process.exit(1);
}
process.stdout.write('Secret scan passed; no likely secrets found in scanned source files.\n');
