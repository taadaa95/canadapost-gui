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

  const frenchCalls = [];
  const frenchMessages = {
    'dialog.liveSubmit.canaryAction': 'Lancer 1 réclamation réelle comme essai canari',
    'dialog.liveSubmit.canaryMessage': 'Lancer une vraie réclamation Canada Post comme essai canari?',
    'dialog.liveSubmit.title': 'Confirmation finale de soumission réelle',
    'dialog.liveSubmit.detail': 'Confirmation française distincte.',
    'action.cancel': 'Annuler'
  };
  await requestNativeAuthorization({
    dialog: { showMessageBox: async (...args) => { frenchCalls.push(args); return { response: 0 }; } },
    selectedCount: 1,
    requestedCount: 1,
    canaryMode: true,
    localize: (key, values, fallback) => String(frenchMessages[key] || fallback).replace('{count}', String(values?.count || ''))
  });
  assert.strictEqual(frenchCalls[0][1].title, 'Confirmation finale de soumission réelle');
  assert.strictEqual(frenchCalls[0][1].buttons[0], 'Annuler');
  assert.match(frenchCalls[0][1].message, /Lancer une vraie réclamation/);
  assert.match(frenchCalls[0][1].buttons[1], /essai canari/);

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
