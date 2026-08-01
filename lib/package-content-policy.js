'use strict';

const path = require('path');

const PROHIBITED_SEGMENTS = new Set([
  'browser-profile',
  'browser_state',
  'data',
  'logs',
  'tests',
  'mock-portal',
  'fixtures',
  '.local-browsers',
  'ms-playwright'
]);
const PROHIBITED_NAMES = new Set([
  '.env',
  'config.local.json',
  'credentials.json',
  'credential-key.bin',
  'user.ini',
  'tracking.csv',
  'claims.csv',
  'claim-state.json',
  'claim-history.jsonl'
]);

function normalizedSegments(relativePath) {
  return String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
}

function prohibitedPackagePath(relativePath) {
  const segments = normalizedSegments(relativePath);
  const lower = segments.map(value => value.toLowerCase());
  const name = lower.at(-1) || '';
  if (lower.some(segment => PROHIBITED_SEGMENTS.has(segment) || segment.startsWith('browser-profile-temp-'))) return 'runtime, test, fixture, or browser-profile content';
  if (lower.includes('node_modules') && lower[lower.indexOf('node_modules') + 1] === 'playwright') return 'full Playwright package';
  if (PROHIBITED_NAMES.has(name) || name.startsWith('.env.')) return 'credential or runtime-data file';
  if (name.endsWith('.map')) return 'source map';
  if (/^(?:chrome|chrome-headless-shell)(?:\.exe)?$/i.test(name)) return 'Playwright browser executable';
  if (/\.(?:log|sqlite|sqlite-shm|sqlite-wal)$/i.test(name)) return 'log or runtime database';
  return '';
}

function auditPackagePaths(paths) {
  return paths.map(value => ({ path: value, reason: prohibitedPackagePath(value) })).filter(item => item.reason);
}

function collectRelativePaths(root) {
  const paths = [];
  const walk = directory => {
    for (const entry of require('fs').readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).replace(/\\/g, '/');
      paths.push(relative);
      if (entry.isDirectory()) walk(target);
    }
  };
  walk(root);
  return paths;
}

module.exports = { PROHIBITED_SEGMENTS, PROHIBITED_NAMES, prohibitedPackagePath, auditPackagePaths, collectRelativePaths };
