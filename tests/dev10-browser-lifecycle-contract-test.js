'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const main = source('main.js');
const renderer = source('renderer.js');
const queue = source('renderer/step3-queue.js');

const submitHandler = main.match(/registerIpcHandler\('submit:run'[\s\S]*?registerIpcHandler\('run:requestStop'/)?.[0] || '';
assert.ok(submitHandler, 'submit handler must be present');
assert.ok(submitHandler.indexOf('createRunSnapshot') < submitHandler.indexOf('prepareBuiltinBrowserForWorker'), 'snapshot validation must happen before browser creation/handshake');
assert.match(submitHandler, /hideBuiltinBrowserView\('submission-validation'\)/);
assert.match(submitHandler, /hideBuiltinBrowserView\('submission-selection-blocked'\)/);

const startSubmit = renderer.match(/async function startSubmitOnly\(\)[\s\S]*?async function refreshConfig/)?.[0] || '';
assert.ok(startSubmit, 'renderer submit function must be present');
assert.doesNotMatch(startSubmit, /prepareBuiltinBrowser\(/, 'renderer must not prepare the native browser before main-process snapshot validation');
assert.doesNotMatch(startSubmit, /step3-run-start/, 'renderer must not expose the browser before selection validation');
assert.match(startSubmit, /deactivateBuiltinBrowser\('validating-selection'/);
assert.match(renderer, /if \(!builtinBrowserRunActive\)[\s\S]*?hideBuiltinBrowser/);
assert.match(renderer, /onBuiltinBrowserVisibilityRequest[\s\S]*?activate: true/);
assert.match(renderer, /let builtinBrowserManualActionPending = false/);
assert.match(
  renderer,
  /if \(result\.visible && builtinBrowserRunActive\)[\s\S]*?builtinBrowserManualActionPending[\s\S]*?waitingForManualActionText/
);
assert.match(
  renderer,
  /type === 'manual_verification_required'[\s\S]*?builtinBrowserManualActionPending = true[\s\S]*?waitingForManualActionText/
);
assert.match(
  renderer,
  /type === 'claim_start'[\s\S]*?builtinBrowserManualActionPending = false/
);
assert.match(
  renderer,
  /onBrowserActivity[\s\S]*?builtinBrowserManualActionPending && builtinBrowserDisplayState\.visible[\s\S]*?waitingForManualActionText/
);
assert.match(main, /function isLoadedCanadaPostUrl[\s\S]*?!isBuiltinMarkerUrl/);
assert.match(main, /function styleBuiltinBrowserMarker[\s\S]*?#07101f/);
assert.doesNotMatch(main, /emitBuiltinBrowserActivity\(false, 'Canada Post page ready'\)/);
assert.match(main, /emitBuiltinBrowserActivity\(false, 'Canada Post loaded'\)/);
assert.match(queue, /if \(isExecutable\(item\)\) selected\.add/);
assert.match(queue, /if \(!item \|\| !isExecutable\(item\)\)/);

process.stdout.write('Dev.10 browser-lifecycle contracts passed.\n');
