'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const setup = require('../renderer/setup-assistant');

assert.strictEqual(
  setup.shouldPreserveConfirmedBusinessProgress('create-app', 'BUSINESS_SELECTION', true),
  true,
  'a transient business-selection classification must not send a confirmed user back to the business step while creating an app'
);
assert.strictEqual(
  setup.shouldPreserveConfirmedBusinessProgress('business', 'BUSINESS_SELECTION', true),
  false,
  'the initial business-selection step must still be shown normally'
);
assert.strictEqual(
  setup.shouldPreserveConfirmedBusinessProgress('create-app', 'BUSINESS_SELECTION', false),
  false,
  'business selection must not be suppressed before a business is confirmed'
);
assert.strictEqual(
  setup.shouldPreserveConfirmedBusinessProgress('create-app', 'CREATE_APP', true),
  false,
  'normal create-app classifications must continue to drive adaptive guidance'
);

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'setup-assistant.js'), 'utf8');
const saveAndFinish = /async function saveAndFinish[\s\S]*?function pageStateChanged/.exec(source)?.[0] || '';
assert.match(saveAndFinish, /trackingApiClientSecret:\s*String\(current\.trackingApiClientSecret\)\.trim\(\)/, 'Save & Finish normalizes the pasted API secret before saving');
assert.match(saveAndFinish, /result\.trackingApiCredentialsStored !== true/, 'Save & Finish refuses to complete unless the credential write reports the pair as stored');
assert.match(saveAndFinish, /await api\.loadConfig\(\)/, 'Save & Finish re-reads sanitized config after writing credentials');
assert.match(saveAndFinish, /persisted\?\.trackingApiCredentialsStored !== true/, 'Save & Finish refuses to close if the post-save config cannot verify stored Tracking API credentials');

assert.match(source, /data-settings-status-tone/, 'Settings status is segmented so saved and missing credential states can have separate semantic colors');
assert.match(source, /querySelector\?\.\('\[data-settings-status-tone\]'\)/, 'Settings status observer recognizes its own segmented output and does not recurse');

console.log('Windows guided setup regression tests passed.');
