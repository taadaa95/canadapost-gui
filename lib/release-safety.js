'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const allowlist = require('../config/release-allowlist.json');

function posixPath(value) {
  return String(value || '').split(path.sep).join('/').replace(/^\.\//, '');
}

function isProhibited(relativePath) {
  const clean = posixPath(relativePath);
  const segments = clean.split('/');
  const base = segments.at(-1).toLowerCase();
  if (allowlist.prohibitedSegments.some(segment => segments.some(item => item.toLowerCase() === segment.toLowerCase()))) return true;
  if (allowlist.prohibitedNames.some(name => base === name.toLowerCase())) return true;
  if (/^\.env(?:\.|$)/i.test(base)) return true;
  return allowlist.prohibitedExtensions.some(extension => base.endsWith(extension.toLowerCase()));
}

function isAllowed(relativePath) {
  const clean = posixPath(relativePath);
  if (!clean || isProhibited(clean)) return false;
  if (!clean.includes('/')) return allowlist.allowedRootFiles.includes(clean);
  const directory = Object.keys(allowlist.allowedDirectories).find(prefix => clean.startsWith(`${prefix}/`));
  if (!directory) return false;
  return allowlist.allowedDirectories[directory].includes(path.extname(clean).toLowerCase());
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function trackedFiles(root) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
  return output.toString('utf8').split('\0').filter(Boolean).map(posixPath)
    .filter(relativePath => fs.existsSync(path.join(root, relativePath)))
    .sort();
}

function auditFileList(files) {
  const prohibited = files.filter(isProhibited);
  const unexpected = files.filter(file => !isProhibited(file) && !isAllowed(file));
  return { ok: prohibited.length === 0 && unexpected.length === 0, prohibited, unexpected };
}

function sourceManifest(root, files) {
  return files.map(relativePath => {
    const absolute = path.join(root, relativePath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error(`Release entry is not a regular file: ${relativePath}`);
    return { path: posixPath(relativePath), bytes: stat.size, sha256: sha256File(absolute) };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function assertCleanGit(root) {
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  if (status.trim()) throw new Error('Safe release requires a clean Git worktree. Commit reviewed source changes before building.');
}

module.exports = { allowlist, posixPath, isProhibited, isAllowed, sha256File, trackedFiles, auditFileList, sourceManifest, assertCleanGit };
