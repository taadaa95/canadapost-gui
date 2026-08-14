'use strict';

const fs = require('fs');
const path = require('path');

function inside(root, candidate, pathApi = path) {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative));
}

function resolveOwnedRegularFile(filePath, roots) {
  if (typeof filePath !== 'string' || !filePath || !Array.isArray(roots) || roots.length === 0) return null;
  const resolved = path.resolve(filePath);
  const root = roots.map(value => path.resolve(value)).find(value => inside(value, resolved));
  if (!root) return null;

  try {
    const rootReal = fs.realpathSync(root);
    const relative = path.relative(root, resolved);
    let cursor = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    const targetReal = fs.realpathSync(resolved);
    if (!inside(rootReal, targetReal)) return null;
    const stat = fs.statSync(targetReal);
    return stat.isFile() ? { path: targetReal, size: stat.size } : null;
  } catch (_) {
    return null;
  }
}

module.exports = { inside, resolveOwnedRegularFile };
