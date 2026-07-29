'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { analyzeExportResponse, extractOrderIds } = require('../scripts/import-est-history');
const { parseCanadaPostError, htmlPageClassification } = require('../lib/canadapost-errors');
const { SystemicCircuitBreaker } = require('../lib/tracking-client');
const { rowsAsObjects } = require('../lib/csv');

const root = path.resolve(__dirname, '..');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` })); });
}
function stopServer(server) { return new Promise(resolve => server.close(resolve)); }

function runWorker(script, env, stdin = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', environment: 'test' }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, env: { ...process.env, NODE_ENV: 'test', CANADAPOST_SECRETS_STDIN: '1', CANADAPOST_API_ENVIRONMENT: 'test', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify(stdin));
    child.once('close', code => resolve({ code, stdout, stderr, events: stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) }));
  });
}

function estEnv(baseUrl, temporary) {
  return { CANADAPOST_MOCK_BASE_URL: baseUrl, DATA_DIR: path.join(temporary, 'data'), TRACKING_CSV: path.join(temporary, 'data', 'tracking.csv'), EST_CUSTOMER_NUMBER: '24680', EST_FROM: '2026-07-01', EST_TO: '2026-07-26', EST_CATEGORY_GROUP: 'SHP', EST_MOBO: '-2', EST_FILETYPES: '2' };
}

function estHandler(mode) {
  return (request, response) => {
    response.setHeader('Content-Type', mode === 'html' ? 'text/html' : 'application/xml');
    if (mode === 'html') return response.end('<!doctype html><html><title>Sign in</title><form>Login</form></html>');
    if (request.url === '/dop/connect') return response.end('<connect><status>ok</status></connect>');
    if (request.url.includes('/workgroup/customerNumber/')) return response.end('<list><string>13579</string></list>');
    if (request.url.includes('/order/')) return response.end(mode === 'empty' ? '<list/>' : 'ORDER-SYNTHETIC-001\n');
    if (request.method === 'POST' && request.url.includes('/exportorderhistory')) { response.setHeader('Content-Type', 'text/plain'); return response.end(mode === 'unknown' ? 'downloaded but not a recognized export' : fixture('est-export-legacy.txt')); }
    response.statusCode = 404; response.end('<messages><message><code>404</code><description>not found</description></message></messages>');
  };
}

function trackingCsv(count) {
  const rows = Array.from({ length: count }, (_, index) => `SYNTHETIC9${String(index + 1).padStart(5, '0')},K1A0B1,REF-${index + 1},DOM.XP,2026-06-01`).join('\n');
  return `Tracking PIN,Destination Postal Code,Reference #,Service Code,Shipment Date\n${rows}\n`;
}

function detail(pin) {
  return { pin, activeExists: true, archiveExists: false, expectedDeliveryDate: '2026-06-03', serviceName: 'Xpresspost', signatureImageExists: false, suppressSignature: false, significantEvents: [{ eventIdentifier: 'DELIVERED', eventDate: '2026-06-05', eventTime: '12:00:00', eventTimeZone: 'EDT', eventDescription: 'Delivered' }] };
}

async function testEstWorkers() {
  for (const mode of ['empty', 'populated', 'html', 'unknown']) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `cp-est-${mode}-`));
    const { server, baseUrl } = await startServer(estHandler(mode));
    const env = estEnv(baseUrl, temporary); fs.mkdirSync(path.dirname(env.TRACKING_CSV), { recursive: true });
    const sentinel = 'existing tracking data must remain unchanged\n'; fs.writeFileSync(env.TRACKING_CSV, sentinel);
    const result = await runWorker('import-est-history.js', env, { username: 'synthetic-user', password: 'synthetic-password' });
    await stopServer(server);
    if (mode === 'empty') { assert.strictEqual(result.code, 0); assert.strictEqual(result.events.find(event => event.type === 'est_complete').outcome, 'EMPTY'); assert.strictEqual(fs.readFileSync(env.TRACKING_CSV, 'utf8'), sentinel); }
    else if (mode === 'populated') {
      assert.strictEqual(result.code, 0); assert.strictEqual(result.events.find(event => event.type === 'est_complete').outcome, 'IMPORTED');
      assert.ok(!result.events.some(event => event.type === 'est_imported')); assert.ok(result.events.some(event => event.type === 'est_imported_detail')); assert.ok(result.events.some(event => event.type === 'est_import_progress'));
      assert.ok(!result.stdout.includes('SYNTHETIC900001'));
    } else { assert.notStrictEqual(result.code, 0); assert.strictEqual(fs.readFileSync(env.TRACKING_CSV, 'utf8'), sentinel); }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function testParsersAndDiagnostics() {
  assert.deepStrictEqual(extractOrderIds(fixture('est-order-list-legacy.xml')).ids, ['ORDER-SYNTHETIC-001', 'ORDER-SYNTHETIC-002']);
  assert.strictEqual(analyzeExportResponse(fixture('est-export-legacy.txt')).shipments.length, 1);
  assert.throws(() => analyzeExportResponse('<html>Sign in</html>'), error => error.code === 'EST_UNEXPECTED_LOGIN_HTML');
  const pages = { login_sso: '<html><title>Sign in</title><input type="password"></html>', access_denied: '<html><title>Access denied</title></html>', maintenance: '<html><title>Scheduled maintenance</title></html>', gateway_waf: '<html><title>Request rejected by Web Application Firewall</title></html>', generic_canada_post: '<html><title>Canada Post</title></html>', unknown_html: '<html><title>Unknown page</title></html>' };
  for (const [expected, body] of Object.entries(pages)) {
    const hostname = expected === 'unknown_html' ? 'synthetic.invalid' : 'api.canadapost-postescanada.ca';
    assert.strictEqual(htmlPageClassification(body, { status: expected === 'access_denied' ? 403 : 200, hostname }).classification, expected);
  }
  const gateway = parseCanadaPostError({ status: 504, headers: new Headers({ 'content-type': 'text/html' }), body: pages.unknown_html, endpointFamily: 'developer-portal-tracking-v1', protocol: 'REST/JSON' });
  assert.strictEqual(gateway.category, 'gateway_timeout'); assert.strictEqual(gateway.message, 'Canada Post API gateway timed out (HTTP 504).');
}

async function testTrackingWorkers() {
  const cases = [
    { name: '504', count: 5, resourceStatus: 504, expectedCode: 1, expectedToken: 1, expectedResource: 9, circuit: true },
    { name: 'not-found', count: 5, resourceStatus: 404, expectedCode: 0, expectedToken: 1, expectedResource: 5, circuit: false },
    { name: 'semantic', count: 5, resourceStatus: 200, expectedCode: 1, expectedToken: 1, expectedResource: 3, circuit: false, semantic: true },
    { name: 'diagnostic', count: 3, resourceStatus: 200, expectedCode: 0, expectedToken: 1, expectedResource: 1, circuit: false, diagnostic: true }
  ];
  for (const scenario of cases) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `cp-tracking-${scenario.name}-`));
    const dataDir = path.join(temporary, 'data'); fs.mkdirSync(dataDir, { recursive: true });
    const trackingPath = path.join(dataDir, 'tracking.csv'); const claimsPath = path.join(dataDir, 'claims.csv');
    const sentinel = 'existing claims queue\n'; fs.writeFileSync(trackingPath, trackingCsv(scenario.count)); fs.writeFileSync(claimsPath, sentinel);
    let tokenRequests = 0; let resourceRequests = 0;
    const mock = await startServer((request, response) => {
      if (request.url === '/oauth2/token') { tokenRequests += 1; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ token_type: 'Bearer', access_token: 'synthetic-token', expires_in: 3600, scope: 'merchant' })); return; }
      resourceRequests += 1;
      if (scenario.resourceStatus === 504) { response.writeHead(504, { 'Content-Type': 'text/html' }); response.end('<html><title>Gateway timeout</title></html>'); return; }
      if (scenario.resourceStatus === 404) { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ title: 'Not found', detail: 'No PIN history', errors: [{ errorCode: '004', message: 'No PIN history' }] })); return; }
      const pin = decodeURIComponent(request.url.split('/')[2]);
      const payload = detail(pin);
      if (scenario.semantic) payload.significantEvents = [{ eventIdentifier: 'NEW-CODE', eventDate: '2026-06-05', eventTime: '12:00:00', eventTimeZone: 'EDT', eventDescription: 'Synthetic unrecognized status' }];
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(payload));
    });
    const result = await runWorker('get-tracking.js', { CANADAPOST_MOCK_BASE_URL: mock.baseUrl, DATA_DIR: dataDir, TRACKING_CSV: trackingPath, CLAIMS_CSV: claimsPath, TRACKING_REQUEST_INTERVAL_MS: '3100', TRACKING_RATE_LIMIT_DISABLE_WAIT: '1', TRACKING_DIAGNOSTIC_MODE: scenario.diagnostic ? '1' : '0', TRACKING_DIAGNOSTIC_CONFIRM: scenario.diagnostic ? 'ONE_REQUEST_NO_STATE_CHANGE' : '', TRACKING_DIAGNOSTIC_ROW: scenario.diagnostic ? '2' : '' });
    await stopServer(mock.server);
    assert.strictEqual(result.code, scenario.expectedCode, `${scenario.name} exit code`); assert.strictEqual(tokenRequests, scenario.expectedToken, `${scenario.name} token requests`); assert.strictEqual(resourceRequests, scenario.expectedResource, `${scenario.name} resource requests`);
    assert.strictEqual(Boolean(result.events.find(event => event.type === 'tracking_circuit_open')), scenario.circuit);
    assert.strictEqual(Boolean(result.events.find(event => event.type === 'tracking_semantic_circuit_open')), Boolean(scenario.semantic));
    assert.ok(!result.stdout.includes('synthetic-client') && !result.stdout.includes('synthetic-secret') && !result.stdout.includes('synthetic-token'));
    assert.ok(!/SYNTHETIC9\d{5}/.test(result.stdout));
    if (scenario.circuit) {
      const aborted = result.events.find(event => event.type === 'tracking_aborted');
      assert.deepStrictEqual({ attempted: aborted.attempted, total: aborted.total, remaining: aborted.remaining, errors: aborted.errorCount, queuePreserved: aborted.queuePreserved }, { attempted: 3, total: 5, remaining: 2, errors: 3, queuePreserved: true });
      assert.strictEqual(result.events.find(event => event.type === 'tracking_circuit_open').diagnostic.category, 'gateway_timeout');
      assert.strictEqual(result.events.filter(event => event.type === 'pin_error' && event.terminal).length, 3, 'terminal retry failures must be counted once per shipment');
      assert.deepStrictEqual(result.events.filter(event => event.type === 'tracking_progress').map(event => event.current), [1, 2, 3], 'retry failures must advance checked progress once per shipment');
    }
    if (scenario.diagnostic) { assert.ok(result.events.some(event => event.type === 'tracking_diagnostic' && event.stateModified === false)); assert.ok(!result.events.some(event => event.type === 'tracking_complete')); }
    if (scenario.circuit || scenario.semantic || scenario.diagnostic) assert.strictEqual(fs.readFileSync(claimsPath, 'utf8'), sentinel);
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-tracking-fresh-dedupe-'));
  const dataDir = path.join(temporary, 'data'); fs.mkdirSync(dataDir, { recursive: true });
  const trackingPath = path.join(dataDir, 'tracking.csv'); const claimsPath = path.join(dataDir, 'claims.csv');
  const oneRow = trackingCsv(1).trim().split(/\r?\n/);
  fs.writeFileSync(trackingPath, `${oneRow[0]}\n${oneRow[1]}\n${oneRow[1]}\n`);
  let resourceRequests = 0;
  const mock = await startServer((request, response) => {
    if (request.url === '/oauth2/token') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ token_type: 'Bearer', access_token: 'synthetic-token', expires_in: 3600, scope: 'merchant' }));
      return;
    }
    resourceRequests += 1;
    const pin = decodeURIComponent(request.url.split('/')[2]);
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(detail(pin)));
  });
  const env = { CANADAPOST_MOCK_BASE_URL: mock.baseUrl, DATA_DIR: dataDir, TRACKING_CSV: trackingPath, CLAIMS_CSV: claimsPath, TRACKING_REQUEST_INTERVAL_MS: '3100', TRACKING_RATE_LIMIT_DISABLE_WAIT: '1' };
  const first = await runWorker('get-tracking.js', env);
  assert.strictEqual(first.code, 0);
  assert.strictEqual(rowsAsObjects(fs.readFileSync(claimsPath, 'utf8')).length, 1, 'duplicate input PINs must produce one claim row');
  assert.strictEqual(first.events.find(event => event.type === 'tracking_complete')?.duplicateRowsSkipped, 1);
  const second = await runWorker('get-tracking.js', env);
  assert.strictEqual(second.code, 0);
  assert.strictEqual(rowsAsObjects(fs.readFileSync(claimsPath, 'utf8')).length, 1, 'a repeated completed run must replace, not append to, claims.csv');
  assert.strictEqual(resourceRequests, 2, 'each completed run should request each unique PIN once');
  await stopServer(mock.server);
  fs.rmSync(temporary, { recursive: true, force: true });
}

function testCircuitUnit() {
  const breaker = new SystemicCircuitBreaker(); const failure = { diagnostic: { systemic: true, fingerprint: 'same' } };
  assert.strictEqual(breaker.record(failure).opened, false); assert.strictEqual(breaker.record(failure).opened, false); assert.strictEqual(breaker.record(failure).opened, true);
  const shipment = new SystemicCircuitBreaker(); for (let index = 0; index < 10; index += 1) assert.strictEqual(shipment.record({ diagnostic: { systemic: false, category: 'shipment_not_found' } }).opened, false);
}

(async () => {
  testParsersAndDiagnostics(); testCircuitUnit(); await testEstWorkers(); await testTrackingWorkers();
  process.stdout.write('EST and current Tracking API failure-handling integration tests passed.\n');
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
