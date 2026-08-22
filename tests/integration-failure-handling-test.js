'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { analyzeExportResponse, extractOrderIds } = require('../scripts/import-est-history');
const { parseCanadaPostError, htmlPageClassification } = require('../lib/canadapost-errors');
const {
  SEGMENT_STATES,
  addCalendarDays,
  dateSpanDays,
  splitDateRange,
  bisectDateRange,
  lookupOrdersForSegment,
  resolveOrderRange,
  unresolvedRangeError
} = require('../lib/est-order-ranges');
const { SystemicCircuitBreaker } = require('../lib/tracking-client');
const { rowsAsObjects } = require('../lib/csv');

const root = path.resolve(__dirname, '..');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` })); });
}
function stopServer(server) { return new Promise(resolve => server.close(resolve)); }

function syntheticServiceError(status, applicationCode = `SYNTHETIC_${status}`) {
  return Object.assign(new Error(`Synthetic HTTP ${status}`), {
    status,
    code: applicationCode,
    diagnostic: {
      status,
      applicationCode,
      message: `Sanitized synthetic HTTP ${status}`,
      category: 'request'
    }
  });
}

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
    if (mode === 'unauthorized') { response.statusCode = 401; return response.end('<messages><message><code>401</code><description>Unauthorized</description></message></messages>'); }
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

async function testEstDateRangesAndResolution() {
  assert.deepStrictEqual(splitDateRange('2026-07-01', '2026-07-01'), [{ from: '2026-07-01', to: '2026-07-01' }]);
  assert.deepStrictEqual(splitDateRange('2026-07-01', '2026-07-30'), [{ from: '2026-07-01', to: '2026-07-30' }]);
  assert.deepStrictEqual(splitDateRange('2026-07-01', '2026-07-31'), [
    { from: '2026-07-01', to: '2026-07-30' },
    { from: '2026-07-31', to: '2026-07-31' }
  ]);
  assert.deepStrictEqual(splitDateRange('2026-07-01', '2026-08-12'), [
    { from: '2026-07-01', to: '2026-07-30' },
    { from: '2026-07-31', to: '2026-08-12' }
  ]);
  assert.deepStrictEqual(splitDateRange('2026-12-20', '2027-01-20'), [
    { from: '2026-12-20', to: '2027-01-18' },
    { from: '2027-01-19', to: '2027-01-20' }
  ]);
  assert.deepStrictEqual(splitDateRange('2028-02-28', '2028-03-01', 1), [
    { from: '2028-02-28', to: '2028-02-28' },
    { from: '2028-02-29', to: '2028-02-29' },
    { from: '2028-03-01', to: '2028-03-01' }
  ]);
  const rollover = splitDateRange('2026-01-25', '2026-03-03', 7);
  assert.strictEqual(rollover.reduce((total, segment) => total + dateSpanDays(segment.from, segment.to), 0), 38);
  for (let index = 1; index < rollover.length; index += 1) {
    assert.strictEqual(rollover[index].from, addCalendarDays(rollover[index - 1].to, 1), 'segments must have neither gaps nor overlaps');
  }
  assert.deepStrictEqual(bisectDateRange('2026-07-01', '2026-07-30'), [
    { from: '2026-07-01', to: '2026-07-15' },
    { from: '2026-07-16', to: '2026-07-30' }
  ]);

  const parser = response => ({ ids: response.ids, format: 'synthetic' });
  let lookups = 0;
  const normal = await lookupOrdersForSegment({
    segment: { from: '2026-07-01', to: '2026-07-10' },
    lookup: async dates => { lookups += 1; return { status: 200, ids: [`ORDER-${dates.label}`] }; },
    parseOrders: parser
  });
  assert.strictEqual(normal.state, SEGMENT_STATES.SUCCESS_WITH_ORDERS);
  assert.deepStrictEqual(normal.orderIds, ['ORDER-iso']);
  assert.strictEqual(lookups, 1, 'a normal successful lookup must retain the existing first-format behavior');

  lookups = 0;
  const empty = await lookupOrdersForSegment({
    segment: { from: '2026-07-01', to: '2026-07-10' },
    lookup: async () => { lookups += 1; return { status: 200, ids: [] }; },
    parseOrders: parser
  });
  assert.strictEqual(empty.state, SEGMENT_STATES.SUCCESS_EMPTY);
  assert.strictEqual(lookups, 2, 'both established encodings remain supported for an empty result');

  const requestedFormats = [];
  const secondEncoding = await lookupOrdersForSegment({
    segment: { from: '2026-07-01', to: '2026-07-10' },
    lookup: async dates => {
      requestedFormats.push(dates);
      if (dates.label === 'iso') throw syntheticServiceError(400);
      return { status: 200, ids: ['ORDER-COMPACT'] };
    },
    parseOrders: parser
  });
  assert.strictEqual(secondEncoding.state, SEGMENT_STATES.SUCCESS_WITH_ORDERS);
  assert.deepStrictEqual(requestedFormats.map(item => [item.from, item.to]), [
    ['2026-07-01', '2026-07-10'],
    ['20260701', '20260710']
  ]);

  let splitNotices = 0;
  lookups = 0;
  const bisected = await resolveOrderRange({
    segment: { from: '2026-07-01', to: '2026-07-30' },
    lookup: async dates => {
      lookups += 1;
      const normalizedFrom = dates.from.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      const normalizedTo = dates.to.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      if (dateSpanDays(normalizedFrom, normalizedTo) > 15) throw syntheticServiceError(409, 'RANGE_TOO_BROAD');
      return { status: 200, ids: [`ORDER-${normalizedFrom}`, 'ORDER-DUPLICATE'] };
    },
    parseOrders: parser,
    onAdaptiveSplit: () => { splitNotices += 1; }
  });
  assert.strictEqual(bisected.state, SEGMENT_STATES.SPLIT_AND_RESOLVED);
  assert.deepStrictEqual(bisected.orderIds, ['ORDER-2026-07-01', 'ORDER-DUPLICATE', 'ORDER-2026-07-16']);
  assert.strictEqual(lookups, 4, 'the rejected parent uses two formats and successful children use one each');
  assert.strictEqual(splitNotices, 1);

  const recursive = await resolveOrderRange({
    segment: { from: '2026-01-01', to: '2026-01-16' },
    lookup: async dates => {
      const from = dates.from.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      const to = dates.to.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      if (dateSpanDays(from, to) > 2) throw syntheticServiceError(409);
      return { status: 200, ids: [`ORDER-${from}`] };
    },
    parseOrders: parser
  });
  assert.strictEqual(recursive.state, SEGMENT_STATES.SPLIT_AND_RESOLVED);
  assert.strictEqual(recursive.orderIds.length, 8, 'recursive 409 splitting must terminate and combine every child');

  const oneDay = await resolveOrderRange({
    segment: { from: '2026-07-01', to: '2026-07-01' },
    lookup: async () => { throw syntheticServiceError(409, 'XML_RANGE_CODE'); },
    parseOrders: parser
  });
  assert.strictEqual(oneDay.state, SEGMENT_STATES.FAILURE);
  assert.strictEqual(oneDay.allAttemptsConflict, true);
  const oneDayError = unresolvedRangeError(oneDay, { workgroupOrdinal: 2 });
  assert.strictEqual(oneDayError.diagnostic.status, 409);
  assert.strictEqual(oneDayError.diagnostic.applicationCode, 'XML_RANGE_CODE');
  assert.deepStrictEqual(oneDayError.diagnostic.failedDateSpan, { from: '2026-07-01', to: '2026-07-01' });
  assert.strictEqual(oneDayError.diagnostic.workgroupOrdinal, 2);

  splitNotices = 0;
  const clientFailure = await resolveOrderRange({
    segment: { from: '2026-07-01', to: '2026-07-30' },
    lookup: async () => { throw syntheticServiceError(400); },
    parseOrders: parser,
    onAdaptiveSplit: () => { splitNotices += 1; }
  });
  assert.strictEqual(clientFailure.state, SEGMENT_STATES.FAILURE);
  assert.strictEqual(splitNotices, 0, 'non-409 failures must not trigger range splitting');

  let stopChecks = 0;
  await assert.rejects(
    resolveOrderRange({
      segment: { from: '2026-07-01', to: '2026-07-30' },
      shouldStop: () => { stopChecks += 1; return stopChecks >= 3; },
      lookup: async () => ({ status: 200, ids: [] }),
      parseOrders: parser
    }),
    error => error.code === 'EST_IMPORT_STOPPED'
  );
}

function detail(pin) {
  return { pin, activeExists: true, archiveExists: false, expectedDeliveryDate: '2026-06-03', serviceName: 'Xpresspost', signatureImageExists: false, suppressSignature: false, significantEvents: [{ eventIdentifier: 'DELIVERED', eventDate: '2026-06-05', eventTime: '12:00:00', eventTimeZone: 'EDT', eventDescription: 'Delivered' }] };
}

async function testEstWorkers() {
  for (const mode of ['empty', 'populated', 'html', 'unknown', 'unauthorized']) {
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
    } else {
      assert.notStrictEqual(result.code, 0); assert.strictEqual(fs.readFileSync(env.TRACKING_CSV, 'utf8'), sentinel);
      if (mode === 'unauthorized') assert.strictEqual(result.events.find(event => event.type === 'error')?.message, 'Canada Post rejected the saved website username or password. Re-enter your website credentials in Settings and try again.');
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function normalizedRequestDate(value) {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
}

function syntheticEstExport(orderIds, pinForOrder) {
  const manifestHeader = 'Order Id,WERKS - Induction Point,VBELN - SAP Order Id,KUNNR - Behalf of Customer Number,KUNNR - Payer Customer Number,Category Type Code,VBELN - SAP Contract Id,Creation Date,Mailing Date';
  const itemHeader = 'Order Id,MATNR - Article Number,Bar Code Id,Postal Zip Code,Imported Order ID,Date Time Trace Inquiry Event,Description Significant Event';
  const manifests = orderIds.map(orderId => `${orderId},,,,,,,20260630,20260701`);
  const items = orderIds.map(orderId => `${orderId},908,${pinForOrder(orderId)},K1A 0B1,${orderId},2026-07-02,Shipment created`);
  return [
    'Manifest.csv', String(manifests.length + 1), manifestHeader, ...manifests, '',
    'ManifestItems.csv', String(items.length + 1), itemHeader, ...items, ''
  ].join('\n');
}

function longRangeEstHandler({ permanentConflict = false, stopFile = '' } = {}) {
  const requests = { orderRanges: [], exportedOrderIds: [], exportRequests: 0 };
  const workgroups = ['11111', '22222', '33333'];
  const pinMap = new Map();
  const pinForOrder = orderId => {
    if (orderId.endsWith('2026-07-31')) return 'SYNTHETIC899999';
    if (!pinMap.has(orderId)) pinMap.set(orderId, `SYNTHETIC8${String(pinMap.size + 1).padStart(5, '0')}`);
    return pinMap.get(orderId);
  };
  const handler = (request, response) => {
    response.setHeader('Content-Type', 'application/xml');
    if (request.url === '/dop/connect') return response.end('<connect><status>ok</status></connect>');
    if (request.url.includes('/workgroup/customerNumber/')) return response.end(`<list>${workgroups.map(id => `<string>${id}</string>`).join('')}</list>`);
    const orderMatch = /\/ship\/desktop\/\d+\/(\d+)\/(?:SHP|OSS)\/order\/([^/]+)\/([^/]+)\/-?\d+/.exec(request.url);
    if (request.method === 'GET' && orderMatch) {
      const [, workgroup, rawFrom, rawTo] = orderMatch;
      const from = normalizedRequestDate(rawFrom);
      const to = normalizedRequestDate(rawTo);
      const days = dateSpanDays(from, to);
      requests.orderRanges.push({ workgroup, from, to, format: /^\d{8}$/.test(rawFrom) ? 'yyyymmdd' : 'iso', days });
      const containsPermanentFailure = permanentConflict
        && workgroup === workgroups[2]
        && from <= '2026-08-05'
        && to >= '2026-08-05';
      if (days > 30 || containsPermanentFailure) {
        response.statusCode = 409;
        return response.end('<messages><message><code>RANGE_CONFLICT</code><description>Refine the synthetic history range</description></message></messages>');
      }
      if (stopFile && requests.orderRanges.length === 1) fs.writeFileSync(stopFile, 'stop\n');
      const orderIds = [`ORDER-${workgroup}-COMMON`, `ORDER-${workgroup}-${from}`];
      return response.end(`${orderIds.join('\n')}\n${orderIds[1]}\n`);
    }
    if (request.method === 'POST' && request.url.includes('/exportorderhistory')) {
      requests.exportRequests += 1;
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const orderIds = [...body.matchAll(/<string>([^<]+)<\/string>/g)].map(match => match[1]);
        requests.exportedOrderIds.push(...orderIds);
        response.setHeader('Content-Type', 'text/plain');
        response.end(syntheticEstExport(orderIds, pinForOrder));
      });
      return undefined;
    }
    response.statusCode = 404;
    return response.end('<messages><message><code>404</code><description>not found</description></message></messages>');
  };
  return { handler, requests, workgroups };
}

async function testEstLongRangeIntegration() {
  const runScenario = async ({ permanentConflict = false, cancelDuringRange = false } = {}) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-est-long-range-'));
    const trackingPath = path.join(temporary, 'data', 'tracking.csv');
    const stopFile = cancelDuringRange ? path.join(temporary, 'STOP') : '';
    fs.mkdirSync(path.dirname(trackingPath), { recursive: true });
    const sentinel = Buffer.from('previous tracking.csv bytes must remain exact\n');
    fs.writeFileSync(trackingPath, sentinel);
    const synthetic = longRangeEstHandler({ permanentConflict, stopFile });
    const { server, baseUrl } = await startServer(synthetic.handler);
    const result = await runWorker('import-est-history.js', {
      ...estEnv(baseUrl, temporary),
      EST_TO: '2026-08-12',
      STOP_FILE: stopFile
    }, { username: 'synthetic-user', password: 'synthetic-password' });
    await stopServer(server);
    return { temporary, trackingPath, sentinel, synthetic, result };
  };

  const successful = await runScenario();
  try {
    assert.strictEqual(successful.result.code, 0);
    const rangesByWorkgroup = successful.synthetic.requests.orderRanges.reduce((groups, item) => {
      (groups[item.workgroup] ||= []).push(item);
      return groups;
    }, {});
    for (const ranges of Object.values(rangesByWorkgroup)) {
      assert.deepStrictEqual(ranges.map(({ from, to }) => ({ from, to })), [
        { from: '2026-07-01', to: '2026-07-30' },
        { from: '2026-07-31', to: '2026-08-12' }
      ]);
      assert.ok(ranges.every(range => range.days <= 30));
    }
    assert.strictEqual(successful.result.events.filter(event => event.type === 'est_range_segmented').length, 1);
    assert.strictEqual(successful.result.events.filter(event => event.type === 'est_range_adaptive_split').length, 0);
    assert.strictEqual(successful.synthetic.requests.exportRequests, 3);
    assert.strictEqual(new Set(successful.synthetic.requests.exportedOrderIds).size, 9);
    assert.strictEqual(successful.synthetic.requests.exportedOrderIds.length, 9, 'split responses must be deduplicated per workgroup before export');
    assert.strictEqual(rowsAsObjects(fs.readFileSync(successful.trackingPath, 'utf8')).length, 7, 'duplicate tracking PINs across exports must remain deduplicated');
    assert.strictEqual(successful.result.events.find(event => event.type === 'est_complete')?.imported, 7);
    assert.ok(!successful.result.stdout.includes('24680'));
    assert.ok(!successful.synthetic.workgroups.some(workgroup => successful.result.stdout.includes(workgroup)));
    assert.ok(!successful.result.stdout.includes('/ship/desktop/'));
  } finally {
    fs.rmSync(successful.temporary, { recursive: true, force: true });
  }

  const failed = await runScenario({ permanentConflict: true });
  try {
    assert.notStrictEqual(failed.result.code, 0);
    assert.deepStrictEqual(fs.readFileSync(failed.trackingPath), failed.sentinel);
    assert.strictEqual(failed.synthetic.requests.exportRequests, 0, 'exports must wait until every workgroup/date segment is resolved');
    assert.ok(failed.synthetic.requests.orderRanges.some(range => range.workgroup === '11111'));
    assert.ok(failed.synthetic.requests.orderRanges.some(range => range.workgroup === '22222'));
    const failure = failed.result.events.find(event => event.type === 'error');
    assert.strictEqual(failure.reasonCode, 'EST_ORDER_RANGE_UNRESOLVED');
    assert.match(failure.message, /previous tracking\.csv was preserved/);
    assert.strictEqual(failure.diagnostic.status, 409);
    assert.strictEqual(failure.diagnostic.applicationCode, 'RANGE_CONFLICT');
    assert.deepStrictEqual(failure.diagnostic.failedDateSpan, { from: '2026-08-05', to: '2026-08-05' });
    assert.strictEqual(failure.diagnostic.workgroupOrdinal, 3);
    assert.strictEqual(failure.diagnostic.adaptiveSplitAttempted, true);
    assert.strictEqual(failed.result.events.filter(event => event.type === 'est_range_adaptive_split').length, 1);
    assert.ok(!failed.result.stdout.includes('24680'));
    assert.ok(!failed.synthetic.workgroups.some(workgroup => failed.result.stdout.includes(workgroup)));
    assert.ok(!failed.result.stdout.includes('/ship/desktop/'));
  } finally {
    fs.rmSync(failed.temporary, { recursive: true, force: true });
  }

  const cancelled = await runScenario({ cancelDuringRange: true });
  try {
    assert.notStrictEqual(cancelled.result.code, 0);
    assert.deepStrictEqual(fs.readFileSync(cancelled.trackingPath), cancelled.sentinel);
    assert.strictEqual(cancelled.result.events.find(event => event.type === 'error')?.reasonCode, 'EST_IMPORT_STOPPED');
    assert.strictEqual(cancelled.synthetic.requests.exportRequests, 0);
  } finally {
    fs.rmSync(cancelled.temporary, { recursive: true, force: true });
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
  testParsersAndDiagnostics();
  testCircuitUnit();
  await testEstDateRangesAndResolution();
  await testEstWorkers();
  await testEstLongRangeIntegration();
  await testTrackingWorkers();
  process.stdout.write('EST and current Tracking API failure-handling integration tests passed.\n');
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
