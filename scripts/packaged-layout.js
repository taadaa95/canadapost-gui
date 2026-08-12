'use strict';

const fs = require('fs');
const path = require('path');

const PRODUCT_NAME = 'Canada Post Claim Runner';

function resolvePackagedLayout(target, platform = process.platform) {
  const packageTarget = path.resolve(target);
  if (platform === 'darwin') {
    if (!packageTarget.endsWith('.app') || !fs.statSync(packageTarget, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('The packaged macOS target must be a .app bundle.');
    }
    const contentsPath = path.join(packageTarget, 'Contents');
    const resourcesPath = path.join(contentsPath, 'Resources');
    return Object.freeze({
      packageTarget,
      executablePath: path.join(contentsPath, 'MacOS', PRODUCT_NAME),
      resourcesPath,
      appPath: path.join(resourcesPath, 'app.asar'),
      platform
    });
  }
  const resourcesPath = path.join(packageTarget, 'resources');
  return Object.freeze({
    packageTarget,
    executablePath: path.join(packageTarget, platform === 'win32' ? `${PRODUCT_NAME}.exe` : 'canadapost-gui'),
    resourcesPath,
    appPath: path.join(resourcesPath, 'app.asar'),
    platform
  });
}

module.exports = { PRODUCT_NAME, resolvePackagedLayout };
