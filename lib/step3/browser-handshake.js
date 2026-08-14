'use strict';

const { waitForExactPageTarget } = require('../cdp-page-target');

function assertBuiltInBrowserMode(mode) {
  if (String(mode || '').toLowerCase() !== 'builtin') {
    const error = new Error('Step 3 requires Electron\'s built-in browser. External browser modes are unsupported.');
    error.code = 'BUILTIN_BROWSER_REQUIRED';
    throw error;
  }
  return true;
}

module.exports = { assertBuiltInBrowserMode, waitForExactPageTarget };
