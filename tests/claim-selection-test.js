const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claimDb = require('../lib/claim-database');
const { getClaimsToRun, isCanadaPostUrl } = require('../scripts/submit-claims');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'canadapost-claim-test-'));
const dbPath = path.join(tempRoot, 'database', 'app.sqlite');
try {
  assert.strictEqual(isCanadaPostUrl('https://www.canadapost-postescanada.ca/dash/en'), true);
  assert.strictEqual(isCanadaPostUrl('https://example.com/'), false);

  fs.writeFileSync(path.join(tempRoot, 'claim-state.json'), JSON.stringify({
    version: 1,
    claims: {
      TERMINAL1: { status: 'in_progress', attempts: 1 },
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

  const selected = getClaimsToRun(rows, tempRoot, dbPath).claims.map(row => row['Tracking PIN']);
  assert.deepStrictEqual(selected, ['GOOD1', 'RETRY1']);
  assert.strictEqual(claimDb.latestAttemptState(dbPath, 'TERMINAL1').status, 'unknown');
  assert.strictEqual(claimDb.latestAttemptState(dbPath, 'EXHAUSTED1').attempt_number, 3);
  console.log('Claim selection tests passed.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
