#!/usr/bin/env node
'use strict';

const path = require('path');
const { assertReleaseGitState } = require('../lib/release-safety');

const root = path.resolve(__dirname, '..');
const identity = assertReleaseGitState(root);
process.stdout.write(`Stable release guard passed for ${identity.branch} at ${identity.commit}.\n`);
