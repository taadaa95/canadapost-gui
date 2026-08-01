'use strict';

function automationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertNeverRetryUncertainFinalAction(outcome) {
  if (outcome?.finalActionDispatched === true && !['submitted', 'already_submitted', 'rejected'].includes(outcome.status)) {
    const error = automationError('RECONCILIATION_REQUIRED', 'The final action outcome is uncertain and must never be retried automatically.');
    error.reconciliationRequired = true;
    throw error;
  }
  return true;
}

module.exports = { automationError, assertNeverRetryUncertainFinalAction };
