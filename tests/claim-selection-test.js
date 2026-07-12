const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getClaimsToRun, isTerminalClaimState, isCanadaPostUrl } = require('../scripts/submit-claims');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-claim-test-'));
try {
  assert.strictEqual(isTerminalClaimState('in_progress'), true);
  assert.strictEqual(isTerminalClaimState('submitted'), true);
  assert.strictEqual(isTerminalClaimState('failed'), false);
  assert.strictEqual(isCanadaPostUrl('https://www.canadapost-postescanada.ca/dash/en'), true);
  assert.strictEqual(isCanadaPostUrl('https://example.com/'), false);

  fs.writeFileSync(path.join(tempRoot, 'claim-state.json'), JSON.stringify({
    version: 1,
    claims: {
      TERMINAL1: { status: 'in_progress' },
      RETRY1: { status: 'failed', attempts: 1 },
      EXHAUSTED1: { status: 'failed', attempts: 3 }
    }
  }));

  const rows = [
    { _csvRowNumber: 2, 'Tracking PIN': 'GOOD1', Status: 'ELIGIBLE - DELIVERED LATE', 'Actual Delivery Date': '2026-07-01' },
    { _csvRowNumber: 3, 'Tracking PIN': 'BAD1', Status: 'OVERDUE - IN TRANSIT', 'Actual Delivery Date': '' },
    { _csvRowNumber: 4, 'Tracking PIN': 'TERMINAL1', Status: 'ELIGIBLE - DELIVERED LATE', 'Actual Delivery Date': '2026-07-01' },
    { _csvRowNumber: 5, 'Tracking PIN': 'RETRY1', Status: 'ELIGIBLE - DELIVERED LATE', 'Actual Delivery Date': '2026-07-01' },
    { _csvRowNumber: 6, 'Tracking PIN': 'EXHAUSTED1', Status: 'ELIGIBLE - DELIVERED LATE', 'Actual Delivery Date': '2026-07-01' },
    { _csvRowNumber: 7, 'Tracking PIN': 'GOOD1', Status: 'ELIGIBLE - DELIVERED LATE', 'Actual Delivery Date': '2026-07-01' }
  ];

  const selected = getClaimsToRun(rows, tempRoot).claims.map(row => row['Tracking PIN']);
  assert.deepStrictEqual(selected, ['GOOD1', 'RETRY1']);
  const state = JSON.parse(fs.readFileSync(path.join(tempRoot, 'claim-state.json'), 'utf8'));
  assert.strictEqual(state.claims.TERMINAL1.status, 'unknown');
  console.log('Claim selection tests passed.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
