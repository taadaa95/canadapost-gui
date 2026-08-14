'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { OperationCoordinator } = require('../lib/operation-coordinator');
const { DOM_CHANGE_SENTINEL, ACTION_SENTINEL_PREFIX, safeBackNavigationState, createSetupAssistantController } = require('../main/setup-assistant-controller');
const { SETUP_PARTITION, DEVELOPER_PORTAL_URL } = require('../lib/setup-assistant');

class FakeSession extends EventEmitter {
  setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler; }
  setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler; }
}

class FakeWebContents extends EventEmitter {
  constructor(session, behavior = {}) {
    super();
    this.session = session;
    this.behavior = behavior;
    this.url = 'about:blank';
    this.destroyed = false;
    this.executed = [];
    this.loadedUrls = [];
    this.historyEntries = [{ url: 'about:blank' }];
    this.historyIndex = 0;
    this.goBackCount = 0;
    this.historyClearCount = 0;
    this.navigationHistory = {
      canGoBack: () => this.historyIndex > 0,
      getActiveIndex: () => this.historyIndex,
      getAllEntries: () => this.historyEntries.map(entry => ({ ...entry })),
      getEntryAtIndex: index => this.historyEntries[index] ? { ...this.historyEntries[index] } : null,
      clear: () => {
        this.historyEntries = [{ url: this.url }];
        this.historyIndex = 0;
        this.historyClearCount += 1;
      },
      goBack: () => {
        if (this.historyIndex <= 0) return;
        this.goBackCount += 1;
        this.historyIndex -= 1;
        this.url = this.historyEntries[this.historyIndex].url;
        this.emit('did-start-navigation', {}, this.url, false, true);
        this.emit('did-navigate', {}, this.url);
        this.emit('did-finish-load');
        this.emit('did-stop-loading');
      }
    };
    this.id = FakeWebContents.nextId++;
    this.highlightResult = { found: true, pageState: 'DEV_PORTAL_SIGNED_OUT', visibleStepId: 'sign-in', targetKey: 'sign-in-here', primaryTarget: true, animatedCallout: true, candidates: [] };
  }
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
  loadURL(url, options = {}) {
    if (this.failNextLoad) {
      this.failNextLoad = false;
      return Promise.reject(new Error('synthetic load failure'));
    }
    this.url = url;
    this.historyEntries = this.historyEntries.slice(0, this.historyIndex + 1);
    this.historyEntries.push({ url });
    this.historyIndex = this.historyEntries.length - 1;
    this.loadedUrls.push(url);
    this.lastLoadOptions = options;
    if (this.behavior.suppressLoadEvents) return new Promise(() => {});
    this.emit('did-start-navigation', {}, url, false, true);
    this.emit('did-navigate', {}, url);
    this.emit('did-finish-load');
    this.emit('did-stop-loading');
    return Promise.resolve();
  }
  executeJavaScript(source) {
    this.executed.push(source);
    if (this.executeHook) return this.executeHook(source);
    if (source.includes("document.querySelectorAll('[data-cpcr-setup-highlight]')")) return Promise.resolve(true);
    return Promise.resolve(this.highlightResult);
  }
  setHistory(urls, activeIndex = urls.length - 1) {
    this.historyEntries = urls.map(url => ({ url }));
    this.historyIndex = activeIndex;
    this.url = urls[activeIndex] || this.url;
  }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  focus() { this.focused = true; }
  stop() { this.stopped = true; }
  close() {
    if (this.failClose) throw new Error('synthetic close failure');
    this.destroyed = true;
    this.emit('destroyed');
  }
  destroy() {
    if (this.failDestroy) throw new Error('synthetic destroy failure');
    this.destroyed = true;
    this.emit('destroyed');
  }
}
FakeWebContents.nextId = 501;

const created = [];
const nextBehaviors = [];
class FakeWebContentsView {
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents(new FakeSession(), nextBehaviors.shift() || {});
    this.visible = false;
    created.push(this);
  }
  setVisible(value) {
    if (this.failSetVisible) throw new Error('synthetic visibility failure');
    this.visible = Boolean(value);
  }
  setBounds(bounds) {
    if (this.failSetBounds) throw new Error('synthetic bounds failure');
    this.bounds = { ...bounds };
  }
}

function createWindow() {
  const children = [];
  return {
    children,
    window: {
      contentView: {
        children,
        addChildView(view) { children.push(view); },
        removeChildView(view) {
          const index = children.indexOf(view);
          if (index >= 0) children.splice(index, 1);
        }
      },
      isDestroyed: () => false,
      focus() { this.focused = true; }
    }
  };
}

function createHarness(overrides = {}) {
  const coordinator = overrides.coordinator || new OperationCoordinator();
  const events = [];
  const host = createWindow();
  const controller = createSetupAssistantController({
    WebContentsView: FakeWebContentsView,
    getWindow: () => host.window,
    coordinator,
    emit: (channel, payload) => events.push({ channel, payload }),
    beforeOpen: overrides.beforeOpen || (async () => {}),
    environment: {},
    readinessTimeoutMs: overrides.readinessTimeoutMs || 40,
    domRefreshDebounceMs: overrides.domRefreshDebounceMs || 12,
    postAuthQuietMs: overrides.postAuthQuietMs || 15,
    postAuthMaxMs: overrides.postAuthMaxMs || 45,
    offFlowQuietMs: overrides.offFlowQuietMs || 15
  });
  return { coordinator, events, host, controller };
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const startCount = created.length;
  const harness = createHarness();
  const { coordinator, events, host, controller } = harness;

  const step3Token = coordinator.begin('step3_live_run');
  await assert.rejects(() => controller.open({ bounds: { x: 10, y: 20, width: 500, height: 400 } }), error => (
    error.code === 'PROTECTED_OPERATION_ACTIVE' && error.operation === 'step3_live_run'
  ));
  assert.strictEqual(coordinator.hasActive('step3_live_run'), true, 'Setup never releases another operation');
  coordinator.end(step3Token);

  const opened = await controller.open({ bounds: { x: 10, y: 20, width: 500, height: 400 } });
  const firstView = created[startCount];
  await tick();
  assert.strictEqual(opened.active, true);
  assert.strictEqual(firstView.webContents.loadedUrls[0], DEVELOPER_PORTAL_URL);
  assert.strictEqual(controller.snapshot().browserGeneration, 1);
  assert.strictEqual(controller.snapshot().browserIdentity, firstView.webContents.id);
  assert.strictEqual(controller.snapshot().browserState, 'ready');
  assert.strictEqual(controller.snapshot().browserPreparing, false);
  assert.strictEqual(controller.snapshot().openPromiseActive, false);
  assert.strictEqual(controller.snapshot().readyPromiseActive, false);
  assert.strictEqual(firstView.options.webPreferences.partition, SETUP_PARTITION);
  assert.strictEqual(firstView.options.webPreferences.contextIsolation, true);
  assert.strictEqual(firstView.options.webPreferences.sandbox, true);
  assert.strictEqual(firstView.options.webPreferences.webSecurity, true);
  assert.strictEqual(firstView.options.webPreferences.allowRunningInsecureContent, false);
  assert.deepStrictEqual(firstView.bounds, { x: 10, y: 20, width: 500, height: 400 });
  assert.strictEqual(host.children.includes(firstView), true);
  assert.strictEqual(coordinator.hasActive('setup_assistant'), true);

  const navigationCount = firstView.webContents.loadedUrls.length;
  let prevented = false;
  firstView.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://origin-www.canadapost.ca/signin');
  assert.strictEqual(prevented, false, 'approved same-tab Sign In navigation is allowed');
  assert.strictEqual(firstView.webContents.loadedUrls.length, navigationCount, 'approved same-tab navigation is never replayed');
  prevented = false;
  firstView.webContents.emit('will-redirect', { preventDefault: () => { prevented = true; } }, 'https://sso-osu.canadapost-postescanada.ca/continue', false, true);
  assert.strictEqual(prevented, false, 'approved redirect is allowed untouched');
  assert.strictEqual(firstView.webContents.loadedUrls.length, navigationCount, 'approved redirect is not converted into a manual GET');
  prevented = false;
  firstView.webContents.emit('will-redirect', { preventDefault: () => { prevented = true; } }, 'https://www.google.com/recaptcha/api.js', false, false);
  assert.strictEqual(prevented, false, 'third-party subframe/resource activity is not filtered by top-level policy');

  prevented = false;
  firstView.webContents.emit('will-redirect', { preventDefault: () => { prevented = true; } }, 'https://third-party.invalid/private?secret=value', false, true);
  assert.strictEqual(prevented, true, 'third-party top-level redirect is blocked');
  const blockedState = controller.snapshot();
  assert.strictEqual(blockedState.blockedHostname, 'third-party.invalid');
  assert.doesNotMatch(JSON.stringify(blockedState), /private|secret=value/);

  const popupResult = firstView.webContents.windowOpenHandler({
    url: 'https://sso-osu.canadapost-postescanada.ca/login',
    postBody: { contentType: 'application/x-www-form-urlencoded', data: [{ bytes: Buffer.from('synthetic=value') }] }
  });
  assert.deepStrictEqual(popupResult, { action: 'deny' });
  await tick();
  assert.strictEqual(firstView.webContents.loadedUrls.at(-1), 'https://sso-osu.canadapost-postescanada.ca/login');
  assert.strictEqual(firstView.webContents.lastLoadOptions.postData.length, 1, 'actual popup POST semantics are preserved');
  assert.deepStrictEqual(firstView.webContents.windowOpenHandler({ url: 'https://popup.example.invalid/' }), { action: 'deny' });

  const loadsBeforeProgress = firstView.webContents.loadedUrls.length;
  await controller.setStep({ stepId: 'verify' });
  await controller.setStep({ stepId: 'business' });
  await controller.setStep({ stepId: 'create-app' });
  assert.strictEqual(firstView.webContents.loadedUrls.length, loadsBeforeProgress, 'progress changes classify the current page and never load a hardcoded URL');

  firstView.webContents.highlightResult = {
    found: true,
    pageState: 'BUSINESS_SELECTION',
    visibleStepId: 'business',
    targetKey: 'select-your-business',
    candidates: [
      { number: '0001234567', businessName: 'SYNTHETIC SHIPPING INC', source: 'developer-business-selector' },
      { number: '0007654321', businessName: 'SYNTHETIC OTHER INC', source: 'customer-label' }
    ]
  };
  firstView.webContents.emit('did-finish-load');
  await tick();
  assert.deepStrictEqual(controller.snapshot().customerNumberCandidates, [
    { candidateId: 'candidate-1', number: '0001234567', masked: '••••••4567', businessName: 'SYNTHETIC SHIPPING INC', source: 'developer-business-selector' },
    { candidateId: 'candidate-2', number: '0007654321', masked: '••••••4321', businessName: 'SYNTHETIC OTHER INC', source: 'customer-label' }
  ]);
  assert.deepStrictEqual(controller.useCustomerNumber({ candidateId: 'missing' }), { ok: false, code: 'SETUP_CUSTOMER_NUMBER_CANDIDATE_INVALID' });
  firstView.webContents.highlightResult = {
    found: true,
    pageState: 'BUSINESS_CONFIRMED',
    visibleStepId: 'business',
    targetKey: 'apps',
    businessSelectorName: 'SYNTHETIC SHIPPING INC',
    candidates: [{ number: '0001234567', businessName: 'SYNTHETIC SHIPPING INC', source: 'viewing-business' }]
  };
  assert.deepStrictEqual(controller.useCustomerNumber({ candidateId: 'candidate-1' }), { ok: true, customerNumber: '0001234567', businessName: 'SYNTHETIC SHIPPING INC' });
  await tick();
  assert.strictEqual(controller.snapshot().pageState, 'BUSINESS_CONFIRMED', 'confirming the business immediately advances guidance to Apps');
  assert.strictEqual(controller.snapshot().currentBusinessName, 'SYNTHETIC SHIPPING INC');

  const classifierRunsBeforeMutation = firstView.webContents.executed.filter(source => source.includes('classifySetupSignals')).length;
  firstView.webContents.highlightResult = { found: true, pageState: 'API_PRODUCT_CATALOG', visibleStepId: 'tracking', targetKey: 'get-access-to-tracking', trackingProductName: 'Tracking 2.0.0', candidates: [] };
  firstView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(45);
  assert.ok(firstView.webContents.executed.filter(source => source.includes('classifySetupSignals')).length > classifierRunsBeforeMutation, 'a dropdown/dialog DOM signal reruns the classifier without navigation');
  assert.strictEqual(controller.snapshot().pageState, 'API_PRODUCT_CATALOG');
  assert.strictEqual(controller.snapshot().trackingProductName, 'Tracking 2.0.0');
  const catalogClassification = controller.snapshot().classification;
  assert.ok(Object.isFrozen(catalogClassification), 'the controller publishes one immutable classification snapshot');
  assert.deepStrictEqual({ pageState: catalogClassification.pageState, stepId: catalogClassification.stepId, targetKey: catalogClassification.targetKey }, {
    pageState: 'API_PRODUCT_CATALOG', stepId: 'tracking', targetKey: 'get-access-to-tracking'
  }, 'one snapshot owns the step, guide state, and browser target');

  firstView.webContents.highlightResult = { found: true, pageState: 'TRACKING_PRODUCT_CONFIRMATION', visibleStepId: 'tracking', targetKey: 'click-add', trackingProductName: 'Tracking (2.0.0)', candidates: [] };
  firstView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(25);
  assert.strictEqual(controller.snapshot().pageState, 'TRACKING_PRODUCT_CONFIRMATION', 'Get access transitions to the distinct scoped Add confirmation state');
  assert.ok(controller.snapshot().classification.version > catalogClassification.version, 'new DOM states replace older guidance atomically');

  firstView.webContents.highlightResult = { found: false, pageState: 'TRACKING_ENABLED', visibleStepId: 'finish', targetKey: '', candidates: [] };
  firstView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(25);
  assert.strictEqual(controller.snapshot().pageState, 'TRACKING_ENABLED', 'success-banner/table mutation replaces modal guidance');
  assert.strictEqual(controller.snapshot().stepId, 'finish', 'Tracking completion automatically activates Step 7');
  assert.strictEqual(controller.snapshot().guideState, 'recognized', 'a known state does not become a generic target failure when it has no remote target');
  assert.strictEqual(controller.snapshot().attached, false, 'no Add API product highlight remains after Tracking is enabled');
  firstView.webContents.highlightResult = { found: true, pageState: 'CREDENTIALS_GENERATED', visibleStepId: 'credentials', targetKey: 'copy-api-key', candidates: [] };
  firstView.webContents.emit('did-finish-load');
  await tick();

  firstView.webContents.highlightResult = { found: true, pageState: 'CREDENTIALS_GENERATED', visibleStepId: 'credentials', targetKey: 'copy-api-key', candidates: [] };
  firstView.webContents.emit('did-finish-load');
  await tick();
  assert.strictEqual(controller.snapshot().stepId, 'credentials');
  assert.strictEqual(controller.snapshot().classification.targetSurface, 'browser');
  firstView.webContents.emit('console-message', {}, 0, `${ACTION_SENTINEL_PREFIX}COPY_API_KEY`, 1, 'synthetic');
  await tick();
  assert.strictEqual(controller.snapshot().classification.credentialPhase, 'paste-key');
  assert.strictEqual(controller.snapshot().classification.targetSurface, 'local');
  assert.strictEqual(controller.snapshot().classification.targetKey, 'local-api-key');
  assert.strictEqual(controller.snapshot().classification.highlightTargetFound, true);
  await controller.setStep({ stepId: 'credentials', credentialState: { apiKey: true, apiSecret: false }, credentialPhase: 'copy-secret' });
  assert.strictEqual(controller.snapshot().classification.targetSurface, 'browser');
  firstView.webContents.emit('console-message', {}, 0, `${ACTION_SENTINEL_PREFIX}COPY_API_SECRET`, 1, 'synthetic');
  await tick();
  assert.strictEqual(controller.snapshot().classification.credentialPhase, 'paste-secret');
  assert.strictEqual(controller.snapshot().classification.targetSurface, 'local');
  assert.strictEqual(controller.snapshot().classification.targetKey, 'local-api-secret');
  await controller.setStep({ stepId: 'credentials', credentialState: { apiKey: true, apiSecret: true } });
  assert.match(firstView.webContents.executed.at(-1), /if \(!true\)[\s\S]*else if \(!true\)/, 'only local credential-presence booleans influence the credentials guide');

  const closed = await controller.closeSetupAssistant('credentials-screen-close');
  assert.strictEqual(closed.active, false);
  assert.strictEqual(closed.browserState, 'closed');
  assert.strictEqual(firstView.webContents.destroyed, true);
  assert.strictEqual(firstView.webContents.session.listenerCount('will-download'), 0);
  assert.strictEqual(firstView.webContents.listenerCount('did-finish-load'), 0);
  assert.strictEqual(coordinator.isActive(), false);
  assert.strictEqual(controller.snapshot().openPromiseActive, false);
  assert.strictEqual(controller.snapshot().readyPromiseActive, false);
  assert.strictEqual(controller.snapshot().pendingNavigationActive, false);
  assert.deepStrictEqual(controller.snapshot().customerNumberCandidates, []);
  assert.strictEqual(controller.snapshot().stepId, 'sign-in', 'unsaved visible progress resets on close');

  firstView.webContents.emit('did-finish-load');
  assert.strictEqual(controller.snapshot().browserState, 'closed', 'old did-finish-load is removed and ignored after close');

  const reopenStages = [
    ['login', 'LOGIN_PAGE', 'sign-in'],
    ['mfa', 'MFA_CODE', 'verify'],
    ['business', 'BUSINESS_SELECTION', 'business'],
    ['apps', 'APPS_PAGE', 'create-app'],
    ['credentials', 'CREDENTIALS_GENERATED', 'credentials'],
    ['classifier-miss', 'UNRECOGNIZED', 'sign-in']
  ];
  let previousGeneration = 1;
  let previousIdentity = firstView.webContents.id;
  for (const [stage, pageState, stepId] of reopenStages) {
    const state = await controller.open({ bounds: { width: 300, height: 240 } });
    await tick();
    const stageView = created.at(-1);
    stageView.webContents.highlightResult = { found: pageState !== 'UNRECOGNIZED', pageState, targetKey: stage, candidates: [] };
    stageView.webContents.emit('did-finish-load');
    await tick();
    assert.strictEqual(controller.snapshot().stepId, stepId, `${stage} state is active before close`);
    assert.ok(controller.snapshot().browserGeneration > previousGeneration, `${stage} reopen has a new generation`);
    assert.notStrictEqual(controller.snapshot().browserIdentity, previousIdentity, `${stage} reopen has new webContents`);
    assert.strictEqual(controller.snapshot().browserPreparing, false);
    previousGeneration = controller.snapshot().browserGeneration;
    previousIdentity = controller.snapshot().browserIdentity;
    await controller.closeSetupAssistant(`${stage}-close`);
    assert.strictEqual(coordinator.isActive(), false, `${stage} close releases operation lease`);
    assert.strictEqual(state.active, true);
  }

  const freshWhileOpen = await controller.open({ bounds: { width: 300, height: 240 } });
  const replacedView = created.at(-1);
  const replaced = await controller.open({ bounds: { width: 301, height: 241 } });
  assert.ok(replaced.browserGeneration > freshWhileOpen.browserGeneration, 'every Open call creates a fresh generation');
  assert.strictEqual(replacedView.webContents.destroyed, true);
  await controller.closeSetupAssistant('fresh-open-test');

  const pendingHighlightHarness = createHarness();
  await pendingHighlightHarness.controller.open({ bounds: { width: 300, height: 240 } });
  await tick();
  const pendingView = created.at(-1);
  let resolveHighlight;
  pendingView.webContents.executeHook = source => {
    if (source.includes("document.querySelectorAll('[data-cpcr-setup-highlight]')")) return new Promise(() => {});
    return new Promise(resolve => { resolveHighlight = resolve; });
  };
  pendingView.webContents.emit('did-finish-load');
  await tick();
  const pendingGeneration = pendingHighlightHarness.controller.snapshot().browserGeneration;
  const closeStarted = Date.now();
  await pendingHighlightHarness.controller.closeSetupAssistant('hung-highlight-close');
  assert.ok(Date.now() - closeStarted < 100, 'close never waits indefinitely for injected page cleanup');
  const reopenedPending = await pendingHighlightHarness.controller.open({ bounds: { width: 300, height: 240 } });
  await tick();
  resolveHighlight?.({ found: true, pageState: 'TRACKING_ENABLED', targetKey: 'stale', candidates: [{ number: '0009998887', source: 'customer-label' }] });
  await tick();
  assert.ok(reopenedPending.browserGeneration > pendingGeneration);
  assert.notStrictEqual(pendingHighlightHarness.controller.snapshot().pageState, 'TRACKING_ENABLED', 'old highlight result cannot mutate a new generation');
  assert.deepStrictEqual(pendingHighlightHarness.controller.snapshot().customerNumberCandidates, []);
  await pendingHighlightHarness.controller.closeSetupAssistant('stale-highlight-reopen');

  nextBehaviors.push({ suppressLoadEvents: true });
  const timeoutHarness = createHarness({ readinessTimeoutMs: 30 });
  const preparing = await timeoutHarness.controller.open({ bounds: { width: 300, height: 240 } });
  const timedOutView = created.at(-1);
  assert.strictEqual(preparing.browserState, 'creating');
  assert.strictEqual(preparing.browserPreparing, true);
  await tick(55);
  const timedOut = timeoutHarness.controller.snapshot();
  assert.strictEqual(timedOut.browserState, 'startup-timeout');
  assert.strictEqual(timedOut.browserPreparing, false, 'Preparing can never remain permanent');
  assert.strictEqual(timedOut.retryAvailable, true);
  const retried = await timeoutHarness.controller.retryCurrentStep({ bounds: { width: 300, height: 240 } });
  await tick();
  assert.ok(retried.browserGeneration > timedOut.browserGeneration, 'Retry browser creates another generation');
  assert.notStrictEqual(retried.browserIdentity, timedOutView.webContents.id);
  assert.strictEqual(timedOutView.webContents.destroyed, true);
  assert.strictEqual(timeoutHarness.controller.snapshot().browserState, 'ready');
  await timeoutHarness.controller.closeSetupAssistant('timeout-retried');
  assert.strictEqual(timeoutHarness.coordinator.isActive(), false);

  const classifierMiss = createHarness();
  await classifierMiss.controller.open({ bounds: { width: 300, height: 240 } });
  await tick();
  const missView = created.at(-1);
  missView.webContents.highlightResult = { found: false, pageState: 'UNRECOGNIZED', targetKey: '', candidates: [] };
  missView.webContents.emit('did-finish-load');
  await tick(25);
  assert.strictEqual(classifierMiss.controller.snapshot().browserState, 'ready');
  assert.strictEqual(classifierMiss.controller.snapshot().pageState, 'OFF_FLOW_PAGE');
  assert.strictEqual(classifierMiss.controller.snapshot().guideState, 'recognized');
  assert.strictEqual(classifierMiss.coordinator.hasActive('setup_assistant'), true, 'classifier miss is only a guide problem while Setup remains open');
  await classifierMiss.controller.closeSetupAssistant('classifier-miss');
  assert.strictEqual((await classifierMiss.controller.open({ bounds: { width: 300, height: 240 } })).active, true);
  await classifierMiss.controller.closeSetupAssistant('classifier-miss-reopen');

  const settlingHarness = createHarness({ postAuthQuietMs: 20, postAuthMaxMs: 55 });
  await settlingHarness.controller.open({ bounds: { width: 300, height: 240 } });
  await tick();
  const settlingView = created.at(-1);
  settlingView.webContents.highlightResult = { found: true, pageState: 'SECURITY_QUESTION', visibleStepId: 'verify', targetKey: 'security-question', candidates: [] };
  settlingView.webContents.emit('did-finish-load');
  await tick();
  settlingView.webContents.emit('did-start-navigation', {}, DEVELOPER_PORTAL_URL, false, true);
  assert.strictEqual(settlingHarness.controller.snapshot().classification, null, 'navigation immediately invalidates the old target snapshot');
  assert.ok(settlingView.webContents.executed.at(-1).includes('__cpcrSetupCleanup'), 'navigation immediately clears the old remote overlay');
  settlingView.webContents.highlightResult = { found: true, overlayInstalled: true, targetResolved: true, pageState: 'BUSINESS_MENU_REQUIRED', visibleStepId: 'business', targetKey: 'current-business-control', targetSurface: 'browser', targetRole: 'currentBusinessControl', targetElementRole: 'link', targetElementTag: 'a', businessSelectorName: 'ARBITRARY NORTH CO.', candidates: [] };
  settlingView.webContents.emit('did-finish-load');
  await tick(3);
  assert.strictEqual(settlingHarness.controller.snapshot().pageState, 'POST_AUTH_SETTLING');
  assert.strictEqual(settlingHarness.controller.snapshot().classification.highlightTargetFound, false, 'settling never exposes a browser action');
  settlingView.webContents.emit('did-start-navigation', {}, `${DEVELOPER_PORTAL_URL}session-limit`, false, true);
  settlingView.webContents.highlightResult = { found: true, pageState: 'SESSION_LIMIT', visibleStepId: 'verify', targetKey: 'disconnect-session', candidates: [] };
  settlingView.webContents.emit('did-finish-load');
  await tick(3);
  assert.strictEqual(settlingHarness.controller.snapshot().pageState, 'SESSION_LIMIT', 'session limit interrupts settling immediately');
  assert.strictEqual(settlingHarness.controller.snapshot().classification.highlightTargetFound, true);
  settlingView.webContents.emit('did-start-navigation', {}, DEVELOPER_PORTAL_URL, false, true);
  settlingView.webContents.highlightResult = { found: true, overlayInstalled: true, targetResolved: true, pageState: 'BUSINESS_MENU_REQUIRED', visibleStepId: 'business', targetKey: 'current-business-control', targetSurface: 'browser', targetRole: 'currentBusinessControl', targetElementRole: 'link', targetElementTag: 'a', businessSelectorName: 'ARBITRARY NORTH CO.', candidates: [] };
  settlingView.webContents.emit('did-finish-load');
  await tick(3);
  assert.strictEqual(settlingHarness.controller.snapshot().pageState, 'POST_AUTH_SETTLING');
  await tick(45);
  assert.strictEqual(settlingHarness.controller.snapshot().pageState, 'BUSINESS_MENU_REQUIRED', 'the stable final portal exits settling');
  assert.strictEqual(settlingHarness.controller.snapshot().classification.targetSurface, 'browser');
  assert.strictEqual(settlingHarness.controller.snapshot().classification.targetKey, 'current-business-control');
  assert.strictEqual(settlingHarness.controller.snapshot().classification.targetRole, 'currentBusinessControl');
  assert.strictEqual(settlingHarness.controller.snapshot().classification.targetElementRole, 'link');
  assert.strictEqual(settlingHarness.controller.snapshot().classification.targetElementTag, 'a', 'the exact clickable business link owns the target');
  assert.strictEqual(settlingHarness.controller.snapshot().currentBusinessName, 'ARBITRARY NORTH CO.', 'business names are dynamic');
  assert.doesNotMatch(settlingView.webContents.executed.at(-1), /\.element\.click\(\)/, 'stable business assistance highlights but never auto-clicks the dropdown');
  settlingView.webContents.highlightResult = { found: true, overlayInstalled: false, targetResolved: true, pageState: 'BUSINESS_MENU_REQUIRED', visibleStepId: 'business', targetKey: 'current-business-control', targetSurface: 'browser', targetRole: 'currentBusinessControl', targetElementRole: 'link', targetElementTag: 'a', businessSelectorName: 'ARBITRARY NORTH CO.', candidates: [] };
  settlingView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(20);
  assert.strictEqual(settlingHarness.controller.snapshot().pageState, 'BUSINESS_TARGET_RESOLVING', 'Step 3 normal business guidance cannot publish when overlay installation failed');
  assert.strictEqual(settlingHarness.controller.snapshot().classification.targetSurface, 'none');
  assert.strictEqual(settlingHarness.controller.snapshot().classification.highlightTargetFound, false);
  const businessRetryRuns = settlingView.webContents.executed.filter(source => source.includes('classifySetupSignals')).length;
  await tick(55);
  assert.ok(settlingView.webContents.executed.filter(source => source.includes('classifySetupSignals')).length > businessRetryRuns, 'overlay installation is retried after the next settled geometry opportunity');
  await settlingHarness.controller.closeSetupAssistant('settling-complete');

  const maximumSettleHarness = createHarness({ postAuthQuietMs: 1000, postAuthMaxMs: 20 });
  await maximumSettleHarness.controller.open({ bounds: { width: 300, height: 240 } });
  await tick();
  const maximumView = created.at(-1);
  maximumView.webContents.highlightResult = { found: true, pageState: 'MFA_CODE', visibleStepId: 'verify', targetKey: 'access-code', candidates: [] };
  maximumView.webContents.emit('did-finish-load');
  await tick();
  maximumView.webContents.emit('did-start-navigation', {}, DEVELOPER_PORTAL_URL, false, true);
  maximumView.webContents.highlightResult = { found: true, pageState: 'BUSINESS_SELECTION', visibleStepId: 'business', targetKey: 'business', candidates: [] };
  maximumView.webContents.emit('did-finish-load');
  await tick(30);
  assert.strictEqual(maximumSettleHarness.controller.snapshot().pageState, 'BUSINESS_SELECTION', 'the maximum bound prevents indefinite settling');
  await maximumSettleHarness.controller.closeSetupAssistant('maximum-settle');

  const productHarness = createHarness();
  await productHarness.controller.open({ bounds: { width: 300, height: 240 } });
  await tick();
  const productView = created.at(-1);
  const catalogResult = { found: true, pageState: 'API_PRODUCT_CATALOG', visibleStepId: 'tracking', targetKey: 'get-access', targetSurface: 'browser', candidates: [] };
  const confirmation = (state, name, version, overlayInstanceId) => ({
    found: true, pageState: state, visibleStepId: 'tracking', targetKey: state === 'WRONG_API_PRODUCT' ? 'back' : 'add',
    targetSurface: 'browser', selectedProductName: name, selectedProductVersion: version,
    selectedPlanName: 'Default plan', overlayInstanceId, candidates: []
  });
  productView.webContents.highlightResult = catalogResult;
  productView.webContents.emit('did-finish-load');
  await tick();
  productView.webContents.emit('console-message', {}, 0, `${ACTION_SENTINEL_PREFIX}PRODUCT_ACCESS`, 1, 'synthetic');
  productView.webContents.highlightResult = confirmation('WRONG_API_PRODUCT', 'Rating', '4.0.0', 'overlay-rating-1');
  productView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(20);
  const rating1 = productHarness.controller.snapshot().classification;
  assert.strictEqual(rating1.selectedProductName, 'Rating');
  assert.match(rating1.productAttemptId, /^product-attempt-/);
  productView.webContents.emit('console-message', {}, 0, `${ACTION_SENTINEL_PREFIX}PRODUCT_BACK`, 1, 'synthetic');
  productView.webContents.highlightResult = catalogResult;
  productView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(20);
  assert.strictEqual(productHarness.controller.snapshot().pageState, 'API_PRODUCT_CATALOG');
  assert.strictEqual(productHarness.controller.snapshot().classification.selectedProductName, '', 'Back clears Rating payload before the next choice');
  assert.strictEqual(productHarness.controller.snapshot().classification.productAttemptId, '');

  productView.webContents.emit('console-message', {}, 0, `${ACTION_SENTINEL_PREFIX}PRODUCT_ACCESS`, 1, 'synthetic');
  productView.webContents.highlightResult = confirmation('WRONG_API_PRODUCT', 'Returns', '2.0.0', 'overlay-returns');
  productView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(20);
  const returnsAttempt = productHarness.controller.snapshot().classification;
  assert.strictEqual(returnsAttempt.selectedProductName, 'Returns');
  assert.notStrictEqual(returnsAttempt.productAttemptId, rating1.productAttemptId);
  assert.notStrictEqual(returnsAttempt.fingerprint, rating1.fingerprint);
  productView.webContents.emit('console-message', {}, 0, `${ACTION_SENTINEL_PREFIX}PRODUCT_BACK`, 1, 'synthetic');
  productView.webContents.highlightResult = catalogResult;
  productView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(20);

  productView.webContents.emit('console-message', {}, 0, `${ACTION_SENTINEL_PREFIX}PRODUCT_ACCESS`, 1, 'synthetic');
  productView.webContents.highlightResult = confirmation('TRACKING_PRODUCT_CONFIRMATION', 'Tracking', '2.0.0', 'overlay-tracking');
  productView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(20);
  const trackingAttempt = productHarness.controller.snapshot().classification;
  assert.strictEqual(trackingAttempt.pageState, 'TRACKING_PRODUCT_CONFIRMATION');
  assert.strictEqual(trackingAttempt.selectedProductName, 'Tracking');
  assert.strictEqual(trackingAttempt.targetKey, 'add');
  assert.notStrictEqual(trackingAttempt.productAttemptId, returnsAttempt.productAttemptId);

  productView.webContents.emit('console-message', {}, 0, `${ACTION_SENTINEL_PREFIX}PRODUCT_BACK`, 1, 'synthetic');
  productView.webContents.highlightResult = catalogResult;
  productView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(20);
  productView.webContents.emit('console-message', {}, 0, `${ACTION_SENTINEL_PREFIX}PRODUCT_ACCESS`, 1, 'synthetic');
  productView.webContents.highlightResult = confirmation('WRONG_API_PRODUCT', 'Rating', '4.0.0', 'overlay-rating-2');
  productView.webContents.emit('console-message', {}, 0, DOM_CHANGE_SENTINEL, 1, 'synthetic');
  await tick(20);
  const rating2 = productHarness.controller.snapshot().classification;
  assert.strictEqual(rating2.selectedProductName, 'Rating');
  assert.notStrictEqual(rating2.productAttemptId, rating1.productAttemptId, 'the same wrong product selected again is a new attempt');
  assert.notStrictEqual(rating2.fingerprint, rating1.fingerprint);
  await productHarness.controller.closeSetupAssistant('product-attempts');

  const backHarness = createHarness({ offFlowQuietMs: 15 });
  await backHarness.controller.open({ bounds: { width: 300, height: 240 } });
  await tick();
  const backView = created.at(-1);
  const unrelatedUrl = `${DEVELOPER_PORTAL_URL}developer-guide`;
  const appsUrl = `${DEVELOPER_PORTAL_URL}apps`;
  backView.webContents.setHistory([DEVELOPER_PORTAL_URL, appsUrl, unrelatedUrl]);
  backView.webContents.highlightResult = { found: false, pageState: 'UNRECOGNIZED', targetKey: '', candidates: [] };
  backView.webContents.emit('did-start-navigation', {}, unrelatedUrl, false, true);
  assert.notStrictEqual(backHarness.controller.snapshot().pageState, 'OFF_FLOW_PAGE', 'loading never becomes off-flow');
  backView.webContents.emit('will-redirect', { preventDefault() {} }, unrelatedUrl, false, true);
  assert.notStrictEqual(backHarness.controller.snapshot().pageState, 'OFF_FLOW_PAGE', 'a redirect never becomes off-flow before stable classification');
  backView.webContents.emit('did-finish-load');
  await tick(25);
  assert.strictEqual(backHarness.controller.snapshot().pageState, 'OFF_FLOW_PAGE');
  assert.strictEqual(backHarness.controller.snapshot().canGoBack, true);
  backView.webContents.highlightResult = { found: true, overlayInstalled: true, targetResolved: true, pageState: 'BUSINESS_MENU_REQUIRED', visibleStepId: 'business', targetKey: 'current-business-control', targetSurface: 'browser', targetRole: 'currentBusinessControl', targetElementRole: 'link', targetElementTag: 'a', candidates: [] };
  const loadedBeforeBack = backView.webContents.loadedUrls.length;
  const backResult = await backHarness.controller.navigateBack();
  await tick();
  assert.deepStrictEqual(backResult, { ok: true, usedNavigationHistory: true });
  assert.strictEqual(backView.webContents.goBackCount, 1, 'Back uses Electron navigation history');
  assert.strictEqual(backView.webContents.loadedUrls.length, loadedBeforeBack, 'Back never reconstructs the prior request with loadURL');
  assert.strictEqual(backView.webContents.getURL(), appsUrl, 'the first Back follows Chromium history from C to B');
  assert.strictEqual(backHarness.controller.snapshot().pageState, 'BUSINESS_MENU_REQUIRED');
  await backHarness.controller.navigateBack();
  await tick();
  assert.strictEqual(backView.webContents.goBackCount, 2);
  assert.strictEqual(backView.webContents.getURL(), DEVELOPER_PORTAL_URL, 'the second Back follows Chromium history from B to A');
  assert.strictEqual(backView.webContents.loadedUrls.length, loadedBeforeBack, 'neither Back reconstructs an old URL');
  assert.strictEqual(safeBackNavigationState({ navigationHistory: { canGoBack: () => false } }).enabled, false);
  assert.strictEqual(safeBackNavigationState({ navigationHistory: { canGoBack: () => true } }).enabled, true, 'Chromium canGoBack is the primary enablement rule');
  backView.webContents.setHistory([`${DEVELOPER_PORTAL_URL}unclassified-but-approved`, unrelatedUrl]);
  assert.strictEqual(safeBackNavigationState(backView.webContents, {}).enabled, true, 'approved Chromium history does not require a classifier-history record');
  backView.webContents.setHistory(['https://evil.example/', unrelatedUrl]);
  assert.strictEqual(safeBackNavigationState(backView.webContents, {}).enabled, true, 'Back has no second classifier-history or URL whitelist; the existing top-level policy owns navigation security');
  await backHarness.controller.closeSetupAssistant('back-complete');

  const restartHarness = createHarness();
  const beforeRestart = await restartHarness.controller.open({ bounds: { width: 300, height: 240 }, locale: 'fr-CA' });
  await tick();
  const restartOldView = created.at(-1);
  restartOldView.webContents.setHistory([DEVELOPER_PORTAL_URL, `${DEVELOPER_PORTAL_URL}apps`]);
  const restarted = await restartHarness.controller.startOver({ bounds: { width: 300, height: 240 }, locale: 'fr-CA' });
  await tick();
  assert.ok(restarted.browserGeneration > beforeRestart.browserGeneration, 'Start over creates a fresh browser generation');
  assert.notStrictEqual(restarted.browserIdentity, beforeRestart.browserIdentity);
  assert.strictEqual(restartOldView.webContents.historyClearCount, 1, 'the old generation navigation history is cleared');
  assert.strictEqual(restartOldView.webContents.destroyed, true);
  assert.strictEqual(created.at(-1).options.webPreferences.partition, SETUP_PARTITION, 'Start over preserves the persistent Canada Post session partition');
  assert.strictEqual(restartHarness.controller.snapshot().classification?.productAttemptId || '', '', 'product attempt context is reset');
  await restartHarness.controller.closeSetupAssistant('restart-complete');

  const cleanupFailure = createHarness();
  await cleanupFailure.controller.open({ bounds: { width: 300, height: 240 } });
  await tick();
  const cleanupView = created.at(-1);
  cleanupView.failSetVisible = true;
  cleanupView.webContents.failClose = true;
  cleanupView.webContents.failDestroy = true;
  const partial = await cleanupFailure.controller.closeSetupAssistant('synthetic-cleanup-errors');
  assert.strictEqual(partial.errorCode, 'SETUP_CLEANUP_PARTIAL');
  assert.strictEqual(cleanupFailure.coordinator.isActive(), false, 'cleanup failures release the operation lease in finally');

  let initializationAttempts = 0;
  const initializationHarness = createHarness({
    beforeOpen: async () => {
      initializationAttempts += 1;
      if (initializationAttempts === 1) throw new Error('synthetic initialization failure');
    }
  });
  await assert.rejects(() => initializationHarness.controller.open({ bounds: { width: 300, height: 240 } }), /synthetic initialization failure/);
  assert.strictEqual(initializationHarness.coordinator.isActive(), false);
  assert.strictEqual((await initializationHarness.controller.open({ bounds: { width: 300, height: 240 } })).active, true);
  await initializationHarness.controller.closeSetupAssistant('initialization-retry');

  const staleCoordinator = new OperationCoordinator();
  staleCoordinator.begin('setup_assistant');
  const staleHarness = createHarness({ coordinator: staleCoordinator });
  assert.strictEqual((await staleHarness.controller.open({ bounds: { width: 300, height: 240 } })).active, true, 'a truly orphaned Setup lease is reconciled');
  await staleHarness.controller.closeSetupAssistant('stale-reconciled');

  assert.ok(events.every(event => event.channel === 'setupAssistant:stateChanged'));
  assert.ok(events.every(event => !Object.keys(event.payload).some(key => /password|secret|cookie|authorization|accessCode/i.test(key))));
  process.stdout.write('Guided Setup navigation, generation lifecycle, watchdog, recovery and reopen tests passed.\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
