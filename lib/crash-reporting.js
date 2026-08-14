'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sanitizeText } = require('./archive-tools');

class DisabledCrashProvider {
  constructor() { this.name = 'disabled'; }
  async send() { throw new Error('Crash upload is disabled. Review and share the local report manually.'); }
}

function sanitizeCrashValue(value, sensitiveValues = []) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value, (_key, nested) => {
    if (typeof nested === 'string' && nested.length > 4096) return `${nested.slice(0, 4096)}…`;
    return nested;
  });
  return sanitizeText(serialized, sensitiveValues)
    .replace(/\b[A-Z0-9]{10,24}\b/g, '[IDENTIFIER]')
    .slice(0, 200000);
}

function sanitizeStructured(value, sensitiveValues = [], depth = 0) {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeStructured(item, sensitiveValues, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, nested]) => [
      String(key).slice(0, 128),
      /password|cookie|authorization|credential|token|address|postal|tracking|customer|form/i.test(key)
        ? '[REDACTED]'
        : sanitizeStructured(nested, sensitiveValues, depth + 1)
    ]));
  }
  if (typeof value === 'string') return sanitizeCrashValue(value, sensitiveValues);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return String(value || '').slice(0, 1024);
}

function createLocalCrashReport({ directory, error, context = {}, appVersion = '', sensitiveValues = [] }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const report = {
    format: 'canadapost-claim-runner-crash-report', version: 1,
    reportId: crypto.randomUUID(), createdAt: new Date().toISOString(),
    appVersion: String(appVersion), platform: process.platform, arch: process.arch,
    consent: { uploadEnabled: false, reviewedByUser: false },
    error: {
      name: String(error?.name || 'Error').slice(0, 128),
      message: sanitizeCrashValue(error?.message || 'Unknown error', sensitiveValues),
      stack: sanitizeCrashValue(error?.stack || '', sensitiveValues)
    },
    context: sanitizeStructured(context, sensitiveValues)
  };
  const destination = path.join(directory, `crash-${report.createdAt.replace(/[:.]/g, '-')}-${report.reportId}.json`);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  return { destination, report };
}

module.exports = { DisabledCrashProvider, sanitizeCrashValue, sanitizeStructured, createLocalCrashReport };
