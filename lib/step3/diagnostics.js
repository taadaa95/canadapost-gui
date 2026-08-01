'use strict';

const { Step3Diagnostics, sanitizeUrl } = require('../step3-diagnostics');

function createDiagnostics(options = {}) {
  if (options.enabled === false) return null;
  return new Step3Diagnostics(options);
}

module.exports = { Step3Diagnostics, sanitizeUrl, createDiagnostics };
