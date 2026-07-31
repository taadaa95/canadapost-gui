#!/usr/bin/env node
'use strict';

const path = require('path');
const { releasePlatform, releaseChannel, validateReleaseMetadata, reportIgnoredOutputs } = require('./finalize-artifacts');

const root = path.resolve(__dirname, '..');
const packageDir = path.resolve(process.argv[2] || path.join(root, 'dist', 'packages'));
const metadataDir = path.resolve(process.argv[3] || path.join(root, 'dist', 'release-metadata'));
const platform = releasePlatform();
const channel = releaseChannel();
const version = require('../package.json').version;
const result = validateReleaseMetadata({ packageDir, metadataDir, version, platform, channel });
reportIgnoredOutputs(result.ignoredOutputs);
process.stdout.write(`Publication-readiness validation passed for ${result.artifact.file} (${result.artifact.bytes} bytes, SHA-256 ${result.artifact.sha256}).\n`);
