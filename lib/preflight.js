'use strict';

function check(id, label, ok, { severity = 'blocking', message = '', action = '' } = {}) {
  return { id, label, ok: Boolean(ok), severity, message: String(message || ''), action: String(action || '') };
}

function buildPreflightReport(input = {}) {
  const scope = input.scope || 'all';
  const checks = [];
  const include = target => scope === 'all' || scope === target;

  checks.push(check('storage', 'Application data folder is writable', input.storageWritable, {
    message: input.storageWritable ? 'Private application storage is available.' : 'The application data folder is not writable.',
    action: 'Check folder ownership and permissions.'
  }));
  checks.push(check('database', 'Database integrity', input.databaseIntegrity?.ok, {
    message: input.databaseIntegrity?.ok ? 'SQLite integrity check passed.' : `Database integrity check failed: ${input.databaseIntegrity?.result || 'unknown error'}`,
    action: 'Restore a known-good backup before running claims.'
  }));

  if (include('step1')) {
    checks.push(check('node-runtime', 'Packaged Node runtime', input.nodeRuntimeAvailable, { message: input.nodeRuntimeAvailable ? `Node ${input.nodeVersion || ''} is available.` : 'The packaged Node runtime is unavailable.', action: 'Repair or reinstall the application.' }));
    if (Object.prototype.hasOwnProperty.call(input, 'step1WorkersAvailable')) checks.push(check('step1-workers', 'Step 1 worker resources', input.step1WorkersAvailable, { message: input.step1WorkersAvailable ? 'Step 1 worker resources and working directory are valid.' : 'A Step 1 worker resource or working directory is invalid.', action: 'Repair or reinstall the application.' }));
  }

  if (include('step2')) {
    const metadata = input.apiCredentialMetadata || {};
    const environmentMatches = !metadata.credentialEnvironment || metadata.credentialEnvironment === 'unknown' || metadata.credentialEnvironment === metadata.selectedEnvironment;
    checks.push(check('tracking-api-credentials', 'Tracking API client ID and client secret', input.apiCredentialsAvailable, {
      message: input.apiCredentialsAvailable ? 'Current Developer Portal Tracking API credentials are available.' : 'Tracking API client ID or client secret is missing.',
      action: 'Create a Developer Portal app with Tracking product access and save its API Key and API Secret.'
    }));
    checks.push(check('tracking-api-environment', 'Tracking API environment', environmentMatches, {
      message: environmentMatches ? `Tracking API endpoint and credential environment: ${metadata.selectedEnvironment || 'test'}.` : `Stored credentials are for ${metadata.credentialEnvironment}; the selected endpoint is ${metadata.selectedEnvironment}.`,
      action: 'Select the matching test or production environment, or save that environment’s Developer Portal app credentials.'
    }));
    checks.push(check('tracking-api-diagnostic-gate', 'One-shipment Tracking API diagnostic', input.trackingDiagnosticGateSatisfied, {
      message: input.trackingDiagnosticGateSatisfied ? `Diagnostic succeeded for the current credential revision, environment, and API ${metadata.apiVersion || ''}.` : 'Step 2 normal execution is disabled until the one-shipment diagnostic succeeds for the current configuration.',
      action: 'Use “Test API connection with one shipment” after configuration is corrected.'
    }));
    checks.push(check('tracking-csv', 'Tracking input', input.trackingCsvAvailable, { message: input.trackingCsvAvailable ? 'tracking.csv is available.' : 'tracking.csv is missing.', action: 'Run Step 1 or import tracking.csv.' }));
    checks.push(check('node-tracking', 'Tracking runtime', input.nodeRuntimeAvailable, { message: input.nodeRuntimeAvailable ? 'The packaged Node tracking client is ready.' : 'The packaged Node runtime is unavailable.', action: 'Repair or reinstall the application.' }));
    if (Object.prototype.hasOwnProperty.call(input, 'step2WorkerAvailable')) checks.push(check('step2-worker', 'Step 2 worker resource', input.step2WorkerAvailable, { message: input.step2WorkerAvailable ? 'The Step 2 worker and working directory are valid.' : 'The Step 2 worker resource or working directory is invalid.', action: 'Repair or reinstall the application.' }));
  }

  if (include('step3')) {
    checks.push(check('web-username', 'Canada Post web username', input.webUsernameAvailable, { message: input.webUsernameAvailable ? 'Web username is configured.' : 'Web username is missing.', action: 'Add it in User Settings.' }));
    checks.push(check('web-password', 'Canada Post web password', input.webPasswordAvailable, { message: input.webPasswordAvailable ? 'A reusable encrypted password is available.' : 'Web password is missing.', action: 'Enter and save the password in User Settings.' }));
    checks.push(check('claim-address', 'Sender address', input.claimAddressAvailable, { message: input.claimAddressAvailable ? 'Required sender address fields are configured.' : 'Sender street number or street name is missing.', action: 'Complete the claim sender address in User Settings.' }));
    checks.push(check('claims-queue', 'Late-delivery candidate queue', Number(input.claimCount || 0) > 0, { message: Number(input.claimCount || 0) > 0 ? `${input.claimCount} late-delivery candidate(s) are queued.` : 'No late-delivery candidates are queued.', action: 'Run Step 2 and refresh the Step 3 queue.' }));
    checks.push(check('builtin-browser', 'Built-in browser availability', input.builtinBrowserAvailable === true, { message: input.builtinBrowserAvailable ? 'The built-in Canada Post browser is available.' : 'The built-in Canada Post browser is unavailable.', action: 'Repair or reinstall the application.' }));
    if (Object.prototype.hasOwnProperty.call(input, 'step3WorkersAvailable')) checks.push(check('step3-workers', 'Step 3 worker resources', input.step3WorkersAvailable, { message: input.step3WorkersAvailable ? 'Step 3 worker resources and working directory are valid.' : 'A Step 3 worker resource or working directory is invalid.', action: 'Repair or reinstall the application.' }));
    checks.push(check('reconciliation', 'Unresolved claim outcomes', Number(input.reconciliationCount || 0) === 0, {
      severity: 'warning',
      message: Number(input.reconciliationCount || 0) === 0 ? 'No unresolved outcomes.' : `${input.reconciliationCount} claim outcome(s) require reconciliation.`,
      action: 'Review unresolved outcomes before retrying related shipments.'
    }));
  }

  const blocking = checks.filter(item => !item.ok && item.severity === 'blocking');
  const warnings = checks.filter(item => !item.ok && item.severity === 'warning');
  return {
    scope,
    ready: blocking.length === 0,
    blockingCount: blocking.length,
    warningCount: warnings.length,
    checks,
    generatedAt: new Date().toISOString()
  };
}

module.exports = { buildPreflightReport };
