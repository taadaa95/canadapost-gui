'use strict';

const { firstVisibleLocator, looksLikeLoginUrl } = require('./canadapost-navigation');

const USERNAME_PATTERN = /(?:username|user name|user id|email|e-mail|nom d[’']utilisateur|courriel|login)/i;
const PASSWORD_PATTERN = /(?:password|passcode|mot de passe)/i;
const SIGN_IN_PATTERN = /^(?:sign in|log in|login|connexion|se connecter)$/i;

async function locatorVisible(locator, timeout = 300) {
  if (!locator) return false;
  return locator.first().isVisible({ timeout }).catch(() => false);
}

function scopeCandidates(scope) {
  return {
    signIn: [
      scope.getByRole?.('button', { name: SIGN_IN_PATTERN }),
      scope.getByRole?.('link', { name: SIGN_IN_PATTERN }),
      scope.locator?.('button[type="submit"], input[type="submit"], [role="button"][aria-label*="sign in" i], [role="button"][title*="sign in" i]'),
      scope.locator?.('button, input[type="submit"], [role="button"]').filter?.({ hasText: SIGN_IN_PATTERN })
    ],
    password: [
      scope.getByRole?.('textbox', { name: PASSWORD_PATTERN }),
      scope.getByLabel?.(PASSWORD_PATTERN),
      scope.locator?.('input[type="password"], input[autocomplete="current-password"], input[name*="pass" i], input[id*="pass" i], input[formcontrolname*="pass" i], input[placeholder*="pass" i], input[aria-label*="pass" i], input[data-testid*="pass" i]')
    ],
    username: [
      scope.getByRole?.('textbox', { name: USERNAME_PATTERN }),
      scope.getByLabel?.(USERNAME_PATTERN),
      scope.locator?.('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[id*="user" i], input[formcontrolname*="user" i], input[placeholder*="user" i], input[aria-label*="user" i], input[data-testid*="user" i], input[name*="email" i], input[id*="email" i], input[formcontrolname*="email" i], input[placeholder*="email" i], input[aria-label*="email" i]')
    ]
  };
}

async function markDomLoginCandidates(scope) {
  if (!scope?.evaluate) return false;
  return scope.evaluate(({ usernameSource, passwordSource, signInSource }) => {
    const usernamePattern = new RegExp(usernameSource, 'i');
    const passwordPattern = new RegExp(passwordSource, 'i');
    const signInPattern = new RegExp(signInSource, 'i');

    function deepQuery(root, selector, output = []) {
      if (!root?.querySelectorAll) return output;
      for (const element of root.querySelectorAll(selector)) output.push(element);
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) deepQuery(element.shadowRoot, selector, output);
      }
      return output;
    }

    function visible(element) {
      if (!element || element.disabled) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 8
        && rect.height > 8;
    }

    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function descriptor(element) {
      const values = [
        element.getAttribute('name'),
        element.getAttribute('id'),
        element.getAttribute('type'),
        element.getAttribute('placeholder'),
        element.getAttribute('autocomplete'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('formcontrolname'),
        element.getAttribute('data-testid'),
        element.getAttribute('data-test'),
        element.getAttribute('data-qa')
      ];
      const id = element.getAttribute('id');
      if (id) {
        try {
          const escaped = globalThis.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
          const label = element.ownerDocument?.querySelector(`label[for="${escaped}"]`);
          if (label) values.push(label.textContent);
        } catch (_) {}
      }
      const wrappingLabel = element.closest?.('label');
      if (wrappingLabel) values.push(wrappingLabel.textContent);
      return normalized(values.filter(Boolean).join(' '));
    }

    function buttonLabel(element) {
      return normalized([
        element.innerText,
        element.textContent,
        element.value,
        element.getAttribute('aria-label'),
        element.getAttribute('title')
      ].filter(Boolean).join(' '));
    }

    const allMarked = deepQuery(document, '[data-cp-login-probe]');
    for (const element of allMarked) element.removeAttribute('data-cp-login-probe');

    const editables = deepQuery(document, 'input, textarea, [contenteditable="true"]')
      .filter(visible)
      .filter(element => {
        const type = String(element.getAttribute('type') || '').toLowerCase();
        return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].includes(type);
      });

    const controls = deepQuery(document, 'button, input[type="submit"], input[type="button"], [role="button"], a')
      .filter(visible);

    let signIn = controls.find(element => signInPattern.test(buttonLabel(element)))
      || controls.find(element => {
        const type = String(element.getAttribute('type') || '').toLowerCase();
        return type === 'submit' && /sign|login|connexion/i.test(buttonLabel(element) || descriptor(element));
      })
      || controls.find(element => String(element.getAttribute('type') || '').toLowerCase() === 'submit');

    let password = editables.find(element => String(element.getAttribute('type') || '').toLowerCase() === 'password')
      || editables.find(element => passwordPattern.test(descriptor(element)));

    let username = editables.find(element => element !== password && usernamePattern.test(descriptor(element)));

    const form = signIn?.closest?.('form') || password?.closest?.('form') || username?.closest?.('form') || null;
    const formEditables = form
      ? editables.filter(element => element.closest?.('form') === form)
      : editables;

    if (!password) {
      password = formEditables.find(element => String(element.getAttribute('type') || '').toLowerCase() === 'password')
        || formEditables.find(element => passwordPattern.test(descriptor(element)));
    }

    if (!username) {
      const eligible = formEditables.filter(element => element !== password);
      if (password) {
        const passwordIndex = formEditables.indexOf(password);
        username = eligible
          .filter(element => formEditables.indexOf(element) < passwordIndex)
          .at(-1) || eligible[0] || null;
      } else if (eligible.length === 1 || (signIn && eligible.length <= 3)) {
        username = eligible[0] || null;
      }
    }

    if (!signIn && form) {
      signIn = controls.find(element => element.closest?.('form') === form && String(element.getAttribute('type') || '').toLowerCase() === 'submit') || null;
    }

    if (username) username.setAttribute('data-cp-login-probe', 'username');
    if (password) password.setAttribute('data-cp-login-probe', 'password');
    if (signIn) signIn.setAttribute('data-cp-login-probe', 'signin');

    return Boolean(username || password || signIn);
  }, {
    usernameSource: USERNAME_PATTERN.source,
    passwordSource: PASSWORD_PATTERN.source,
    signInSource: SIGN_IN_PATTERN.source
  }).catch(() => false);
}

async function findLoginControlsInScope(scope, timeout = 3000) {
  const candidates = scopeCandidates(scope);
  const fieldTimeout = Math.max(250, Number(timeout) || 0);

  let signInButton = await firstVisibleLocator(candidates.signIn, fieldTimeout);
  let passwordBox = await firstVisibleLocator(candidates.password, fieldTimeout);
  let usernameBox = await firstVisibleLocator(candidates.username, fieldTimeout);

  if (!usernameBox || !passwordBox || !signInButton) {
    await markDomLoginCandidates(scope);
    if (!usernameBox) usernameBox = await firstVisibleLocator([scope.locator?.('[data-cp-login-probe="username"]')], 500);
    if (!passwordBox) passwordBox = await firstVisibleLocator([scope.locator?.('[data-cp-login-probe="password"]')], 500);
    if (!signInButton) signInButton = await firstVisibleLocator([scope.locator?.('[data-cp-login-probe="signin"]')], 500);
  }

  return {
    usernameBox,
    passwordBox,
    signInButton,
    complete: Boolean(usernameBox && passwordBox && signInButton)
  };
}

function loginControlScore(controls) {
  return Number(Boolean(controls.usernameBox))
    + Number(Boolean(controls.passwordBox))
    + Number(Boolean(controls.signInButton));
}

async function findLoginControls(page, timeout = 3000) {
  const scopes = [page];
  if (typeof page?.frames === 'function') {
    for (const frame of page.frames()) {
      if (frame && !scopes.includes(frame)) scopes.push(frame);
    }
  }

  let best = { usernameBox: null, passwordBox: null, signInButton: null, complete: false };
  const perScopeTimeout = Math.max(250, Math.floor((Number(timeout) || 0) / Math.max(1, scopes.length)));

  for (const scope of scopes) {
    const controls = await findLoginControlsInScope(scope, perScopeTimeout);
    if (loginControlScore(controls) > loginControlScore(best)) best = controls;
    if (controls.complete) {
      best = controls;
      break;
    }
  }

  return {
    ...best,
    recognized: looksLikeLoginUrl(page.url()) && loginControlScore(best) > 0
  };
}

async function describeEditableControls(page) {
  const scopes = [page];
  if (typeof page?.frames === 'function') {
    for (const frame of page.frames()) if (frame && !scopes.includes(frame)) scopes.push(frame);
  }

  const results = [];
  for (const scope of scopes) {
    const locator = scope.locator?.('input, textarea, [contenteditable="true"]');
    if (!locator || typeof locator.evaluateAll !== 'function') continue;
    const items = await locator.evaluateAll(elements => {
      const visible = element => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 8 && rect.height > 8;
      };
      return elements.filter(visible).slice(0, 10).map(element => ({
        tag: element.tagName.toLowerCase(),
        type: String(element.getAttribute('type') || ''),
        name: String(element.getAttribute('name') || ''),
        id: String(element.getAttribute('id') || ''),
        autocomplete: String(element.getAttribute('autocomplete') || ''),
        placeholder: String(element.getAttribute('placeholder') || ''),
        ariaLabel: String(element.getAttribute('aria-label') || ''),
        formControlName: String(element.getAttribute('formcontrolname') || '')
      }));
    }).catch(() => []);
    for (const item of items || []) results.push(item);
  }
  return results.slice(0, 12);
}

module.exports = {
  USERNAME_PATTERN,
  PASSWORD_PATTERN,
  SIGN_IN_PATTERN,
  markDomLoginCandidates,
  findLoginControlsInScope,
  findLoginControls,
  describeEditableControls,
  locatorVisible
};
