'use strict';

const crypto = require('crypto');

const FORMAT = 'canadapost-claim-runner-support-bundle';
const VERSION = 1;
const COMPONENTS = Object.freeze({
  system: Object.freeze({ defaultIncluded: true, sensitive: false }),
  settings: Object.freeze({ defaultIncluded: true, sensitive: false }),
  history: Object.freeze({ defaultIncluded: false, sensitive: true }),
  logs: Object.freeze({ defaultIncluded: false, sensitive: true }),
  step3Diagnostics: Object.freeze({ defaultIncluded: false, sensitive: true })
});

function supportReferenceId(now = new Date(), randomBytes = crypto.randomBytes) {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `CPCR-${date}-${randomBytes(5).toString('hex').toUpperCase()}`;
}

function selectedComponents(value) {
  const requested = Array.isArray(value)
    ? value
    : Object.entries(COMPONENTS).filter(([, definition]) => definition.defaultIncluded).map(([name]) => name);
  return [...new Set(requested.map(String))].filter(name => Object.prototype.hasOwnProperty.call(COMPONENTS, name));
}

function preview(options = {}) {
  const selected = selectedComponents(options.components);
  return {
    format: FORMAT,
    version: VERSION,
    supportReferenceId: String(options.supportReferenceId || supportReferenceId()),
    applicationVersion: String(options.applicationVersion || ''),
    platform: String(options.platform || process.platform),
    architecture: String(options.architecture || process.arch),
    databaseSchemaVersion: Number(options.databaseSchemaVersion || 0),
    trackingParserVersion: String(options.trackingParserVersion || ''),
    selectedComponents: selected,
    components: Object.fromEntries(Object.entries(COMPONENTS).map(([name, definition]) => [name, {
      selected: selected.includes(name),
      explicitOptIn: definition.sensitive
    }])),
    exclusions: [
      'credentials', 'tokens', 'cookies', 'browser profiles', 'raw Tracking API response bodies',
      'screenshots', 'private keys', 'full tracking numbers', 'addresses and contact details',
      'filenames and free-form operational text'
    ],
    warning: 'Review the generated archive before sharing it. Free-form history, log, and Step 3 diagnostic text is excluded; optional components contain masked records or metadata only.'
  };
}

module.exports = { FORMAT, VERSION, COMPONENTS, supportReferenceId, selectedComponents, preview };
