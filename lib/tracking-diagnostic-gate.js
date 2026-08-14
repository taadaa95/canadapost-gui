'use strict';

const crypto = require('crypto');
const { TRACKING_API_VERSION, normalizeEnvironment } = require('./tracking-contract');
const { TRACKING_PARSER_VERSION } = require('./tracking-json');

function isSatisfied(config = {}, environment = 'test', apiVersion = TRACKING_API_VERSION, parserVersion = TRACKING_PARSER_VERSION) {
  const selected = normalizeEnvironment(environment);
  return Boolean(
    config.trackingCredentialRevision &&
    config.trackingDiagnosticRevision === config.trackingCredentialRevision &&
    config.trackingDiagnosticEnvironment === selected &&
    config.trackingDiagnosticApiVersion === apiVersion &&
    config.trackingDiagnosticParserVersion === parserVersion &&
    config.trackingDiagnosticSucceededAt
  );
}

function invalidate(config = {}, options = {}) {
  const revisionFactory = options.revisionFactory || crypto.randomUUID;
  return {
    ...config,
    ...(options.newRevision ? { trackingCredentialRevision: revisionFactory() } : {}),
    trackingDiagnosticRevision: '',
    trackingDiagnosticEnvironment: '',
    trackingDiagnosticApiVersion: '',
    trackingDiagnosticParserVersion: '',
    trackingDiagnosticSucceededAt: ''
  };
}

function markSucceeded(config = {}, environment = 'test', options = {}) {
  if (!config.trackingCredentialRevision) throw new Error('A credential revision is required before recording a successful Tracking API diagnostic.');
  return {
    ...config,
    trackingDiagnosticRevision: config.trackingCredentialRevision,
    trackingDiagnosticEnvironment: normalizeEnvironment(environment),
    trackingDiagnosticApiVersion: options.apiVersion || TRACKING_API_VERSION,
    trackingDiagnosticParserVersion: options.parserVersion || TRACKING_PARSER_VERSION,
    trackingDiagnosticSucceededAt: options.succeededAt || new Date().toISOString()
  };
}

module.exports = { isSatisfied, invalidate, markSucceeded };
