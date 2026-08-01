'use strict';

const assert = require('assert');
const { requestNativeAuthorization } = require('../lib/live-submission-authorization');

(async () => {
  const calls = [];
  const cancelled = await requestNativeAuthorization({
    dialog: { showMessageBox: async (...args) => { calls.push(args); return { response: 0 }; } },
    parent: { synthetic: true }, selectedCount: 3, requestedCount: 3, canaryMode: false
  });
  assert.strictEqual(cancelled, false);
  assert.strictEqual(calls[0][1].defaultId, 0);
  assert.strictEqual(calls[0][1].cancelId, 0);
  assert.match(calls[0][1].message, /3 real Canada Post claims/);

  const authorized = await requestNativeAuthorization({
    dialog: { showMessageBox: async (_parent, options) => {
      assert.match(options.buttons[1], /1 live canary claim/);
      return { response: 1 };
    } },
    selectedCount: 1, requestedCount: 50, canaryMode: true
  });
  assert.strictEqual(authorized, true);
  await assert.rejects(() => requestNativeAuthorization({ dialog: { showMessageBox: async () => ({ response: 1 }) }, selectedCount: 2, requestedCount: 50, canaryMode: true }), /exactly one/);
  await assert.rejects(() => requestNativeAuthorization({ dialog: { showMessageBox: async () => ({ response: 1 }) }, selectedCount: 2, requestedCount: 3 }), /does not match/);
  process.stdout.write('Native live-submission authorization tests passed.\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
