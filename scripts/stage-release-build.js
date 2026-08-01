#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertCleanGit, trackedFiles, auditFileList } = require('../lib/release-safety');
const root = path.resolve(__dirname, '..');
assertCleanGit(root);
const files = trackedFiles(root);
const audit = auditFileList(files.filter(file => file !== 'electron-builder.yml' && file !== 'eslint.config.js' && file !== '.prettierignore'));
if (!audit.ok) throw new Error(`Release staging rejected source paths: ${[...audit.prohibited, ...audit.unexpected].join(', ')}`);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-package-stage-'));
try {
  for (const relative of files) {
    const destination = path.join(stage, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(root, relative), destination);
  }
  const env = { ...process.env, RELEASE_CHANNEL: process.env.RELEASE_CHANNEL || 'beta' };
  for (const [command, args] of [['npm', ['ci']], ['npm', ['test']], ['npm', ['run', 'lint']], ['npm', ['run', 'typecheck']], ['npm', ['run', 'sbom']], ['npx', ['electron-builder', '--linux', 'AppImage', '--x64']], ['npm', ['run', 'package:audit', '--', 'dist/packages/linux-unpacked']], ['npm', ['run', 'release:finalize']]]) {
    const result = spawnSync(command, args, { cwd: stage, env, stdio: 'inherit' }); if (result.status !== 0) process.exit(result.status || 1);
  }
  const sourceOutput = path.join(stage, 'dist', 'packages');
  const destinationOutput = path.join(root, 'dist', 'packages');
  fs.mkdirSync(destinationOutput, { recursive: true });
  fs.cpSync(sourceOutput, destinationOutput, { recursive: true });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
