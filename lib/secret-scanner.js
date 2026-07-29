'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_SEGMENTS = new Set(['.git', 'node_modules', 'data', 'logs', 'dist', 'release', '.cache']);
const SKIP_NAMES = new Set(['user.ini', 'config.local.json', 'config.json', 'credentials.json', 'credential-key.bin']);
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.md', '.html', '.css', '.yml', '.yaml', '.xml', '.wsdl', '.xsd', '.sh', '.php', '.ini', '.txt', '.csv']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function patterns() {
  const privateKey = ['BEGIN ', '(?:RSA |EC |OPENSSH |DSA )?', 'PRIVATE KEY'].join('');
  const bearer = ['author', 'ization\\s*[:=]\\s*bearer\\s+[a-z0-9._~+\\/-]{16,}'].join('');
  const assignments = ['(?:pass', 'word|passwd|pwd|api[_-]?key|access[_-]?token|client[_-]?secret|cookie|session)\\s*[:=]\\s*["\']([^"\']{8,})["\']'].join('');
  return [
    { id: 'PRIVATE_KEY', regex: new RegExp(privateKey, 'i') },
    { id: 'AUTHORIZATION_BEARER', regex: new RegExp(bearer, 'i') },
    { id: 'AWS_ACCESS_KEY', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { id: 'GITHUB_TOKEN', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
    { id: 'STRIPE_SECRET', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
    { id: 'GENERIC_CREDENTIAL_ASSIGNMENT', regex: new RegExp(assignments, 'i'), capture: 1 }
  ];
}

function placeholder(value) {
  return /(?:^|[_-])(?:your|example|sample|synthetic|test|dummy|placeholder|redacted|changeme|notset)(?:[_-]|$)/i.test(String(value || ''));
}

function entropy(value) {
  const text = String(value || '');
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) || 0) + 1);
  return [...counts.values()].reduce((sum, count) => {
    const probability = count / text.length;
    return sum - probability * Math.log2(probability);
  }, 0);
}

function likelyCredential(value) {
  const text = String(value || '').replace(/^["']|["']$/g, '');
  if (placeholder(text) || text.length < 12 || /\b(?:process|string|buffer|options|config|input|value|password)\b/i.test(text)) return false;
  const categories = [/[a-z]/.test(text), /[A-Z]/.test(text), /\d/.test(text), /[^a-z0-9]/i.test(text)].filter(Boolean).length;
  return entropy(text) >= 3.2 && (categories >= 3 || text.length >= 24);
}

function scanText(text, relativePath) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  const rules = patterns();
  lines.forEach((line, index) => {
    for (const rule of rules) {
      const match = line.match(rule.regex);
      if (!match) continue;
      if (rule.capture && !likelyCredential(match[rule.capture])) continue;
      if (relativePath.endsWith('secret-scanner.js')) continue;
      findings.push({ rule: rule.id, path: relativePath, line: index + 1, redacted: '[REDACTED POTENTIAL SECRET]' });
    }
  });
  return findings;
}

function walk(root) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (SKIP_SEGMENTS.has(entry.name)) continue;
      if (SKIP_NAMES.has(entry.name.toLowerCase()) || /^\.env(?:\.|$)/i.test(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && fs.statSync(absolute).size <= MAX_FILE_BYTES) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function scanPaths(root, relativePaths) {
  const findings = [];
  const files = relativePaths ? relativePaths.map(file => path.join(root, file)) : walk(root);
  for (const absolute of files) {
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size > MAX_FILE_BYTES) continue;
    findings.push(...scanText(fs.readFileSync(absolute, 'utf8'), path.relative(root, absolute).split(path.sep).join('/')));
  }
  return findings;
}

module.exports = { scanText, scanPaths };
