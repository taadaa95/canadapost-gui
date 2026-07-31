'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORBIDDEN_KEYS = /^(?:trackingNumber|fullTrackingNumber|sender|receiver|contact|name|address|email|phone|telephone|claimFormValues|credentials?|cookies?|tokens?|browserSession|filePath)$/i;

function sanitizeScope(scope = {}) {
  return {
    allRecords: scope.allRecords === true,
    trackingNumberCount: Math.max(0, Number(scope.trackingNumberCount || 0)),
    dateFrom: /^\d{4}-\d{2}-\d{2}$/.test(String(scope.dateFrom || '')) ? String(scope.dateFrom) : null,
    dateTo: /^\d{4}-\d{2}-\d{2}$/.test(String(scope.dateTo || '')) ? String(scope.dateTo) : null
  };
}

function assertReceiptSafe(value, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertReceiptSafe(item, [...trail, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key) && !['trackingNumberCount'].includes(key)) {
      throw new Error(`Deletion receipt contains a prohibited field at ${[...trail, key].join('.')}.`);
    }
    assertReceiptSafe(nested, [...trail, key]);
  }
}

function createDeletionReceipt(input = {}) {
  const receipt = {
    format: 'canadapost-claim-runner-deletion-receipt',
    version: 1,
    timestamp: new Date(input.timestamp || Date.now()).toISOString(),
    applicationVersion: String(input.applicationVersion || '').slice(0, 80),
    scope: sanitizeScope(input.scope),
    recordCounts: Object.fromEntries(Object.entries(input.recordCounts || {}).map(([key, value]) => [String(key).slice(0, 80), Math.max(0, Number(value || 0))])),
    status: ['success', 'failure'].includes(input.status) ? input.status : 'failure',
    integrityCheck: {
      integrity: String(input.integrityCheck?.integrity || 'not_run').slice(0, 80),
      foreignKeyViolations: Math.max(0, Number(input.integrityCheck?.foreignKeyViolations || 0)),
      referencedFilesRemoved: input.integrityCheck?.referencedFilesRemoved === true,
      unrelatedRecordsUnchanged: input.integrityCheck?.unrelatedRecordsUnchanged === true
    },
    operationId: String(input.operationId || crypto.randomUUID()).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80)
  };
  assertReceiptSafe(receipt);
  return receipt;
}

function writeDeletionReceipt(directory, receipt) {
  assertReceiptSafe(receipt);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch (_) {}
  const destination = path.join(directory, `deletion-receipt-${receipt.operationId}.json`);
  fs.writeFileSync(destination, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(destination, 0o600); } catch (_) {}
  return destination;
}

module.exports = { createDeletionReceipt, writeDeletionReceipt, assertReceiptSafe, sanitizeScope };
