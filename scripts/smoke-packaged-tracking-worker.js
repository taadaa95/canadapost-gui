#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { resolveWorkerLaunch, spawnResolvedWorker } = require('../lib/runtime-workers');
const { resolvePackagedLayout } = require('./packaged-layout');

function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address())); }); }
function close(server) { return new Promise(resolve => server.close(() => resolve())); }

function syntheticCsv(count, serviceCode = 'DOM.XP', shipmentDate = '2026-06-01') {
  const rows = ['Tracking PIN,Service Code,Shipment Date,Destination Province'];
  for (let index = 0; index < count; index += 1) rows.push(`SYNTHETIC9${String(index).padStart(5, '0')},${serviceCode},${shipmentDate},ON`);
  return `${rows.join('\n')}\n`;
}

function successJson(pin) {
  return {
    pin, activeExists: true, archiveExists: false, expectedDeliveryDate: '2026-06-03', serviceName: 'Xpresspost',
    signatureImageExists: false, suppressSignature: false,
    significantEvents: [{ eventIdentifier: '1442', eventDate: '2026-06-04', eventTime: '10:00:00', eventTimeZone: 'EDT', eventDescription: 'Delivered' }]
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const packageRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'packages', 'linux-unpacked'));
  const aliases = { success: 'tracking-success', 'systemic-500': '504', 'diagnostic-success': 'diagnostic-state', 'invariant-failure': 'optional-metadata' };
  const scenario = aliases[String(process.argv[3] || 'tracking-success')] || String(process.argv[3] || 'tracking-success');
  assert.ok(['token-success', 'token-failure', 'tracking-success', '401-refresh', '504', 'diagnostic-state', 'json-parser', 'est-service-fallback', 'first-attempt', 'semantic-gate-failure', 'semantic-gate-success', 'incomplete-isolation', 'rate-limiter', 'diagnostic-bulk-parity', 'event-1442', 'timeout-retry', 'optional-metadata'].includes(scenario), 'Unknown packaged Tracking API smoke scenario.');
  const { executablePath, resourcesPath, appPath } = resolvePackagedLayout(packageRoot);
  assert.ok(fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile(), 'Packaged Electron executable is missing.');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-packaged-tracking-smoke-'));
  let tokenRequests = 0;
  let resourceRequests = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/oauth2/token') {
      tokenRequests += 1;
      assert.strictEqual(request.method, 'POST');
      assert.strictEqual(request.headers.accept, 'application/json');
      assert.match(request.headers['content-type'] || '', /^application\/x-www-form-urlencoded/);
      assert.ok(request.headers['x-ibm-client-id']);
      assert.ok(request.headers['x-ibm-client-secret']);
      assert.strictEqual(request.headers.authorization, undefined);
      const form = new URLSearchParams(await readBody(request));
      assert.strictEqual(form.get('grant_type'), 'client_credentials');
      assert.strictEqual(form.get('scope'), 'merchant');
      if (scenario === 'token-failure') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_client', error_description: 'Synthetic token rejection' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ token_type: 'Bearer', access_token: `synthetic-access-${tokenRequests}`, expires_in: 3600, scope: 'merchant' }));
      return;
    }

    resourceRequests += 1;
    assert.strictEqual(request.method, 'GET');
    assert.match(request.url, /^\/pins\/[^/]+\/details$/);
    assert.strictEqual(request.headers.accept, 'application/json');
    assert.match(request.headers.authorization || '', /^Bearer /);
    assert.strictEqual(request.headers['content-type'], undefined);
    if (scenario === '401-refresh' && resourceRequests === 1) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ httpCode: '401', httpMessage: 'Unauthorized' }));
      return;
    }
    if (scenario === '504') {
      response.writeHead(504, { 'Content-Type': 'text/html', 'X-Request-ID': 'synthetic-request' });
      response.end('<html><title>Gateway timeout</title></html>');
      return;
    }
    if (scenario === 'timeout-retry' && resourceRequests < 3) return;
    const pin = decodeURIComponent(request.url.split('/')[2]);
    const payload = successJson(pin);
    if (scenario === 'est-service-fallback') { payload.serviceName = null; payload.serviceName2 = null; }
    if (scenario === 'first-attempt') payload.significantEvents.unshift({ eventIdentifier: 'SYN-ATTEMPT', eventDate: '2026-06-04', eventTime: '09:00:00', eventTimeZone: 'EDT', eventDescription: 'Notice card left' });
    if (['semantic-gate-failure', 'incomplete-isolation'].includes(scenario)) payload.significantEvents = [{ eventIdentifier: 'NEW-CODE', eventDate: '2026-06-04', eventTime: '09:00:00', eventTimeZone: 'EDT', eventDescription: 'Synthetic unrecognized status' }];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  });

  try {
    const address = await listen(server);
    const dataDir = path.join(temporary, 'data');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const trackingCsv = path.join(dataDir, 'tracking.csv');
    const claimsCsv = path.join(dataDir, 'claims.csv');
    const queueSentinel = 'sentinel queue contents\n';
    const diagnosticMode = ['diagnostic-state', 'semantic-gate-failure', 'semantic-gate-success'].includes(scenario);
    const failureMode = ['token-failure', '504', 'semantic-gate-failure', 'incomplete-isolation'].includes(scenario);
    const rowCount = ['504', 'incomplete-isolation'].includes(scenario) ? 5 : (scenario === 'rate-limiter' ? 2 : 1);
    fs.writeFileSync(trackingCsv, syntheticCsv(
      rowCount,
      scenario === 'semantic-gate-failure' || scenario === 'incomplete-isolation' ? 'UNKNOWN' : 'DOM.XP',
      scenario === 'optional-metadata' ? '' : '2026-06-01'
    ), { mode: 0o600 });
    if (failureMode || diagnosticMode || scenario === 'diagnostic-bulk-parity') fs.writeFileSync(claimsCsv, queueSentinel, { mode: 0o600 });
    const resolution = resolveWorkerLaunch('tracking', {
      appPath, resourcesPath, userDataPath: path.join(temporary, 'user-data'),
      executablePath, appImagePath: process.env.APPIMAGE || '', isPackaged: true, platform: process.platform
    });
    const secretPayload = { clientId: 'synthetic-client-id', clientSecret: 'synthetic-client-secret', environment: 'test' };
    async function launchWorker(runDiagnostic = false) {
      const launch = spawnResolvedWorker(resolution, {
        env: {
        NODE_ENV: 'test', CANADAPOST_MOCK_BASE_URL: `http://127.0.0.1:${address.port}`, CANADAPOST_SECRETS_STDIN: '1',
        DATA_DIR: dataDir, TRACKING_CSV: trackingCsv, CLAIMS_CSV: claimsCsv, TRACKING_REQUEST_INTERVAL_MS: '3100', TRACKING_RATE_LIMIT_DISABLE_WAIT: '1',
          CANADAPOST_API_ENVIRONMENT: 'test', TRACKING_DIAGNOSTIC_MODE: runDiagnostic ? '1' : '0',
          TRACKING_DIAGNOSTIC_CONFIRM: runDiagnostic ? 'ONE_REQUEST_NO_STATE_CHANGE' : '', TRACKING_DIAGNOSTIC_ROW: runDiagnostic ? '1' : '',
          TRACKING_RESOURCE_TIMEOUT_MS: scenario === 'timeout-retry' ? '1000' : ''
        },
        stdinJson: secretPayload
      });
      let stdout = ''; let stderr = '';
      launch.child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      launch.child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      launch.child.stdin.end(JSON.stringify(secretPayload));
      const started = await launch.started;
      assert.strictEqual(started.ok, true, started.error?.message || 'Packaged tracking worker failed to spawn.');
      const exit = await new Promise(resolve => launch.child.once('close', (code, signal) => resolve({ code, signal })));
      assert.ok(!/ENOTDIR/i.test(`${stdout}\n${stderr}`), 'Packaged tracking worker produced ENOTDIR.');
      for (const secret of Object.values(secretPayload).slice(0, 2)) assert.ok(!stdout.includes(secret), 'A credential appeared in worker output.');
      assert.ok(!stdout.includes('synthetic-access-'), 'An access token appeared in worker output.');
      assert.ok(!/SYNTHETIC9\d{5}/.test(stdout), 'A complete synthetic tracking number appeared in worker output.');
      return { exit, stdout, stderr, events: stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) };
    }

    if (scenario === 'diagnostic-bulk-parity') {
      const diagnosticRun = await launchWorker(true);
      assert.strictEqual(diagnosticRun.exit.code, 0);
      assert.strictEqual(fs.readFileSync(claimsCsv, 'utf8'), queueSentinel, 'diagnostic must not mutate the queue');
      const bulkRun = await launchWorker(false);
      assert.strictEqual(bulkRun.exit.code, 0);
      const diagnostic = diagnosticRun.events.find(event => event.type === 'tracking_diagnostic');
      const bulk = bulkRun.events.find(event => ['pin_review_required', 'pin_late', 'pin_on_time'].includes(event.type));
      assert.ok(diagnostic?.ok && bulk, 'both packaged paths must produce classification evidence');
      assert.strictEqual(diagnostic.classificationInputHash, bulk.classificationInputHash, 'packaged diagnostic and bulk policy inputs must be identical');
      assert.strictEqual(diagnostic.canonicalShipment.firstAttemptEventCode, '1442');
      assert.strictEqual(diagnostic.classificationPreview.classification, bulk.classification);
      assert.strictEqual(tokenRequests, 2);
      assert.strictEqual(resourceRequests, 2);
      process.stdout.write('Packaged Tracking API diagnostic/bulk canonical parity smoke passed.\n');
      return;
    }

    const { exit, stderr, events } = await launchWorker(diagnosticMode);
    const complete = events.find(event => event.type === 'tracking_complete');

    if (!failureMode) {
      assert.strictEqual(exit.code, 0, `Packaged tracking worker exited ${exit.code}: ${stderr.slice(0, 500)}`);
      assert.strictEqual(tokenRequests, scenario === '401-refresh' ? 2 : 1);
      assert.strictEqual(resourceRequests, scenario === 'timeout-retry' ? 3 : (['401-refresh', 'rate-limiter'].includes(scenario) ? 2 : 1));
      if (diagnosticMode) {
        assert.ok(events.some(event => event.type === 'tracking_diagnostic' && event.ok && event.stateModified === false));
        assert.ok(events.some(event => event.type === 'tracking_diagnostic_complete'));
        assert.ok(!complete);
        assert.strictEqual(fs.readFileSync(claimsCsv, 'utf8'), queueSentinel);
      } else assert.strictEqual(complete?.checked, scenario === 'rate-limiter' ? 2 : 1);
      if (scenario === 'first-attempt') {
        const classificationEvent = events.find(event => event.type === 'pin_review_required' || event.type === 'pin_late' || event.type === 'pin_on_time');
        assert.strictEqual(classificationEvent?.firstAttemptDate, '2026-06-04');
      }
      if (scenario === 'event-1442') {
        const classificationEvent = events.find(event => ['pin_review_required', 'pin_late', 'pin_on_time'].includes(event.type));
        assert.ok(classificationEvent);
        assert.strictEqual(classificationEvent.firstAttemptDate, '2026-06-04');
        assert.strictEqual(classificationEvent.deliveryDate, '2026-06-04');
        assert.ok(!/required evidence is missing/i.test(classificationEvent.eligibilityReason || ''));
      }
      if (scenario === 'timeout-retry') {
        assert.strictEqual(events.filter(event => event.type === 'tracking_protocol_stage' && event.stage === 'tracking_backoff' && event.category === 'timeout').length, 2);
        assert.strictEqual(events.find(event => event.type === 'tracking_start')?.concurrency, 1);
        assert.strictEqual(events.filter(event => event.terminal === true).length, 1, 'retry success must produce one terminal shipment result');
        assert.deepStrictEqual(events.filter(event => event.type === 'tracking_progress').map(event => event.current), [1], 'retry success must advance progress once');
      }
      if (scenario === 'rate-limiter') {
        const start = events.find(event => event.type === 'tracking_start');
        assert.strictEqual(start.requestIntervalMs, 3100);
        assert.strictEqual(start.concurrency, 1);
      }
      if (scenario === 'optional-metadata') {
        assert.ok(events.some(event => event.type === 'tracking_input_warning'));
        assert.ok(events.some(event => event.type === 'pin_late' && event.classification === 'LATE_CANDIDATE'));
        assert.ok(!events.some(event => event.type === 'tracking_invariant_failure'));
      }
    } else {
      assert.strictEqual(exit.code, 1);
      assert.strictEqual(tokenRequests, 1, 'token rejection must not be retried automatically');
      if (scenario === '504') assert.strictEqual(resourceRequests, 9);
      else if (scenario === 'incomplete-isolation') assert.strictEqual(resourceRequests, 3);
      else if (scenario === 'semantic-gate-failure') assert.strictEqual(resourceRequests, 1);
      else assert.strictEqual(resourceRequests, 0);
      assert.ok(!complete);
      const aborted = events.find(event => event.type === 'tracking_aborted');
      if (scenario === 'semantic-gate-failure') assert.ok(events.some(event => event.type === 'tracking_diagnostic_complete' && event.status === 'DIAGNOSTIC_FAILED'));
      else assert.strictEqual(aborted?.queuePreserved, true);
      const circuit = events.find(event => event.type === 'tracking_circuit_open');
      if (scenario === '504') {
        assert.strictEqual(circuit?.diagnostic?.status, 504);
        assert.strictEqual(circuit?.diagnostic?.category, 'gateway_timeout');
        assert.strictEqual(circuit?.diagnostic?.message, 'Canada Post API gateway timed out (HTTP 504).');
      }
      if (scenario === 'incomplete-isolation') assert.ok(events.some(event => event.type === 'tracking_semantic_circuit_open'));
      if (scenario === 'semantic-gate-failure') assert.ok(events.some(event => event.type === 'tracking_diagnostic' && !event.ok));
      assert.strictEqual(fs.readFileSync(claimsCsv, 'utf8'), queueSentinel);
    }
    process.stdout.write(`Packaged Tracking API ${scenario} synthetic smoke passed: tokenRequests=${tokenRequests}, resourceRequests=${resourceRequests}, statePreserved=${failureMode || diagnosticMode}.\n`);
  } finally {
    await close(server).catch(() => {});
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`Packaged Tracking API synthetic smoke failed: ${error.message}\n`); process.exitCode = 1; });
