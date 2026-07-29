#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { DELIVERY_STATES } = require('../lib/tracking-normalizer');
const { TRACKING_PARSER_VERSION } = require('../lib/tracking-json');
const { classifyEligibility } = require('../lib/policy-engine');
const { evaluateTrackingSemantics, SemanticCircuitBreaker } = require('../lib/tracking-semantics');
const { SequentialRateLimiter, normalizeDelayMs } = require('../lib/tracking-rate-limiter');
const { atomicPromoteTextFiles, validateTrackingStagingItem } = require('../lib/tracking-run-staging');
const {
  buildCanonicalShipment,
  sanitizeCanonicalShipment,
  buildClassificationInput,
  assertClassificationInvariant
} = require('../lib/normalized-shipment');
const { rowsAsObjects, stringifyCsv } = require('../lib/csv');
const { readRuntimeSecrets } = require('../lib/runtime-secrets');
const claimDb = require('../lib/claim-database');
const { TrackingClient, SystemicCircuitBreaker, redactedTracking, TRACKING_MODE, TRACKING_API_VERSION, TRACKING_SCOPE, DEFAULT_RESOURCE_TIMEOUT_MS, credentialMetadata, normalizeEnvironment, normalizeResourceTimeoutMs } = require('../lib/tracking-client');
const { normalizeEstShipmentDate } = require('../lib/est-import-schema');

function emit(type, payload = {}) { process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`); }
function value(row, names) { for (const name of names) if (String(row[name] || '').trim()) return String(row[name]).trim(); return ''; }
function normalizeTracking(value) { return String(value || '').replace(/\s+/g, '').toUpperCase().slice(0, 128); }
function deduplicateTrackingRows(rows) {
  const seen = new Set();
  const uniqueRows = [];
  let duplicateRows = 0;
  for (const row of rows) {
    const pin = normalizeTracking(value(row, ['Tracking PIN', 'Tracking Number', 'PIN', 'Tracking']));
    if (seen.has(pin)) { duplicateRows += 1; continue; }
    seen.add(pin);
    uniqueRows.push(row);
  }
  return { rows: uniqueRows, duplicateRows };
}
function validateTrackingCsvPolicyDates(rows) {
  const totalRows = Array.isArray(rows) ? rows.length : 0;
  const statuses = (rows || []).map(row => normalizeEstShipmentDate(value(row, ['Shipment Date', 'Ship Date'])));
  const missingShipmentDate = statuses.filter(item => item.status === 'missing').length;
  const invalidShipmentDate = statuses.filter(item => item.status === 'invalid').length;
  const missingTrackingPin = (rows || []).filter(row => !normalizeTracking(value(row, ['Tracking PIN', 'Tracking Number', 'PIN', 'Tracking']))).length;
  if (!totalRows || missingTrackingPin) {
    const error = new Error(`tracking.csv must contain a Tracking PIN on every row (${missingTrackingPin} missing; ${totalRows} total). No Tracking API request was made.`);
    error.code = 'TRACKING_PIN_MISSING';
    error.diagnostic = { totalRows, missingTrackingPin, missingShipmentDate, invalidShipmentDate, networkContacted: false };
    throw error;
  }
  return { totalRows, missingTrackingPin, missingShipmentDate, invalidShipmentDate, optionalMetadataWarnings: missingShipmentDate + invalidShipmentDate };
}

function sanitizedNormalizationEvidence(normalization) {
  return sanitizeCanonicalShipment(normalization);
}

const PRIMARY_TERMINAL_CATEGORIES = Object.freeze({
  LATE: 'late',
  ON_TIME: 'on_time',
  NOT_DELIVERED: 'not_delivered',
  DELIVERED_REVIEW: 'delivered_review',
  ERROR: 'error'
});

function createTerminalCounters() {
  return { checked: 0, late: 0, onTime: 0, notDelivered: 0, deliveredReview: 0, errors: 0 };
}

function recordTerminal(counters, category) {
  const field = { late: 'late', on_time: 'onTime', not_delivered: 'notDelivered', delivered_review: 'deliveredReview', error: 'errors' }[category];
  if (!field) throw new Error(`Unknown tracking terminal category: ${category}`);
  counters.checked += 1;
  counters[field] += 1;
  return counters;
}

function assertTerminalReconciliation(counters) {
  const reconciled = counters.late + counters.onTime + counters.notDelivered + counters.deliveredReview + counters.errors;
  if (reconciled !== counters.checked) throw new Error(`Tracking terminal counters do not reconcile (${reconciled} categories for ${counters.checked} checked).`);
  return true;
}

function claimSettings() {
  return {
    sender: {
      name: process.env.CLAIM_BUSINESS_NAME || process.env.CLAIM_CONTACT_NAME || '',
      address: [process.env.CLAIM_STREET_NUMBER, process.env.CLAIM_STREET_NAME, process.env.CLAIM_ADDRESS_LINE2].filter(Boolean).join(' '),
      city: process.env.CLAIM_CITY || '', province: process.env.CLAIM_PROVINCE || '', postalCode: process.env.CLAIM_POSTAL_CODE || ''
    },
    contact: { name: process.env.CLAIM_CONTACT_NAME || '', email: process.env.CLAIM_CONTACT_EMAIL || '', phone: process.env.CLAIM_CONTACT_PHONE || '' }
  };
}

function outputRow(input, classification, normalization) {
  const deliveryStatus = {
    state: normalization.normalizedStatus,
    label: normalization.normalizedStatusLabel,
    overdue: normalization.normalizedStatus !== DELIVERY_STATES.DELIVERED && Boolean(input.expectedDeliveryDate && input.expectedDeliveryDate < new Date().toISOString().slice(0, 10))
  };
  const status = classification.classification === 'LATE_CANDIDATE'
    ? (deliveryStatus.state === DELIVERY_STATES.DELIVERED
      ? 'LATE CANDIDATE - DELIVERED'
      : 'LATE CANDIDATE - DELIVERY ATTEMPTED')
    : `${classification.classification} - ${deliveryStatus.label.toUpperCase()}${deliveryStatus.overdue ? ' - OVERDUE' : ''}`;
  return {
    'Tracking PIN': input.trackingNumber,
    'Destination Postal Code': input.destinationPostalCode,
    'Expected Delivery Date': input.expectedDeliveryDate,
    'Original Delivery Standard Date': input.originalExpectedDeliveryDate,
    'Revised Expected Delivery Date': input.revisedExpectedDeliveryDate,
    'Expected Date Source': input.expectedDeliverySource,
    'Expected Date Selection Reason': input.expectedDeliverySelectionReason,
    'Revised Expected Delivery Reason': input.revisedExpectedDeliveryReason,
    'Actual Delivery Date': input.actualDeliveryDate,
    'Successful Delivery Timestamp': input.actualDeliveryAt,
    'Successful Delivery Event Identifier': input.actualDeliveryEventCode,
    'Successful Delivery Event Description': input.actualDeliveryDescription,
    'Successful Delivery Normalization Rule': input.actualDeliveryClassificationSource,
    'Successful Delivery Provenance': input.actualDeliveryProvenance,
    'Reference #': input.referenceNumber,
    'Service Code': input.serviceCode,
    Status: status,
    'Eligibility Reason': classification.explanation,
    'Shipment Date': input.shipmentDate,
    'First Attempt Date': input.firstAttemptDate,
    'First Attempt Timestamp': input.firstAttemptAt,
    'First Attempt Event Identifier': input.firstAttemptEventCode,
    'First Attempt Event Description': input.firstAttemptDescription,
    'First Attempt Normalization Rule': input.firstAttemptConfidence,
    'First Attempt Provenance': input.firstAttemptProvenance,
    'Destination Province': input.destinationProvince,
    'Business Days Late': classification.businessDaysLate ?? '',
    'Claim Submission Deadline': classification.claimSubmissionDeadline,
    'Business Days Remaining': classification.businessDaysRemaining ?? '',
    'Peak Period': classification.peakPeriodStatus.active ? classification.peakPeriodStatus.id : 'No',
    'Policy Version': classification.policyVersion,
    'Holiday Calendar Version': classification.holidayCalendarVersion,
    'Evidence Hash': classification.evidenceHash,
    'Classification Warnings': (classification.warningCodes || []).join('; '),
    'Normalized Evidence JSON': JSON.stringify(normalization)
  };
}

async function main() {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const trackingPath = path.resolve(process.env.TRACKING_CSV || path.join(dataDir, 'tracking.csv'));
  const claimsPath = path.resolve(process.env.CLAIMS_CSV || path.join(dataDir, 'claims.csv'));
  const overduePath = path.join(dataDir, 'overdue-undelivered.csv');
  const reviewPath = path.join(dataDir, 'eligibility-review.csv');
  const summaryPath = path.join(dataDir, 'tracking-run-summary.json');
  if (!fs.existsSync(trackingPath)) throw new Error('Tracking CSV is missing.');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const rows = rowsAsObjects(fs.readFileSync(trackingPath, 'utf8'));
  const inputQuality = validateTrackingCsvPolicyDates(rows);
  if (inputQuality.optionalMetadataWarnings) emit('tracking_input_warning', {
    reasonCode: 'OPTIONAL_EST_SHIPMENT_DATE_UNAVAILABLE',
    ...inputQuality,
    message: `${inputQuality.optionalMetadataWarnings} row(s) have missing or invalid optional EST Shipment Date enrichment. Tracking API lookup will continue.`
  });
  const deduplicated = deduplicateTrackingRows(rows);
  if (deduplicated.duplicateRows) emit('tracking_input_warning', {
    reasonCode: 'DUPLICATE_TRACKING_PIN_SKIPPED',
    duplicateRows: deduplicated.duplicateRows,
    sourceRows: rows.length,
    uniqueRows: deduplicated.rows.length,
    message: `${deduplicated.duplicateRows} duplicate tracking row(s) were skipped. Each normalized Tracking PIN is classified at most once.`
  });
  const credentials = await readRuntimeSecrets();
  const apiEnvironment = normalizeEnvironment(process.env.CANADAPOST_API_ENVIRONMENT || 'test');
  const credentialsMetadata = credentialMetadata(credentials, apiEnvironment);
  emit('tracking_credential_metadata', credentialsMetadata);
  if (!credentialsMetadata.clientId.present || !credentialsMetadata.clientSecret.present) throw new Error('Missing protected Tracking API client ID or client secret.');
  const mockBase = String(process.env.CANADAPOST_MOCK_BASE_URL || '').replace(/\/$/, '');
  const requestDelayMs = normalizeDelayMs(process.env.TRACKING_REQUEST_INTERVAL_MS);
  const mockNoWait = Boolean(mockBase) && process.env.TRACKING_RATE_LIMIT_DISABLE_WAIT === '1';
  const limiter = new SequentialRateLimiter({
    delayMs: requestDelayMs,
    sleep: mockNoWait ? async () => {} : undefined,
    onEvent: event => emit('tracking_protocol_stage', event)
  });
  const trackingClient = new TrackingClient({
    baseUrl: mockBase,
    tokenUrl: mockBase ? `${mockBase}/oauth2/token` : '',
    allowMock: Boolean(mockBase),
    onStage: stage => emit('tracking_protocol_stage', stage),
    resourceTimeoutMs: normalizeResourceTimeoutMs(process.env.TRACKING_RESOURCE_TIMEOUT_MS, DEFAULT_RESOURCE_TIMEOUT_MS),
    maxTimeoutRetries: 0,
    beforeResourceRetry: ({ signal }) => limiter.waitForRequestStart(signal)
  });
  const diagnosticMode = String(process.env.TRACKING_DIAGNOSTIC_MODE || '') === '1';
  const structureExport = String(process.env.TRACKING_STRUCTURE_EXPORT || '') === '1';
  const diagnosticRow = Number(process.env.TRACKING_DIAGNOSTIC_ROW || 1);
  if (diagnosticMode && process.env.TRACKING_DIAGNOSTIC_CONFIRM !== 'ONE_REQUEST_NO_STATE_CHANGE') {
    throw new Error('One-request diagnostic mode requires the explicit no-state-change confirmation token.');
  }
  if (diagnosticMode && (!Number.isInteger(diagnosticRow) || diagnosticRow < 1 || diagnosticRow > rows.length)) {
    throw new Error('Diagnostic tracking row selection is invalid.');
  }
  const selectedRows = diagnosticMode ? [rows[diagnosticRow - 1]] : deduplicated.rows;
  const cancellation = new AbortController();
  const cancellationPoll = process.env.STOP_FILE ? setInterval(() => {
    if (fs.existsSync(process.env.STOP_FILE)) cancellation.abort();
  }, 100) : null;
  cancellationPoll?.unref?.();
  const claims = [];
  const reviews = [];
  const overdue = [];
  const pendingDatabaseWrites = [];
  const terminalCounters = createTerminalCounters();
  let checked = 0;
  let errors = 0;
  let noData = 0;
  let circuitOpen = false;
  let semanticCircuitOpen = false;
  let stopped = false;
  let circuitDiagnostic = null;
  const breaker = new SystemicCircuitBreaker({ threshold: 3 });
  const semanticBreaker = new SemanticCircuitBreaker({ sampleSize: 3 });
  let invariantFailure = false;
  let invariantFailureMessage = '';
  emit('tracking_start', { total: selectedRows.length, sourceTotal: rows.length, deliverySource: `Developer Portal Tracking API ${TRACKING_API_VERSION}`, requestIntervalMs: requestDelayMs, jitterMaxMs: 100, concurrency: 1, diagnosticMode, structureExport, credentialMode: TRACKING_MODE, apiEnvironment, apiVersion: TRACKING_API_VERSION, parserVersion: TRACKING_PARSER_VERSION, scope: TRACKING_SCOPE });
  for (let index = 0; index < selectedRows.length; index += 1) {
    if (process.env.STOP_FILE && fs.existsSync(process.env.STOP_FILE)) { stopped = true; emit('tracking_stopped', { current: index, total: selectedRows.length }); break; }
    const row = selectedRows[index];
    const pin = normalizeTracking(value(row, ['Tracking PIN', 'Tracking Number', 'PIN', 'Tracking']));
    if (!pin) { emit('pin_skipped', { row: index + 1, message: 'Missing tracking PIN.' }); continue; }
    const safePin = redactedTracking(pin);
    try {
      const detailResponse = await limiter.run(
        () => trackingClient.getTracking(pin, credentials, { environment: apiEnvironment, includeSanitizedStructure: structureExport, signal: cancellation.signal }),
        { signal: cancellation.signal }
      );
      const detail = detailResponse.detail;
      breaker.success();
      const canonicalShipment = buildCanonicalShipment({ detail, row, trackingNumber: pin });
      const service = { recognized: Boolean(canonicalShipment.serviceCode), source: canonicalShipment.serviceProvenance, normalizedService: canonicalShipment.serviceName };
      const semantics = evaluateTrackingSemantics({ detail, service, canonicalShipment, stateModified: false });
      const classificationInput = buildClassificationInput(canonicalShipment, claimSettings());
      const classification = classifyEligibility(classificationInput);
      try {
        assertClassificationInvariant(canonicalShipment, classificationInput, classification, { semanticPassed: semantics.passed });
      } catch (error) {
        error.semanticValidation = semantics;
        error.classificationPreview = classification;
        throw error;
      }
      const diagnosticCanonicalShipment = sanitizeCanonicalShipment(canonicalShipment);
      const safeCanonicalShipment = sanitizeCanonicalShipment(canonicalShipment, { includeTrackingNumber: true, includePrivateMetadata: true });
      if (diagnosticMode) {
        let structureReportPath = '';
        if (structureExport) {
          structureReportPath = path.resolve(process.env.TRACKING_STRUCTURE_REPORT || path.join(dataDir, 'tracking-response-structure.json'));
          fs.writeFileSync(structureReportPath, `${JSON.stringify({
            ...detailResponse.structure,
            semanticValidation: semantics,
            canonicalShipment: diagnosticCanonicalShipment,
            classificationInputHash: classification.inputHash,
            classificationPreview: { classification: classification.classification, reasonCodes: classification.reasonCodes, missingEvidence: classification.missingEvidence },
            serviceResolution: { recognized: service.recognized, source: service.source },
            stateModified: false
          }, null, 2)}\n`, { mode: 0o600 });
        }
        emit('tracking_diagnostic', {
          ok: semantics.passed,
          tracking: safePin,
          status: detailResponse.status,
          contentType: String(detailResponse.headers?.get?.('content-type') || '').slice(0, 128),
          endpointFamily: 'developer-portal-tracking-v1',
          protocol: 'REST/JSON',
          credentialMode: TRACKING_MODE,
          apiVersion: TRACKING_API_VERSION,
          scope: TRACKING_SCOPE,
          archiveState: detail.archiveState,
          eventCount: detail.events.length,
          semanticValidation: semantics,
          canonicalShipment: diagnosticCanonicalShipment,
          classificationInputHash: classification.inputHash,
          classificationPreview: { classification: classification.classification, reasonCodes: classification.reasonCodes, missingEvidence: classification.missingEvidence },
          serviceResolution: { recognized: service.recognized, source: service.source, normalizedService: service.normalizedService },
          structureExported: structureExport,
          structureReportPath,
          stateModified: false
        });
        checked += 1;
        if (!semantics.passed) errors += 1;
        break;
      }
      const semanticCircuit = semanticBreaker.record(semantics);
      if (semanticCircuit.opened) {
        semanticCircuitOpen = true;
        emit('tracking_semantic_circuit_open', {
          message: 'Stopped — Tracking API responses were received, but required fields could not be normalized.',
          reason: semanticCircuit.reason,
          sampleCount: semanticCircuit.sampleCount,
          attempted: index + 1,
          total: rows.length,
          remaining: selectedRows.length - index - 1,
          queuePreserved: true,
          status: 'SEMANTIC_NORMALIZATION_FAILURE'
        });
      }
      const input = classificationInput;
      const output = outputRow(input, classification, safeCanonicalShipment);
      const stagedItem = validateTrackingStagingItem({ pin, canonicalShipment, rawEvents: [], classification, classificationInput });
      if (process.env.DATABASE_PATH) pendingDatabaseWrites.push(stagedItem);
      checked += 1;
      const overdueState = canonicalShipment.normalizedStatus !== DELIVERY_STATES.DELIVERED && Boolean(input.expectedDeliveryDate && input.expectedDeliveryDate < new Date().toISOString().slice(0, 10));
      if (overdueState) {
        recordTerminal(terminalCounters, PRIMARY_TERMINAL_CATEGORIES.NOT_DELIVERED);
        overdue.push(output);
        emit('pin_overdue', { pin: safePin, row: index + 1, terminal: true, primaryCategory: PRIMARY_TERMINAL_CATEGORIES.NOT_DELIVERED, expectedDate: input.expectedDeliveryDate, revisedExpectedDeliveryDate: input.revisedExpectedDeliveryDate, firstAttemptDate: input.firstAttemptDate, deliveryDate: input.actualDeliveryDate, deliveryState: canonicalShipment.normalizedStatus, deliveryStatus: canonicalShipment.normalizedStatusLabel, overdue: true, classification: 'OVERDUE', eligibilityReason: classification.explanation, classificationInputHash: classification.inputHash });
      } else if (classification.classification === 'LATE_CANDIDATE') {
        recordTerminal(terminalCounters, PRIMARY_TERMINAL_CATEGORIES.LATE);
        claims.push(output);
        emit('pin_late', { pin: safePin, row: index + 1, terminal: true, primaryCategory: PRIMARY_TERMINAL_CATEGORIES.LATE, expectedDate: input.expectedDeliveryDate, originalExpectedDeliveryDate: input.originalExpectedDeliveryDate, revisedExpectedDeliveryDate: input.revisedExpectedDeliveryDate, expectedDeliverySource: input.expectedDeliverySource, expectedDeliverySelectionReason: input.expectedDeliverySelectionReason, firstAttemptDate: input.firstAttemptDate, firstAttemptEventCode: input.firstAttemptEventCode, firstAttemptProvenance: input.firstAttemptProvenance, deliveryDate: input.actualDeliveryDate, deliveryEventCode: input.actualDeliveryEventCode, deliveryEventDescription: input.actualDeliveryDescription, deliveryEventNormalizationRule: input.actualDeliveryClassificationSource, deliveryEventProvenance: input.actualDeliveryProvenance, deliveryState: canonicalShipment.normalizedStatus, deliveryStatus: canonicalShipment.normalizedStatusLabel, serviceSource: service.source, classificationWarnings: classification.warningCodes, classification: classification.classification, eligibilityReason: classification.explanation, classificationInputHash: classification.inputHash });
      } else if (classification.classification === 'ON_TIME') {
        recordTerminal(terminalCounters, PRIMARY_TERMINAL_CATEGORIES.ON_TIME);
        emit('pin_on_time', { pin: safePin, row: index + 1, terminal: true, primaryCategory: PRIMARY_TERMINAL_CATEGORIES.ON_TIME, expectedDate: input.expectedDeliveryDate, revisedExpectedDeliveryDate: input.revisedExpectedDeliveryDate, firstAttemptDate: input.firstAttemptDate, deliveryDate: input.actualDeliveryDate, deliveryState: canonicalShipment.normalizedStatus, deliveryStatus: canonicalShipment.normalizedStatusLabel, classification: classification.classification, eligibilityReason: classification.explanation, classificationInputHash: classification.inputHash });
      } else {
        const primaryCategory = input.actualDeliveryDate ? PRIMARY_TERMINAL_CATEGORIES.DELIVERED_REVIEW : PRIMARY_TERMINAL_CATEGORIES.NOT_DELIVERED;
        recordTerminal(terminalCounters, primaryCategory);
        reviews.push(output);
        emit('pin_review_required', { pin: safePin, row: index + 1, terminal: true, primaryCategory, reviewRequired: true, classification: classification.classification, expectedDate: input.expectedDeliveryDate, revisedExpectedDeliveryDate: input.revisedExpectedDeliveryDate, firstAttemptDate: input.firstAttemptDate, deliveryDate: input.actualDeliveryDate, deliveryState: canonicalShipment.normalizedStatus, deliveryStatus: canonicalShipment.normalizedStatusLabel, overdue: overdueState, serviceSource: service.source, eligibilityReason: classification.explanation, classificationInputHash: classification.inputHash });
      }
    } catch (error) {
      if (['NORMALIZED_FIRST_ATTEMPT_LOST', 'EVIDENCE_HASH_MISMATCH', 'NORMALIZED_SHIPMENT_SCHEMA'].includes(error?.code)) {
        errors += 1;
        checked += 1;
        recordTerminal(terminalCounters, PRIMARY_TERMINAL_CATEGORIES.ERROR);
        invariantFailure = true;
        invariantFailureMessage = error.message;
        emit('tracking_invariant_failure', { pin: safePin, row: index + 1, terminal: true, primaryCategory: PRIMARY_TERMINAL_CATEGORIES.ERROR, message: error.message, code: error.code, missingEvidence: error.classificationPreview?.missingEvidence || error.details?.missingEvidence || [], queuePreserved: true });
        if (diagnosticMode) emit('tracking_diagnostic', { ok: false, tracking: safePin, semanticValidation: error.semanticValidation || null, classificationPreview: error.classificationPreview ? { classification: error.classificationPreview.classification, reasonCodes: error.classificationPreview.reasonCodes, missingEvidence: error.classificationPreview.missingEvidence } : null, diagnostic: { message: error.message, category: 'internal_invariant' }, stateModified: false });
        break;
      }
      if (cancellation.signal.aborted || error?.name === 'AbortError') {
        stopped = true;
        emit('tracking_stopped', { current: index, total: selectedRows.length, message: 'Cancellation completed without promoting staged state.' });
        break;
      }
      const diagnostic = error.diagnostic || {
        status: Number(error.status || 0), contentType: '', applicationCode: error.code || 'TRACKING_CLIENT',
        message: String(error.message || 'Tracking request failed.').slice(0, 1000), requestId: '',
        endpointFamily: 'developer-portal-tracking-v1', protocol: 'REST/JSON', environment: apiEnvironment, apiVersion: TRACKING_API_VERSION, scope: TRACKING_SCOPE, requestMethod: 'GET', responseHostname: '',
        redirectStatus: 0, redirectDestination: null, wwwAuthenticateScheme: '', htmlClassification: '', bodyFingerprint: 'none',
        category: 'schema', systemic: true,
        fingerprint: `developer-portal-tracking-v1|${apiEnvironment}|${TRACKING_API_VERSION}|REST/JSON|schema|${Number(error.status || 0)}|${error.code || 'TRACKING_CLIENT'}`
      };
      if (diagnostic.category === 'shipment_not_found') {
        noData += 1;
        checked += 1;
        recordTerminal(terminalCounters, PRIMARY_TERMINAL_CATEGORIES.NOT_DELIVERED);
        breaker.record(error);
        emit('pin_no_data', { pin: safePin, row: index + 1, terminal: true, primaryCategory: PRIMARY_TERMINAL_CATEGORIES.NOT_DELIVERED, reviewRequired: true, classification: 'REVIEW_REQUIRED', message: diagnostic.message, eligibilityReason: diagnostic.message, diagnostic });
      } else {
        errors += 1;
        checked += 1;
        recordTerminal(terminalCounters, PRIMARY_TERMINAL_CATEGORIES.ERROR);
        const circuit = breaker.record({ diagnostic });
        emit('pin_error', { pin: safePin, row: index + 1, terminal: true, primaryCategory: PRIMARY_TERMINAL_CATEGORIES.ERROR, classification: 'TRACKING_ERROR', message: diagnostic.message, diagnostic, consecutiveSystemicFailures: circuit.count });
        if (circuit.opened) {
          circuitOpen = true;
          circuitDiagnostic = diagnostic;
          emit('tracking_circuit_open', {
            message: `Tracking stopped after ${circuit.count} identical systemic failures. Check API credentials, endpoint availability, and application version before deliberately retrying.`,
            consecutiveFailures: circuit.count,
            diagnostic,
            processed: index + 1,
            attempted: index + 1,
            total: rows.length,
            remaining: selectedRows.length - index - 1,
            errors,
            queuePreserved: true,
            status: 'SYSTEMIC_INTEGRATION_FAILURE'
          });
        }
      }
      if (diagnosticMode) {
        let structureReportPath = '';
        if (structureExport && error.sanitizedStructure) {
          structureReportPath = path.resolve(process.env.TRACKING_STRUCTURE_REPORT || path.join(dataDir, 'tracking-response-structure.json'));
          fs.writeFileSync(structureReportPath, `${JSON.stringify({ ...error.sanitizedStructure, stateModified: false }, null, 2)}\n`, { mode: 0o600 });
        }
        emit('tracking_diagnostic', { ok: false, tracking: safePin, diagnostic, structureExported: Boolean(structureReportPath), structureReportPath, stateModified: false });
      }
    }
    emit('tracking_progress', { current: checked, total: selectedRows.length });
    if (circuitOpen || semanticCircuitOpen || diagnosticMode) break;
  }
  const headers = ['Tracking PIN', 'Destination Postal Code', 'Expected Delivery Date', 'Original Delivery Standard Date', 'Revised Expected Delivery Date', 'Expected Date Source', 'Expected Date Selection Reason', 'Revised Expected Delivery Reason', 'Actual Delivery Date', 'Successful Delivery Timestamp', 'Successful Delivery Event Identifier', 'Successful Delivery Event Description', 'Successful Delivery Normalization Rule', 'Successful Delivery Provenance', 'Reference #', 'Service Code', 'Status', 'Eligibility Reason', 'Shipment Date', 'First Attempt Date', 'First Attempt Timestamp', 'First Attempt Event Identifier', 'First Attempt Event Description', 'First Attempt Normalization Rule', 'First Attempt Provenance', 'Destination Province', 'Business Days Late', 'Claim Submission Deadline', 'Business Days Remaining', 'Peak Period', 'Policy Version', 'Holiday Calendar Version', 'Evidence Hash', 'Classification Warnings', 'Normalized Evidence JSON'];
  if (!diagnosticMode) assertTerminalReconciliation(terminalCounters);
  const attempted = Math.min(selectedRows.length, checked);
  const completedAll = !diagnosticMode && !circuitOpen && !semanticCircuitOpen && !stopped && errors === 0 && attempted === selectedRows.length;
  if (completedAll) {
    atomicPromoteTextFiles([
      { path: claimsPath, content: stringifyCsv(headers, claims) },
      { path: reviewPath, content: stringifyCsv(headers, reviews) },
      { path: overduePath, content: stringifyCsv(headers, overdue) }
    ], {
      runId: process.env.TRACKING_RUN_ID || process.env.RUN_ID || 'standalone',
      backupDirectory: path.join(dataDir, 'tracking-runs', `run-${process.env.TRACKING_RUN_ID || process.env.RUN_ID || 'standalone'}`),
      afterPromote: process.env.DATABASE_PATH
        ? () => claimDb.promoteTrackingBatch(process.env.DATABASE_PATH, pendingDatabaseWrites, { runId: process.env.TRACKING_RUN_ID || process.env.RUN_ID || null })
        : null
    });
  }
  const incomplete = !diagnosticMode && !completedAll;
  const result = { generatedAt: new Date().toISOString(), total: diagnosticMode ? rows.length : selectedRows.length, sourceTotal: rows.length, duplicateRowsSkipped: diagnosticMode ? 0 : deduplicated.duplicateRows, attempted, remaining: Math.max(0, selectedRows.length - attempted), checked, eligibleLateCount: terminalCounters.late, onTimeCount: terminalCounters.onTime, notDeliveredCount: terminalCounters.notDelivered, deliveredReviewCount: terminalCounters.deliveredReview, reviewRequiredCount: reviews.length, overdueInTransitCount: overdue.length, noDataCount: noData, errorCount: terminalCounters.errors, primaryCategoryTotal: terminalCounters.late + terminalCounters.onTime + terminalCounters.notDelivered + terminalCounters.deliveredReview + terminalCounters.errors, countersReconciled: true, deliverySource: `Developer Portal Tracking API ${TRACKING_API_VERSION}`, credentialMode: TRACKING_MODE, apiEnvironment, apiVersion: TRACKING_API_VERSION, parserVersion: TRACKING_PARSER_VERSION, scope: TRACKING_SCOPE, diagnosticMode, structureExport, circuitOpen, semanticCircuitOpen, circuitDiagnostic, queuePreserved: incomplete || diagnosticMode, statePromoted: completedAll, status: circuitOpen ? 'SYSTEMIC_INTEGRATION_FAILURE' : (semanticCircuitOpen ? 'SEMANTIC_NORMALIZATION_FAILURE' : (stopped ? 'STOPPED_INCOMPLETE' : (diagnosticMode ? (errors ? 'DIAGNOSTIC_FAILED' : 'DIAGNOSTIC_COMPLETE') : (completedAll ? 'COMPLETE' : 'INCOMPLETE')))) };
  if (invariantFailure) {
    emit('tracking_aborted', { ...result, status: 'INTERNAL_CLASSIFICATION_INVARIANT_FAILURE', message: invariantFailureMessage || 'Internal classification invariant failed.', queuePreserved: true, statePromoted: false });
  } else if (circuitOpen) {
    emit('tracking_aborted', { ...result, message: 'Stopped — systemic integration failure.', queuePreserved: true });
  } else if (semanticCircuitOpen) {
    emit('tracking_aborted', { ...result, message: 'Stopped — Tracking API responses were received, but required fields could not be normalized.', queuePreserved: true });
  } else if (stopped || incomplete) {
    emit('tracking_aborted', { ...result, message: stopped ? 'Stopped — incomplete Tracking API run. No classifications were promoted.' : 'Stopped — Tracking API run incomplete. No classifications were promoted.', queuePreserved: true });
  } else if (diagnosticMode) {
    emit('tracking_diagnostic_complete', result);
  } else {
    fs.writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    emit('tracking_complete', result);
  }
  if (invariantFailure || circuitOpen || semanticCircuitOpen || incomplete || (diagnosticMode && errors) || (errors && checked === 0)) process.exitCode = 1;
  trackingClient.clearToken('worker-finished', apiEnvironment);
  if (cancellationPoll) clearInterval(cancellationPoll);
}

if (require.main === module) main().catch(error => { emit('error', { message: error.message, reasonCode: error.code || 'TRACKING_WORKER_FAILED', diagnostic: error.diagnostic || undefined, statePromoted: false, queuePreserved: true }); process.exitCode = 1; });
module.exports = { PRIMARY_TERMINAL_CATEGORIES, createTerminalCounters, recordTerminal, assertTerminalReconciliation, outputRow, sanitizedNormalizationEvidence, validateTrackingCsvPolicyDates, deduplicateTrackingRows, main };
