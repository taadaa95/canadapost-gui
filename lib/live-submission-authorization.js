'use strict';

function validCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10000) throw new Error(`${label} is invalid.`);
  return count;
}

async function requestNativeAuthorization({
  dialog,
  parent,
  selectedCount,
  requestedCount,
  canaryMode = false,
  localize = (_key, values = {}, fallback = '') => String(fallback).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match)
}) {
  if (!dialog || typeof dialog.showMessageBox !== 'function') throw new TypeError('A native confirmation dialog is required.');
  const selected = validCount(selectedCount, 'Selected live-claim count');
  const requested = validCount(requestedCount, 'Requested live-claim count');
  if (canaryMode && selected !== 1) throw new Error('A live canary must contain exactly one claim.');
  if (!canaryMode && selected !== requested) throw new Error('The native confirmation count does not match the reviewed selection.');

  const action = canaryMode
    ? localize('dialog.liveSubmit.canaryAction', {}, 'Start 1 live canary claim')
    : localize('dialog.liveSubmit.action', { count: selected }, 'Start {count} live claims');
  const result = await dialog.showMessageBox(parent || undefined, {
    type: 'warning',
    title: localize('dialog.liveSubmit.title', {}, 'Final live-submission confirmation'),
    message: canaryMode
      ? localize('dialog.liveSubmit.canaryMessage', {}, 'Start one real Canada Post claim as a canary?')
      : localize('dialog.liveSubmit.message', { count: selected }, 'Start {count} real Canada Post claims?'),
    detail: localize('dialog.liveSubmit.detail', {}, 'This native confirmation is separate from the in-app review. Claims may have financial and duplicate-submission consequences. Choose Cancel if the count or mode is unexpected.'),
    buttons: [localize('action.cancel', {}, 'Cancel'), action],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return result?.response === 1;
}

module.exports = { requestNativeAuthorization };
