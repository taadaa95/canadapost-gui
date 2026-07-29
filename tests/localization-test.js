'use strict';

const assert = require('assert');
const { assertLocaleCompleteness, loadLocale, normalizeLocale, translate } = require('../lib/i18n');

const keys = assertLocaleCompleteness();
assert.ok(keys.length >= 35);
assert.strictEqual(normalizeLocale('fr'), 'fr-CA');
assert.strictEqual(normalizeLocale('en-US'), 'en-CA');
const french = loadLocale('fr-CA');
assert.strictEqual(translate(french, 'classification.REVIEW_REQUIRED'), 'Révision requise');
assert.ok(!Object.values(french.messages).some(value => !String(value).trim()));
process.stdout.write('Localization completeness tests passed.\n');
