'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { classifyEligibility } = require('../lib/policy-engine');

const root = path.resolve(__dirname, '..');
const operatorSources = [
  'index.html', 'renderer.js', 'preload.js', 'locales/en-CA.json', 'locales/fr-CA.json',
  'renderer/step2-copy.js', 'renderer/step3-queue.js'
].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

assert.doesNotMatch(operatorSources, /earliest delivery attempt[^\n]{0,180}(?:lateness|late|occurred after)/i, 'obsolete first-attempt lateness explanation must be absent');
assert.doesNotMatch(operatorSources, /automatic(?:ally)? (?:eligible|eligibility)|confirmed eligible|eligible claims queue|submit eligible claims/i, 'automatic candidates must not be presented as confirmed eligible');
assert.match(operatorSources, /successful-delivery date against the original Delivery Standard/i);
assert.match(operatorSources, /Canada Post makes the final eligibility decision/i);
assert.match(operatorSources, /No late-delivery candidates are available/i);
assert.match(operatorSources, /Submit selected candidates/i);
assert.doesNotMatch(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<option value="expired">/i, 'stale policy must not offer a definitive expired queue filter');
assert.match(operatorSources, /Unverified advisory estimate|Estimation indicative non vérifiée/i);

const classification = classifyEligibility({
  trackingNumber: 'SYNTHETIC-CONTRACT',
  originalExpectedDeliveryDate: '2026-07-01',
  expectedDeliveryDate: '2026-07-01',
  firstAttemptDate: '2026-07-01',
  actualDeliveryDate: '2026-07-02'
}, { asOf: '2026-07-03', classificationTimestamp: '2026-07-03T12:00:00.000Z' });
assert.strictEqual(classification.classification, 'LATE_CANDIDATE');
assert.strictEqual(classification.automaticallyEligible, false);
process.stdout.write('Product review terminology and classifier contracts passed.\n');
