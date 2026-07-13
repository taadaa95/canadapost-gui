'use strict';

const assert = require('assert');
const { isCanadaPostUrl, classifyPage, classifyHealthError, activateControl, shouldResetToCanonicalEntry, findLoginControls, finishCli } = require('../scripts/site-health-check');
const { classifyAuthenticatedSnapshot, looksLikeLoginUrl } = require('../lib/canadapost-navigation');

assert.strictEqual(isCanadaPostUrl('https://www.canadapost-postescanada.ca/dash/en'), true);
assert.strictEqual(isCanadaPostUrl('http://www.canadapost-postescanada.ca/dash/en'), false);
assert.strictEqual(isCanadaPostUrl('https://canadapost-postescanada.ca.evil.example/'), false);
assert.strictEqual(classifyPage('Service temporarily unavailable', 'https://www.canadapost-postescanada.ca/').code, 'TEMPORARY_OUTAGE');
assert.strictEqual(classifyPage('Invalid username or password', 'https://www.canadapost-postescanada.ca/').code, 'INCORRECT_CREDENTIALS');
assert.strictEqual(classifyPage('Enter the verification code sent by text message', 'https://www.canadapost-postescanada.ca/').code, 'VERIFICATION_REQUIRED');
assert.strictEqual(classifyPage('Normal page', 'https://example.com/').code, 'UNEXPECTED_DOMAIN');
assert.strictEqual(classifyPage('Normal page', 'https://www.canadapost-postescanada.ca/'), null);

assert.strictEqual(classifyHealthError({ code: 'CONTROL_BLOCKED', message: 'covered' }).status, 'warning');
assert.strictEqual(classifyHealthError({ message: 'locator timeout' }).code, 'SELECTOR_MISSING');
assert.strictEqual(shouldResetToCanonicalEntry({ authenticated: null }, null, false), true);
assert.strictEqual(shouldResetToCanonicalEntry({ authenticated: true }, null, false), false);
assert.strictEqual(shouldResetToCanonicalEntry({ authenticated: null }, { stage: 'support' }, false), false);
assert.strictEqual(shouldResetToCanonicalEntry({ authenticated: null }, null, true), false);

assert.strictEqual(looksLikeLoginUrl('https://www.canadapost-postescanada.ca/lfe-cap/en/login'), true);
assert.strictEqual(classifyAuthenticatedSnapshot({
  url: 'https://www.canadapost-postescanada.ca/dash/en',
  text: 'Dashboard My account Sign out'
}).authenticated, true);
assert.strictEqual(classifyAuthenticatedSnapshot({
  url: 'https://www.canadapost-postescanada.ca/lfe-cap/en/login',
  loginVisible: true
}).authenticated, false);
assert.deepStrictEqual(classifyAuthenticatedSnapshot({
  url: 'https://www.canadapost-postescanada.ca/support',
  navigationStage: 'category'
}), { authenticated: true, confidence: 'high', signal: 'claim-category' });

async function testRealLoginPageDetection() {
  const hidden = {
    first() { return this; },
    isVisible: async () => false
  };
  const visibleButton = {
    first() { return this; },
    isVisible: async () => true
  };
  const page = {
    url: () => 'https://www.canadapost-postescanada.ca/lfe-cap/en/login?targetUrl=%2Fdash%2Fen',
    getByRole: role => role === 'button' ? visibleButton : hidden,
    getByLabel: () => hidden,
    locator: () => hidden
  };

  const controls = await findLoginControls(page, 1);
  assert.strictEqual(controls.recognized, true);
  assert.strictEqual(controls.signInButton, visibleButton);
  assert.strictEqual(controls.usernameBox, null);
  assert.strictEqual(controls.passwordBox, null);
}


async function testUnlabelledLoginFieldProbe() {
  const hidden = {
    first() { return this; },
    isVisible: async () => false
  };
  const visible = {
    first() { return this; },
    isVisible: async () => true
  };
  const markerScope = {
    getByRole: () => hidden,
    getByLabel: () => hidden,
    locator(selector) {
      if (String(selector).includes('data-cp-login-probe="username"')) return visible;
      if (String(selector).includes('data-cp-login-probe="password"')) return visible;
      if (String(selector).includes('data-cp-login-probe="signin"')) return visible;
      return hidden;
    },
    evaluate: async () => true
  };
  const page = {
    ...markerScope,
    url: () => 'https://www.canadapost-postescanada.ca/lfe-cap/en/login',
    frames: () => []
  };

  const controls = await findLoginControls(page, 1);
  assert.strictEqual(controls.recognized, true);
  assert.strictEqual(controls.complete, true);
  assert.strictEqual(controls.usernameBox, visible);
  assert.strictEqual(controls.passwordBox, visible);
  assert.strictEqual(controls.signInButton, visible);
}

async function testLoginControlsInsideFrame() {
  const hidden = {
    first() { return this; },
    isVisible: async () => false
  };
  const visible = {
    first() { return this; },
    isVisible: async () => true
  };
  const frame = {
    getByRole: role => role === 'button' ? visible : hidden,
    getByLabel: pattern => /password/i.test(String(pattern)) ? visible : hidden,
    locator(selector) {
      if (/autocomplete="username"/.test(String(selector))) return visible;
      return hidden;
    },
    evaluate: async () => false
  };
  const page = {
    url: () => 'https://www.canadapost-postescanada.ca/lfe-cap/en/login',
    getByRole: () => hidden,
    getByLabel: () => hidden,
    locator: () => hidden,
    frames: () => [frame]
  };

  const controls = await findLoginControls(page, 1);
  assert.strictEqual(controls.recognized, true);
  assert.strictEqual(controls.complete, true);
}


function testHealthCliForcesExitAfterFlushing() {
  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  let flushed = false;
  let exitedWith = null;
  finishCli(code => { exitedWith = code; }, {
    write(value, callback) {
      assert.strictEqual(value, '');
      flushed = true;
      callback();
    }
  });
  assert.strictEqual(flushed, true);
  assert.strictEqual(exitedWith, 0);
  process.exitCode = originalExitCode;
}

async function testActivationFallbacks() {
  const page = {
    frames: () => [],
    waitForTimeout: async () => {}
  };
  const keyboardTarget = {
    focus: async () => {},
    press: async key => assert.strictEqual(key, 'Enter')
  };
  const keyboardLocator = {
    first() { return this; },
    waitFor: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { throw new Error('overlay'); },
    evaluate: async () => { throw new Error('should not use DOM fallback'); }
  };
  assert.strictEqual(await activateControl(page, keyboardLocator, { keyboardTarget }), 'keyboard');

  const domLocator = {
    first() { return this; },
    waitFor: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    click: async () => { throw new Error('animation'); },
    evaluate: async callback => {
      let clicked = false;
      callback({ closest: () => null, click: () => { clicked = true; } });
      assert.strictEqual(clicked, true);
    }
  };
  assert.strictEqual(await activateControl(page, domLocator), 'dom');
}

testHealthCliForcesExitAfterFlushing();

Promise.all([testRealLoginPageDetection(), testUnlabelledLoginFieldProbe(), testLoginControlsInsideFrame(), testActivationFallbacks()])
  .then(() => console.log('Site-health tests passed.'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
