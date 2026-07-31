'use strict';

const assert = require('assert');
const { assertLocaleCompleteness, loadLocale, normalizeLocale, translate, interpolate } = require('../lib/i18n');

const keys = assertLocaleCompleteness();
assert.ok(keys.length >= 35);
assert.strictEqual(normalizeLocale('fr'), 'fr-CA');
assert.strictEqual(normalizeLocale('en-US'), 'en-CA');
const french = loadLocale('fr-CA');
assert.strictEqual(translate(french, 'classification.REVIEW_REQUIRED'), 'Révision requise');
assert.strictEqual(translate(french, 'history.clearFilters'), 'Effacer les filtres');
assert.strictEqual(translate(french, 'missing.key', 'Fallback text'), 'Fallback text');
assert.strictEqual(interpolate(translate(french, 'step3.selectedCount'), { selected: 2, total: 4 }), '2 sur 4 sélectionnés');
assert.strictEqual(interpolate('Keep {tracking} and {phone}', { tracking: '1234567890123456', phone: '1-888-550-6333' }), 'Keep 1234567890123456 and 1-888-550-6333');
assert.ok(french.messages['step3.supportGuidance'].includes('1-888-550-6333'));
assert.ok(!Object.values(french.messages).some(value => !String(value).trim()));
process.stdout.write('Localization completeness tests passed.\n');
