'use strict';

const patterns = Object.freeze({
  duplicate: [
    /inquiry of this type already exists/i, /already received a refund request/i,
    /refund request for this package/i, /refund request.*already.*(?:received|submitted|exists)/i,
    /(?:claim|inquiry|request).*already.*(?:exists|submitted|received)/i,
    /already.*(?:claim|inquiry|refund request).*tracking number/i
  ],
  success: [
    /(?:service\s*)?ticket\s*(?:number|#)\s*[:#]?\s*[a-z0-9-]{4,}/i,
    /confirmation\s*(?:number|#)\s*[:#]?\s*[a-z0-9-]{4,}/i,
    /your\s+(?:service\s*)?ticket\s+(?:has been|was)\s+(?:created|submitted|received)/i,
    /thank you[^.]{0,160}(?:request|ticket|inquiry)[^.]{0,120}(?:submitted|received|created)/i,
    /(?:request|inquiry)[^.]{0,120}(?:has been|was)\s+(?:submitted|received|created)/i
  ],
  failure: [
    /there (?:is|are) (?:an? )?(?:error|errors) on (?:the|this) page/i,
    /(?:unable|not able) to (?:create|submit|process)/i, /(?:cannot|can not|can't) (?:create|submit|process)/i,
    /not eligible/i, /something went wrong/i, /please give us a call/i, /try again later/i,
    /technical (?:error|problem|issue)/i
  ],
  rejection: [/not eligible/i, /does not qualify/i, /ineligible/i, /request (?:was|has been) (?:declined|rejected)/i, /claim (?:was|has been) (?:declined|rejected)/i]
});

const oneLine = value => String(value || '').replace(/\s+/g, ' ').trim();
const matches = (text, values) => values.some(pattern => pattern.test(text));

function extractConfirmationNumber(text) {
  const source = String(text || '');
  for (const pattern of [
    /(?:service\s*)?ticket\s*(?:number|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})/i,
    /confirmation\s*(?:number|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})/i
  ]) {
    const match = source.match(pattern);
    if (match?.[1] && !/^(?:has|been|created|submitted|received)$/i.test(match[1])) return match[1];
  }
  return '';
}

function classifyAutomationFailure(error, text = '', url = '') {
  const explicitCode = String(error?.code || '');
  const message = String(error?.message || error || 'Unknown automation failure');
  const combined = `${message} ${text}`;
  const explicit = {
    STOP_REQUESTED: ['STOP_REQUESTED', 'unknown'], INCORRECT_CREDENTIALS: ['INCORRECT_CREDENTIALS', 'failed'],
    AUTHENTICATION_NOT_COMPLETED: ['AUTHENTICATION_NOT_COMPLETED', 'unknown'], AUTHENTICATION_EXPIRED: ['AUTHENTICATION_EXPIRED', 'unknown'],
    AUTHENTICATION_VERIFICATION_TIMEOUT: ['AUTHENTICATION_VERIFICATION_TIMEOUT', 'unknown'], CAPTCHA_TIMEOUT: ['CAPTCHA_TIMEOUT', 'unknown'],
    UNEXPECTED_LAYOUT: ['UNEXPECTED_LAYOUT', 'unknown'], CLAIM_FORM_NOT_READY: ['CLAIM_FORM_NOT_READY', 'failed'],
    COUNTRY_SELECTION_FAILED: ['COUNTRY_SELECTION_FAILED', 'failed'], DRY_RUN_SAFETY_BLOCK: ['DRY_RUN_SAFETY_BLOCK', 'unknown'],
    FINAL_ACTION_GUARD: ['FINAL_ACTION_GUARD', 'unknown'], CLAIM_NAVIGATION_CHANGED: ['CLAIM_NAVIGATION_CHANGED', 'failed'],
    CLAIM_NAVIGATION_STALLED: ['CLAIM_NAVIGATION_STALLED', 'failed'], CLAIM_TICKET_LAUNCHER_NOT_FOUND: ['CLAIM_TICKET_LAUNCHER_NOT_FOUND', 'failed']
  };
  if (explicit[explicitCode]) return { errorCode: explicit[explicitCode][0], status: explicit[explicitCode][1] };
  if (/incorrect|invalid|unable to sign in|authentication failed/i.test(combined) && /username|password|sign in/i.test(combined)) return { errorCode: 'INCORRECT_CREDENTIALS', status: 'failed' };
  if (/temporarily unavailable|service unavailable|maintenance|technical difficulties|try again later|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(combined)) return { errorCode: 'TEMPORARY_OUTAGE', status: 'failed' };
  if (/claim navigation|ticket launcher|late package ticket|late-delivery support page/i.test(message)) return { errorCode: 'CLAIM_NAVIGATION_CHANGED', status: 'failed' };
  if (/captcha|verify you are human|i'?m not a robot/i.test(combined)) return { errorCode: 'CAPTCHA_PENDING', status: 'unknown' };
  if (/verification code|text verification|security code/i.test(combined)) return { errorCode: 'AUTHENTICATION_VERIFICATION_REQUIRED', status: 'unknown' };
  if (matches(combined, patterns.rejection)) return { errorCode: 'CLAIM_REJECTED', status: 'rejected' };
  if (/validation|already exists|already received a refund request/i.test(combined)) return { errorCode: 'KNOWN_VALIDATION_ERROR', status: 'failed' };
  if (/locator|selector|strict mode|waiting for|getByRole|getByLabel|not found|could not click/i.test(combined)) return { errorCode: 'SELECTOR_MISSING', status: 'failed' };
  if (/login|sign in|session|authentication/i.test(combined) || /\/login/i.test(String(url || ''))) return { errorCode: 'AUTHENTICATION_EXPIRED', status: 'unknown' };
  if (/outside the allowed Canada Post domain|unexpected page|layout/i.test(combined)) return { errorCode: 'UNEXPECTED_LAYOUT', status: 'unknown' };
  return { errorCode: 'AUTOMATION_FAILURE', status: 'failed' };
}

function classifyClaimOutcome(text) {
  const source = String(text || '');
  if (matches(source, patterns.duplicate)) return { status: 'already_submitted', ok: false, message: 'Claim already submitted: Canada Post says an inquiry/refund request already exists for this tracking number.', errorCode: 'DUPLICATE_CLAIM' };
  if (matches(source, patterns.rejection)) return { status: 'rejected', ok: false, message: 'Canada Post rejected the claim as ineligible.', reason: oneLine(source).slice(0, 2000), errorCode: 'CLAIM_REJECTED', businessOutcome: true };
  if (matches(source, patterns.failure)) return { status: 'failed', ok: false, message: 'Canada Post displayed a submission error after Create Ticket.', errorCode: 'SUBMISSION_ERROR' };
  const confirmationNumber = extractConfirmationNumber(source);
  if (confirmationNumber) return { status: 'submitted', ok: true, message: 'Canada Post accepted the claim and displayed a confirmation/ticket number.', confirmationNumber };
  if (matches(source, patterns.success)) return { status: 'unknown', ok: false, message: 'Canada Post displayed success-like text but no confirmation/ticket number was captured. Manual reconciliation is required.', errorCode: 'CONFIRMATION_NUMBER_MISSING' };
  return null;
}

function summarizeClaimResults(results = []) {
  const values = Array.isArray(results) ? results : [];
  const count = status => values.filter(result => result.status === status).length;
  const succeeded = count('submitted'); const dryRunReady = count('dry_run_ready');
  const alreadySubmitted = count('already_submitted'); const rejected = count('rejected');
  const failed = values.filter(result => !['submitted', 'dry_run_ready', 'already_submitted', 'rejected'].includes(result.status)).length;
  return { total: values.length, succeeded, dryRunReady, alreadySubmitted, rejected, failed };
}

module.exports = { patterns, extractConfirmationNumber, classifyAutomationFailure, classifyClaimOutcome, summarizeClaimResults };
