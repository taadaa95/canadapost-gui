'use strict';

const packageMetadata = require('../package.json');
const { SCHEMA_VERSION } = require('./database-migrations');
const { EST_IMPORT_SCHEMA_VERSION } = require('./est-import-schema');
const { TRACKING_API_VERSION, TRACKING_PLATFORM_RELEASE, TRACKING_ENVIRONMENTS } = require('./tracking-contract');
const { TRACKING_PARSER_VERSION } = require('./tracking-json');
const { SAFE_TRACKING_REQUEST_INTERVAL_MS, MAX_JITTER_MS } = require('./tracking-rate-limiter');

const PRODUCT_METADATA = Object.freeze({
  applicationVersion: packageMetadata.version,
  releaseChannel: packageMetadata.version.includes('-') ? 'beta' : 'stable',
  databaseSchemaVersion: SCHEMA_VERSION,
  estImportSchemaVersion: EST_IMPORT_SCHEMA_VERSION,
  trackingApiVersion: TRACKING_API_VERSION,
  trackingPlatformRelease: TRACKING_PLATFORM_RELEASE,
  trackingParserVersion: TRACKING_PARSER_VERSION,
  trackingRequestIntervalMs: SAFE_TRACKING_REQUEST_INTERVAL_MS,
  trackingJitterMaxMs: MAX_JITTER_MS,
  trackingEnvironments: Object.fromEntries(Object.entries(TRACKING_ENVIRONMENTS).map(([name, value]) => [name, value.gatewayOrigin]))
});

module.exports = { PRODUCT_METADATA };
