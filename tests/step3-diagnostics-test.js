'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Step3Diagnostics, pruneStep3DiagnosticRuns, classifyKnownPageIssue } = require('../lib/step3-diagnostics');

class MockFrame {
  constructor(url) { this._url = url; }
  url() { return this._url; }
  name() { return ''; }
  async evaluate() {
    return {
      url: `${this._url}?tracking=1234567890123456&token=secret-token`,
      name: 'mock-frame',
      forms: 1,
      controls: [
        {
          tag: 'input',
          type: 'text',
          id: 'username',
          name: 'username',
          role: '',
          label: 'Email user@example.com',
          enabled: true,
          readOnly: false,
          valuePresent: true,
          valueLength: 17
        },
        {
          tag: 'input',
          type: 'password',
          id: 'password',
          name: 'password',
          role: '',
          label: 'Password',
          enabled: true,
          readOnly: false,
          valuePresent: true,
          valueLength: 11
        }
      ],
      visibleText: 'Tracking 1234567890123456 email user@example.com phone 514-555-1212 postal A1A 1A1 secret-password'
    };
  }
}

class MockPage extends EventEmitter {
  constructor() {
    super();
    this.frame = new MockFrame('https://www.canadapost-postescanada.ca/claim/form');
  }
  url() { return 'https://www.canadapost-postescanada.ca/claim/form?token=secret-token#private'; }
  frames() { return [this.frame]; }
  mainFrame() { return this.frame; }
  async title() { return 'Claim for 1234567890123456'; }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-step3-diagnostics-test-'));
  try {
    const runDirectory = path.join(root, 'step3-run');
    const diagnostics = new Step3Diagnostics({
      runDirectory,
      appVersion: '0.3.4',
      runId: 42,
      dryRun: true,
      browserMode: 'builtin'
    });
    diagnostics.setSensitiveValues(['secret-password', 'secret-token', 'user@example.com', '123 Example Street']);
    diagnostics.setClaim({ index: 1, total: 2, row: 2, trackingNumber: '1234567890123456' });
    diagnostics.state('claim-form');
    diagnostics.record('info', 'test', 'sensitive-event', {
      trackingNumber: '1234567890123456',
      username: 'user@example.com',
      password: 'secret-password',
      url: 'https://example.invalid/path?token=secret-token',
      message: 'Call 514-555-1212 at A1A 1A1',
      filePath: path.join(os.homedir(), 'private', 'file.txt')
    });

    await diagnostics.operation('fast-operation', {}, async () => true);
    await assert.rejects(
      diagnostics.operation('failed-operation', {}, async () => { throw new Error('secret-password failed'); }),
      /failed/
    );

    const page = new MockPage();
    diagnostics.attachPage(page, 'mock-page');
    page.emit('framenavigated', page.frame);
    page.emit('console', { type: () => 'warning', text: () => 'user@example.com console warning', location: () => ({ url: page.url(), lineNumber: 1 }) });
    page.emit('console', { type: () => 'error', text: () => 'Failed to load resource: oamSubmit.js returned 404', location: () => ({ url: 'https://www.canadapost-postescanada.ca/information/app/javax.faces.resource/oamSubmit.js', lineNumber: 0 }) });
    page.emit('pageerror', new Error("Cannot read properties of undefined (reading 'TenantFeatures')"));
    page.emit('requestfailed', {
      method: () => 'POST', resourceType: () => 'xhr', url: () => 'https://www.canadapost-postescanada.ca/api?token=secret-token', failure: () => ({ errorText: 'net::ERR_FAILED' })
    });
    await diagnostics.capturePageState(page, 'mock-state');
    diagnostics.clearClaim({ status: 'dry_run_ready' });
    await diagnostics.finalize({ outcome: 'test-complete' });

    for (const name of ['manifest.json', 'timeline.jsonl', 'step3-detailed.log', 'summary.json', 'live-status.json']) {
      assert.ok(fs.existsSync(path.join(runDirectory, name)), `Missing ${name}`);
    }

    const allText = [
      fs.readFileSync(path.join(runDirectory, 'timeline.jsonl'), 'utf8'),
      fs.readFileSync(path.join(runDirectory, 'step3-detailed.log'), 'utf8'),
      fs.readFileSync(path.join(runDirectory, 'summary.json'), 'utf8'),
      ...fs.readdirSync(path.join(runDirectory, 'page-states')).map(name => fs.readFileSync(path.join(runDirectory, 'page-states', name), 'utf8'))
    ].join('\n');

    assert.ok(!allText.includes('secret-password'));
    assert.ok(!allText.includes('secret-token'));
    assert.ok(!allText.includes('user@example.com'));
    assert.ok(!allText.includes('1234567890123456'));
    assert.ok(!allText.includes('514-555-1212'));
    assert.ok(!allText.includes('A1A 1A1'));
    assert.ok(!allText.includes('?token='));
    assert.ok(allText.includes('************3456'));
    assert.ok(allText.includes('[CONFIGURED]') || allText.includes('[REDACTED]'));

    const summary = JSON.parse(fs.readFileSync(path.join(runDirectory, 'summary.json'), 'utf8'));
    assert.strictEqual(summary.outcome, 'test-complete');
    assert.ok(summary.operations.some(item => item.name === 'fast-operation' && item.success === 1));
    assert.ok(summary.operations.some(item => item.name === 'failed-operation' && item.failure === 1));
    assert.ok(summary.pageStateCount >= 1);
    assert.strictEqual(summary.automationErrorCount, 1, 'only the intentional failed operation should count as an automation error');
    assert.ok(summary.siteIssueCount >= 2, 'known Canada Post page defects should be separated from automation errors');
    assert.strictEqual(classifyKnownPageIssue('Cannot read properties of undefined (reading TenantFeatures)', ''), 'cookie-banner-sdk');
    assert.strictEqual(classifyKnownPageIssue('', 'https://example.invalid/oamSubmit.js'), 'canada-post-missing-oam-script');


    const pruneRoot = path.join(root, 'prune-runs');
    fs.mkdirSync(pruneRoot, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      const directory = path.join(pruneRoot, `step3-run-${index}`);
      fs.mkdirSync(directory, { recursive: true });
      const old = new Date(Date.now() - ((index + 1) * 10 * 24 * 60 * 60 * 1000));
      fs.utimesSync(directory, old, old);
    }
    const protectedRun = path.join(pruneRoot, 'step3-run-3');
    const pruneResult = pruneStep3DiagnosticRuns(pruneRoot, {
      maxAgeDays: 15,
      maxRuns: 2,
      protectedPaths: [protectedRun]
    });
    assert(fs.existsSync(protectedRun), 'protected diagnostic run should be retained');
    assert(pruneResult.removed.length >= 2, 'expired/excess diagnostic runs should be removed');

    console.log('Step 3 diagnostics tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
