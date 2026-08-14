'use strict';

const {
  SETUP_PARTITION,
  SETUP_STEPS,
  DEVELOPER_PORTAL_URL,
  PAGE_STATES,
  setupStep,
  stepForPageState,
  isAllowedSetupUrl,
  blockedNavigationDiagnostic,
  navigationLifecycleDiagnostic,
  approvedPopupLoadOptions,
  sanitizeSetupLocation,
  maskCustomerNumber,
  classificationFingerprint,
  buildHighlightScript,
  buildDomObserverScript,
  buildClearHighlightScript
} = require('../lib/setup-assistant');
const english = require('../locales/en-CA.json');
const french = require('../locales/fr-CA.json');

const DOM_CHANGE_SENTINEL = '__CPCR_SETUP_DOM_CHANGED__';
const ACTION_SENTINEL_PREFIX = '__CPCR_SETUP_ACTION__:';

function safeBackNavigationState(webContents) {
  const history = webContents?.navigationHistory;
  if (!history || typeof history.canGoBack !== 'function' || !history.canGoBack()) return Object.freeze({ enabled: false, targetUrl: '' });
  try {
    const index = typeof history.getActiveIndex === 'function' ? Number(history.getActiveIndex()) : -1;
    const entry = index > 0
      ? (history.getEntryAtIndex?.(index - 1) || history.getAllEntries?.()[index - 1])
      : null;
    const targetUrl = String(entry?.url || '');
    if (targetUrl === 'about:blank') return Object.freeze({ enabled: false, targetUrl: '' });
    return Object.freeze({ enabled: true, targetUrl });
  } catch (_) {
    return Object.freeze({ enabled: true, targetUrl: '' });
  }
}

function setupCalloutLabels(locale) {
  const messages = String(locale || '').toLowerCase().startsWith('fr') ? french : english;
  const value = key => String(messages[`setupAssistant.callout.${key}`] || '');
  return Object.freeze({
    signIn: value('signIn'),
    continue: value('continue'),
    accessCode: value('accessCode'),
    securityQuestion: value('securityQuestion'),
    disconnectSession: value('disconnectSession'),
    openBusinessMenu: value('openBusinessMenu'),
    viewOrganizationSettings: value('viewOrganizationSettings'),
    confirmBusiness: value('confirmBusiness'),
    apps: value('apps'),
    createNewApp: value('createNewApp'),
    useExistingApp: value('useExistingApp'),
    selectProduction: value('selectProduction'),
    createApp: value('createApp'),
    appName: value('appName'),
    required: value('required'),
    copyApiKey: value('copyApiKey'),
    copyApiSecret: value('copyApiSecret'),
    addApiProduct: value('addApiProduct'),
    getAccessTracking: value('getAccessTracking'),
    clickAdd: value('clickAdd'),
    back: value('back')
  });
}

function normalizeBounds(bounds = {}) {
  return {
    x: Math.round(Number(bounds.x) || 0),
    y: Math.round(Number(bounds.y) || 0),
    width: Math.max(0, Math.round(Number(bounds.width) || 0)),
    height: Math.max(0, Math.round(Number(bounds.height) || 0))
  };
}

function createSetupAssistantController(options) {
  const {
    WebContentsView,
    getWindow,
    coordinator,
    emit,
    beforeOpen = () => {},
    environment = process.env,
    readinessTimeoutMs = 15000,
    domRefreshDebounceMs = 350,
    postAuthQuietMs = 1250,
    postAuthMaxMs = 5000,
    offFlowQuietMs = 900
  } = options;

  let view = null;
  let attached = false;
  let operationToken = '';
  let currentStepId = SETUP_STEPS[0].id;
  let currentPageState = PAGE_STATES.UNRECOGNIZED;
  let currentBounds = { x: 0, y: 0, width: 0, height: 0 };
  let failedBounds = { x: 0, y: 0, width: 0, height: 0 };
  let controllerState = 'idle';
  let generationSequence = 0;
  let currentGeneration = 0;
  let browserIdentity = 0;
  let browserState = 'closed';
  let guideState = 'idle';
  let lastLifecycle = null;
  let pageDetection = '';
  let blockedState = null;
  let customerCandidates = new Map();
  let guideContext = { apiKey: false, apiSecret: false, businessConfirmed: false, credentialPhase: 'copy-key' };
  let lastGuideResult = null;
  let lastKnownGoodUrl = '';
  let highlightTarget = '';
  let readinessTimer = null;
  let readinessResolve = null;
  let readyPromise = null;
  let pendingNavigation = null;
  let openPromise = null;
  let closePromise = null;
  let guideWorkSequence = 0;
  let listenerBindings = [];
  let downloadBinding = null;
  let domRefreshTimer = null;
  let setupLocale = 'en-CA';
  let currentBusinessName = '';
  let trackingProductName = '';
  let classificationSequence = 0;
  let currentClassification = null;
  let lastMeaningfulPageState = PAGE_STATES.UNRECOGNIZED;
  let lastMainFrameNavigationAt = 0;
  let settlingStartedAt = 0;
  let settlingStateChangedAt = 0;
  let settlingRawState = '';
  let settlingTimer = null;
  let postAuthLandingPending = false;
  let businessAssistanceReady = false;
  let productAttemptSequence = 0;
  let activeProductAttemptId = '';
  let activeOverlayInstanceId = '';
  let productAttemptPending = false;
  let offFlowStartedAt = 0;
  let offFlowUrl = '';
  let offFlowTimer = null;
  let businessTargetRetryTimer = null;
  let businessTargetRetryCount = 0;

  function liveView(candidate = view) {
    return Boolean(candidate?.webContents && !candidate.webContents.isDestroyed());
  }

  function isCurrent(generation, candidate = view) {
    return generation !== 0 && generation === currentGeneration && candidate === view && liveView(candidate);
  }

  function active() {
    return Boolean(operationToken && currentGeneration && liveView() && controllerState === 'open');
  }

  function hasLiveControllerState() {
    return liveView() || attached || controllerState !== 'idle' || Boolean(openPromise) || Boolean(closePromise);
  }

  function childIndex(candidate = view) {
    const children = getWindow()?.contentView?.children;
    return Array.isArray(children) && candidate ? children.indexOf(candidate) : -1;
  }

  function publicCustomerCandidates() {
    return [...customerCandidates.entries()].map(([candidateId, candidate]) => ({
      candidateId,
      number: candidate.number,
      masked: maskCustomerNumber(candidate.number),
      businessName: candidate.businessName,
      source: candidate.source
    }));
  }

  function snapshot(overrides = {}) {
    const location = sanitizeSetupLocation(liveView() ? view.webContents.getURL() : '');
    const pageState = currentPageState;
    return {
      ok: true,
      active: active(),
      attached,
      controllerState,
      stepId: currentStepId,
      pageState,
      hostname: location.hostname,
      pathname: location.pathname,
      bounds: { ...currentBounds },
      browserGeneration: currentGeneration || generationSequence,
      browserIdentity,
      browserState,
      browserPreparing: browserState === 'creating',
      browserReady: active() && attached && ['loading', 'ready'].includes(browserState),
      guideState,
      lastLifecycle,
      pageDetection,
      customerNumberCandidates: publicCustomerCandidates(),
      currentBusinessName,
      trackingProductName,
      classification: currentClassification,
      canGoBack: active() && safeBackNavigationState(view?.webContents).enabled,
      retryAvailable: Boolean(blockedState) || ['startup-timeout', 'recoverable-error', 'failed'].includes(browserState),
      openPromiseActive: Boolean(openPromise),
      readyPromiseActive: Boolean(readyPromise),
      pendingNavigationActive: Boolean(pendingNavigation),
      ...(blockedState || {}),
      ...overrides
    };
  }

  function publish(overrides = {}, generation = currentGeneration) {
    if (generation && generation !== currentGeneration) return snapshot();
    const state = snapshot(overrides);
    emit('setupAssistant:stateChanged', state);
    return state;
  }

  function attach(candidate = view) {
    const window = getWindow();
    if (!window || window.isDestroyed()) throw Object.assign(new Error('SETUP_WINDOW_UNAVAILABLE'), { code: 'SETUP_WINDOW_UNAVAILABLE' });
    if (!liveView(candidate)) throw Object.assign(new Error('SETUP_VIEW_UNAVAILABLE'), { code: 'SETUP_VIEW_UNAVAILABLE' });
    if (childIndex(candidate) < 0) window.contentView.addChildView(candidate);
    attached = true;
    if (typeof candidate.setVisible === 'function') candidate.setVisible(true);
  }

  function detach(candidate = view) {
    if (!candidate) return;
    if (typeof candidate.setVisible === 'function') candidate.setVisible(false);
    const window = getWindow();
    if (window && !window.isDestroyed() && childIndex(candidate) >= 0) window.contentView.removeChildView(candidate);
    if (candidate === view) attached = false;
  }

  function clearReadiness() {
    if (readinessTimer) clearTimeout(readinessTimer);
    readinessTimer = null;
    if (readinessResolve) readinessResolve(false);
    readinessResolve = null;
    readyPromise = null;
  }

  function markBrowserUsable(generation, state) {
    if (!isCurrent(generation)) return false;
    if (readinessTimer) clearTimeout(readinessTimer);
    readinessTimer = null;
    if (readinessResolve) readinessResolve(true);
    readinessResolve = null;
    readyPromise = null;
    browserState = state;
    return true;
  }

  function clearTransientState() {
    guideWorkSequence += 1;
    blockedState = null;
    customerCandidates = new Map();
    currentPageState = PAGE_STATES.UNRECOGNIZED;
    currentStepId = SETUP_STEPS[0].id;
    guideContext = { apiKey: false, apiSecret: false, businessConfirmed: false, credentialPhase: 'copy-key' };
    lastGuideResult = null;
    lastKnownGoodUrl = '';
    highlightTarget = '';
    pageDetection = '';
    guideState = 'idle';
    lastLifecycle = null;
    pendingNavigation = null;
    currentBusinessName = '';
    trackingProductName = '';
    currentClassification = null;
    lastMeaningfulPageState = PAGE_STATES.UNRECOGNIZED;
    lastMainFrameNavigationAt = 0;
    settlingStartedAt = 0;
    settlingStateChangedAt = 0;
    settlingRawState = '';
    if (settlingTimer) clearTimeout(settlingTimer);
    settlingTimer = null;
    postAuthLandingPending = false;
    businessAssistanceReady = false;
    productAttemptSequence = 0;
    activeProductAttemptId = '';
    activeOverlayInstanceId = '';
    productAttemptPending = false;
    offFlowStartedAt = 0;
    offFlowUrl = '';
    if (offFlowTimer) clearTimeout(offFlowTimer);
    offFlowTimer = null;
    if (businessTargetRetryTimer) clearTimeout(businessTargetRetryTimer);
    businessTargetRetryTimer = null;
    businessTargetRetryCount = 0;
    if (domRefreshTimer) clearTimeout(domRefreshTimer);
    domRefreshTimer = null;
  }

  function guideScriptContext() {
    return {
      ...guideContext,
      suppressTargets: Boolean(settlingStartedAt || postAuthLandingPending),
      calloutLabels: setupCalloutLabels(setupLocale)
    };
  }

  function retainCustomerCandidates(result) {
    const next = new Map();
    for (const [index, candidate] of (Array.isArray(result?.candidates) ? result.candidates : []).entries()) {
      const number = String(candidate?.number || '');
      if (!/^\d{10}$/.test(number)) continue;
      next.set(`candidate-${index + 1}`, {
        number,
        businessName: String(candidate?.businessName || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        source: String(candidate?.source || 'developer-business-selector').slice(0, 60)
      });
    }
    customerCandidates = next;
  }

  function stopSettling() {
    if (settlingTimer) clearTimeout(settlingTimer);
    settlingTimer = null;
    settlingStartedAt = 0;
    settlingStateChangedAt = 0;
    settlingRawState = '';
  }

  function scheduleSettlingProbe(generation, candidate, delayMs) {
    if (settlingTimer) clearTimeout(settlingTimer);
    settlingTimer = setTimeout(() => {
      settlingTimer = null;
      if (!isCurrent(generation, candidate) || browserState !== 'ready') return;
      applyPageGuide(generation, candidate).catch(() => {});
    }, Math.max(10, Number(delayMs) || Number(postAuthQuietMs) || 1250));
  }

  function isImmediatePostAuthState(pageState) {
    return [
      PAGE_STATES.SESSION_LIMIT, PAGE_STATES.IDENTITY_METHOD_SELECTION, PAGE_STATES.IDENTITY_CHALLENGE,
      PAGE_STATES.SECURITY_QUESTION, PAGE_STATES.MFA_INTRO, PAGE_STATES.MFA_CODE, PAGE_STATES.LOGIN_PAGE
    ].includes(pageState);
  }

  function isAuthenticatedLandingState(pageState) {
    return [PAGE_STATES.DEV_PORTAL_AUTHENTICATED, PAGE_STATES.BUSINESS_TARGET_RESOLVING, PAGE_STATES.BUSINESS_MENU_REQUIRED, PAGE_STATES.BUSINESS_SELECTION, PAGE_STATES.BUSINESS_CONFIRMED].includes(pageState);
  }

  function clearBusinessTargetRetry() {
    if (businessTargetRetryTimer) clearTimeout(businessTargetRetryTimer);
    businessTargetRetryTimer = null;
    businessTargetRetryCount = 0;
  }

  function scheduleBusinessTargetRetry(generation, candidate, targetResolved) {
    if (businessTargetRetryTimer || businessTargetRetryCount >= 6) return;
    businessTargetRetryCount += 1;
    const delay = targetResolved ? 50 : 180;
    businessTargetRetryTimer = setTimeout(() => {
      businessTargetRetryTimer = null;
      if (!isCurrent(generation, candidate) || browserState !== 'ready') return;
      applyPageGuide(generation, candidate).catch(() => {});
    }, delay);
  }

  function clearProductAttempt() {
    activeProductAttemptId = '';
    activeOverlayInstanceId = '';
    productAttemptPending = false;
  }

  function beginProductAttempt() {
    activeProductAttemptId = `product-attempt-${++productAttemptSequence}`;
    activeOverlayInstanceId = '';
    productAttemptPending = true;
    return activeProductAttemptId;
  }

  function clearOffFlowTimer() {
    if (offFlowTimer) clearTimeout(offFlowTimer);
    offFlowTimer = null;
    offFlowStartedAt = 0;
    offFlowUrl = '';
  }

  function scheduleOffFlowProbe(generation, candidate, delayMs) {
    if (offFlowTimer) clearTimeout(offFlowTimer);
    offFlowTimer = setTimeout(() => {
      offFlowTimer = null;
      if (!isCurrent(generation, candidate) || browserState !== 'ready') return;
      applyPageGuide(generation, candidate).catch(() => {});
    }, Math.max(10, Number(delayMs) || Number(offFlowQuietMs) || 900));
  }

  function shouldBeginPostAuthSettling(pageState) {
    return isAuthenticatedLandingState(pageState) && [
      PAGE_STATES.LOGIN_SUBMITTED, PAGE_STATES.IDENTITY_METHOD_SELECTION, PAGE_STATES.IDENTITY_CHALLENGE,
      PAGE_STATES.SECURITY_QUESTION, PAGE_STATES.MFA_INTRO, PAGE_STATES.MFA_CODE, PAGE_STATES.SESSION_LIMIT
    ].includes(lastMeaningfulPageState);
  }

  function settlingDecision(pageState) {
    const now = Date.now();
    if (!settlingStartedAt) {
      settlingStartedAt = now;
      settlingStateChangedAt = now;
      settlingRawState = pageState;
    } else if (settlingRawState !== pageState) {
      settlingRawState = pageState;
      settlingStateChangedAt = now;
    }
    const quietAnchor = Math.max(settlingStateChangedAt, lastMainFrameNavigationAt);
    const quietRemaining = Math.max(0, Number(postAuthQuietMs) - (now - quietAnchor));
    const maximumRemaining = Math.max(0, Number(postAuthMaxMs) - (now - settlingStartedAt));
    return {
      settled: browserState === 'ready' && (quietRemaining === 0 || maximumRemaining === 0),
      nextDelay: Math.max(10, Math.min(quietRemaining || Number(postAuthQuietMs), maximumRemaining || Number(postAuthMaxMs)))
    };
  }

  async function applyPageGuide(generation = currentGeneration, candidate = view) {
    if (!isCurrent(generation, candidate) || browserState !== 'ready') return snapshot();
    guideState = 'searching';
    const work = ++guideWorkSequence;
    try {
      const result = await candidate.webContents.executeJavaScript(buildHighlightScript(guideScriptContext()), true);
      if (!isCurrent(generation, candidate) || work !== guideWorkSequence) return snapshot();
      let rawPageState = Object.values(PAGE_STATES).includes(result?.pageState) ? result.pageState : PAGE_STATES.UNRECOGNIZED;
      const validBusinessTarget = result?.found === true
        && result?.overlayInstalled === true
        && result?.targetSurface === 'browser'
        && result?.targetKey === 'current-business-control'
        && result?.targetRole === 'currentBusinessControl'
        && ['link', 'button'].includes(String(result?.targetElementRole || '').toLowerCase());
      if (rawPageState === PAGE_STATES.BUSINESS_MENU_REQUIRED && !validBusinessTarget) {
        rawPageState = PAGE_STATES.BUSINESS_TARGET_RESOLVING;
      }
      if (isImmediatePostAuthState(rawPageState)) {
        const needsUnsuppressedRetry = postAuthLandingPending || Boolean(settlingStartedAt);
        postAuthLandingPending = false;
        stopSettling();
        if (needsUnsuppressedRetry) {
          lastMeaningfulPageState = rawPageState;
          return applyPageGuide(generation, candidate);
        }
      }
      if (isAuthenticatedLandingState(rawPageState) && (settlingStartedAt || postAuthLandingPending || shouldBeginPostAuthSettling(rawPageState))) {
        const decision = settlingDecision(rawPageState);
        if (!decision.settled) {
          currentPageState = PAGE_STATES.POST_AUTH_SETTLING;
          currentStepId = stepForPageState(currentPageState);
          highlightTarget = '';
          pageDetection = currentPageState;
          guideState = 'recognized';
          currentClassification = Object.freeze({
            version: ++classificationSequence,
            generation: currentGeneration,
            pageState: currentPageState,
            stepId: currentStepId,
            highlightTargetFound: false,
            targetKey: '',
            targetSurface: 'none',
            targetType: 'none',
            customerNumberCandidates: []
          });
          scheduleSettlingProbe(generation, candidate, decision.nextDelay);
          return publish({ loading: false, highlightTargetFound: false, settling: true }, generation);
        }
        stopSettling();
        postAuthLandingPending = false;
        businessAssistanceReady = true;
        lastMeaningfulPageState = rawPageState;
        return applyPageGuide(generation, candidate);
      }
      if (isAuthenticatedLandingState(rawPageState) && !businessAssistanceReady) {
        businessAssistanceReady = true;
        return applyPageGuide(generation, candidate);
      }
      const currentUrl = candidate.webContents.getURL();
      if (rawPageState === PAGE_STATES.UNRECOGNIZED && currentUrl !== 'about:blank' && isAllowedSetupUrl(currentUrl, environment)) {
        const now = Date.now();
        if (!offFlowStartedAt || offFlowUrl !== currentUrl) {
          offFlowStartedAt = now;
          offFlowUrl = currentUrl;
        }
        const remaining = Math.max(0, Number(offFlowQuietMs) - (now - offFlowStartedAt));
        if (remaining > 0) {
          currentPageState = PAGE_STATES.UNRECOGNIZED;
          currentClassification = null;
          highlightTarget = '';
          guideState = 'searching';
          scheduleOffFlowProbe(generation, candidate, remaining);
          return publish({ loading: false, offFlowPending: true, highlightTargetFound: false }, generation);
        }
        rawPageState = PAGE_STATES.OFF_FLOW_PAGE;
      } else {
        clearOffFlowTimer();
      }
      if (rawPageState === PAGE_STATES.API_PRODUCT_CATALOG) {
        if (!productAttemptPending) clearProductAttempt();
      } else if ([PAGE_STATES.WRONG_API_PRODUCT, PAGE_STATES.TRACKING_PRODUCT_CONFIRMATION].includes(rawPageState)) {
        const nextOverlayId = String(result?.overlayInstanceId || 'overlay-unknown').slice(0, 80);
        const nextProduct = `${String(result?.selectedProductName || '')}|${String(result?.selectedProductVersion || '')}`;
        const previousProduct = `${String(currentClassification?.selectedProductName || '')}|${String(currentClassification?.selectedProductVersion || '')}`;
        if (!activeProductAttemptId || (activeOverlayInstanceId && nextOverlayId !== activeOverlayInstanceId && nextProduct !== previousProduct)) beginProductAttempt();
        productAttemptPending = false;
        activeOverlayInstanceId = nextOverlayId;
      }
      if (rawPageState === PAGE_STATES.BUSINESS_TARGET_RESOLVING) {
        scheduleBusinessTargetRetry(generation, candidate, result?.targetResolved === true);
      } else {
        clearBusinessTargetRetry();
      }
      lastGuideResult = result && typeof result === 'object' ? {
        found: result.found === true,
        pageState: String(result.pageState || PAGE_STATES.UNRECOGNIZED),
        targetKey: String(result.targetKey || '').slice(0, 80)
      } : null;
      currentPageState = rawPageState;
      const adaptiveStep = stepForPageState(currentPageState);
      if (adaptiveStep) currentStepId = adaptiveStep;
      retainCustomerCandidates(result);
      currentBusinessName = String(result?.businessSelectorName || currentBusinessName || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      trackingProductName = String(result?.trackingProductName || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      highlightTarget = String(result?.targetKey || '').slice(0, 80);
      const businessTargetResolving = currentPageState === PAGE_STATES.BUSINESS_TARGET_RESOLVING;
      if (businessTargetResolving) highlightTarget = '';
      const localTarget = currentPageState === PAGE_STATES.CREDENTIALS_GENERATED
        && ['paste-key', 'paste-secret'].includes(guideContext.credentialPhase);
      if (localTarget) highlightTarget = guideContext.credentialPhase === 'paste-key' ? 'local-api-key' : 'local-api-secret';
      pageDetection = currentPageState;
      guideState = currentPageState === PAGE_STATES.UNRECOGNIZED ? 'unrecognized' : 'recognized';
      const classificationPayload = {
        version: ++classificationSequence,
        generation: currentGeneration,
        pageState: currentPageState,
        stepId: currentStepId,
        highlightTargetFound: !businessTargetResolving && (result?.found === true || localTarget),
        targetKey: highlightTarget,
        targetSurface: businessTargetResolving
          ? 'none'
          : (localTarget ? 'local' : String(result?.targetSurface || (result?.found === true ? 'browser' : 'none'))),
        targetType: String(result?.targetType || 'none'),
        targetRole: String(result?.targetRole || ''),
        targetElementRole: String(result?.targetElementRole || ''),
        targetElementTag: String(result?.targetElementTag || ''),
        targetResolved: result?.targetResolved === true,
        overlayInstalled: result?.overlayInstalled === true,
        primarySelectorMatched: result?.primarySelectorMatched === true,
        businessTargetDiagnostic: String(result?.businessTargetDiagnostic || '').slice(0, 180),
        businessSettingsTarget: result?.businessSettingsTarget === true,
        currentBusinessName,
        trackingProductName,
        selectedProductName: String(result?.selectedProductName || '').slice(0, 100),
        selectedProductVersion: String(result?.selectedProductVersion || '').slice(0, 30),
        selectedPlanName: String(result?.selectedPlanName || '').slice(0, 80),
        overlayInstanceId: activeOverlayInstanceId,
        productAttemptId: activeProductAttemptId,
        appName: String(result?.appName || '').slice(0, 120),
        credentialPhase: guideContext.credentialPhase,
        customerNumberCandidates: publicCustomerCandidates()
      };
      currentClassification = Object.freeze({
        ...classificationPayload,
        fingerprint: classificationFingerprint(classificationPayload)
      });
      if (currentPageState !== PAGE_STATES.UNRECOGNIZED && currentPageState !== PAGE_STATES.POST_AUTH_SETTLING) {
        lastMeaningfulPageState = currentPageState;
      }
      if (currentStepId === 'finish') detach(candidate);
      return publish({
        loading: false,
        highlightTargetFound: !businessTargetResolving && (result?.found === true || localTarget),
        primaryTarget: !businessTargetResolving && (result?.primaryTarget === true || localTarget),
        animatedCallout: !businessTargetResolving && (result?.animatedCallout === true || localTarget)
      }, generation);
    } catch (_) {
      if (!isCurrent(generation, candidate) || work !== guideWorkSequence) return snapshot();
      lastGuideResult = null;
      highlightTarget = '';
      guideState = 'unrecognized';
      return publish({ loading: false, highlightTargetFound: false, errorCode: 'SETUP_GUIDE_UNAVAILABLE' }, generation);
    }
  }

  async function installDomObserver(generation, candidate) {
    if (!isCurrent(generation, candidate) || browserState !== 'ready') return false;
    try {
      await candidate.webContents.executeJavaScript(buildDomObserverScript(), true);
      return isCurrent(generation, candidate);
    } catch (_) {
      return false;
    }
  }

  function scheduleDomRefresh(generation, candidate) {
    if (!isCurrent(generation, candidate) || browserState !== 'ready') return;
    if (domRefreshTimer) clearTimeout(domRefreshTimer);
    domRefreshTimer = setTimeout(() => {
      domRefreshTimer = null;
      if (!isCurrent(generation, candidate) || browserState !== 'ready') return;
      applyPageGuide(generation, candidate).catch(() => {});
    }, Math.max(10, Number(domRefreshDebounceMs) || 350));
  }

  function blockTopLevelNavigation(event, url, navigationType, generation, candidate) {
    if (!isCurrent(generation, candidate) || isAllowedSetupUrl(url, environment)) return false;
    event?.preventDefault?.();
    const diagnostic = blockedNavigationDiagnostic(url, navigationType, currentStepId);
    blockedState = {
      navigationBlocked: true,
      blockedHostname: diagnostic.blockedHostname,
      navigationType: diagnostic.navigationType,
      blockedStepId: diagnostic.stepId
    };
    publish({ loading: false, errorCode: 'SETUP_NAVIGATION_BLOCKED', retryAvailable: true }, generation);
    return true;
  }

  function bindViewEvents(createdView, generation) {
    const webContents = createdView.webContents;
    const on = (eventName, handler) => {
      const guarded = (...args) => {
        if (!isCurrent(generation, createdView)) return;
        handler(...args);
      };
      webContents.on(eventName, guarded);
      listenerBindings.push({ emitter: webContents, eventName, handler: guarded, generation });
    };

    on('will-attach-webview', event => event.preventDefault());
    on('console-message', (...args) => {
      const message = args.find(value => typeof value === 'string')
        || args.find(value => value && typeof value.message === 'string')?.message
        || '';
      if (message === DOM_CHANGE_SENTINEL) scheduleDomRefresh(generation, createdView);
      if (message.startsWith(ACTION_SENTINEL_PREFIX)) {
        const action = message.slice(ACTION_SENTINEL_PREFIX.length);
        if (action === 'PRODUCT_ACCESS') {
          beginProductAttempt();
          return;
        }
        if (action === 'PRODUCT_BACK') {
          clearProductAttempt();
          return;
        }
        if (action === 'COPY_API_KEY' && guideContext.apiKey !== true) guideContext.credentialPhase = 'paste-key';
        if (action === 'COPY_API_SECRET' && guideContext.apiSecret !== true) guideContext.credentialPhase = 'paste-secret';
        applyPageGuide(generation, createdView).catch(() => {});
      }
    });
    on('will-navigate', (event, url) => {
      lastLifecycle = navigationLifecycleDiagnostic('will-navigate', url, true, 0, currentStepId);
      blockTopLevelNavigation(event, url, 'navigation', generation, createdView);
    });
    on('will-redirect', (event, url, _inPlace, isMainFrame) => {
      lastLifecycle = navigationLifecycleDiagnostic('will-redirect', url, isMainFrame !== false, 0, currentStepId);
      if (isMainFrame === false) return;
      blockTopLevelNavigation(event, url, 'redirect', generation, createdView);
    });
    webContents.setWindowOpenHandler(details => {
      if (!isCurrent(generation, createdView)) return { action: 'deny' };
      const { url } = details;
      lastLifecycle = navigationLifecycleDiagnostic('window-open-request', url, true, 0, currentStepId);
      if (!isAllowedSetupUrl(url, environment)) {
        blockTopLevelNavigation(null, url, 'new-window', generation, createdView);
        return { action: 'deny' };
      }
      browserState = 'loading';
      guideState = 'idle';
      const popupNavigation = webContents.loadURL(url, approvedPopupLoadOptions(details));
      pendingNavigation = Promise.resolve(popupNavigation)
        .catch(error => {
          if (!isCurrent(generation, createdView)) return;
          browserState = 'recoverable-error';
          lastLifecycle = navigationLifecycleDiagnostic('did-fail-load', url, true, Number(error?.errno || 0), currentStepId);
          publish({ loading: false, errorCode: 'SETUP_PAGE_LOAD_FAILED', retryAvailable: true }, generation);
        })
        .finally(() => {
          if (isCurrent(generation, createdView)) pendingNavigation = null;
        });
      return { action: 'deny' };
    });
    on('did-start-navigation', (_event, url, _inPlace, isMainFrame) => {
      lastLifecycle = navigationLifecycleDiagnostic('did-start-navigation', url, isMainFrame, 0, currentStepId);
      if (!isMainFrame) return;
      businessAssistanceReady = false;
      clearProductAttempt();
      clearOffFlowTimer();
      clearBusinessTargetRetry();
      postAuthLandingPending = [
        PAGE_STATES.LOGIN_SUBMITTED, PAGE_STATES.IDENTITY_METHOD_SELECTION, PAGE_STATES.IDENTITY_CHALLENGE,
        PAGE_STATES.SECURITY_QUESTION, PAGE_STATES.MFA_INTRO, PAGE_STATES.MFA_CODE, PAGE_STATES.SESSION_LIMIT
      ].includes(lastMeaningfulPageState);
      lastMainFrameNavigationAt = Date.now();
      if (settlingStartedAt) settlingStateChangedAt = lastMainFrameNavigationAt;
      markBrowserUsable(generation, 'loading');
      guideWorkSequence += 1;
      if (domRefreshTimer) clearTimeout(domRefreshTimer);
      domRefreshTimer = null;
      blockedState = null;
      customerCandidates = new Map();
      currentPageState = PAGE_STATES.UNRECOGNIZED;
      currentClassification = null;
      highlightTarget = '';
      pageDetection = '';
      guideState = 'idle';
      Promise.resolve(webContents.executeJavaScript(buildClearHighlightScript(), true)).catch(() => {});
      publish({ loading: true, navigationBlocked: false, highlightTargetFound: false }, generation);
    });
    on('did-navigate', (_event, url) => {
      lastLifecycle = navigationLifecycleDiagnostic('did-navigate', url, true, 0, currentStepId);
      publish({}, generation);
    });
    on('did-finish-load', () => {
      const current = webContents.getURL();
      if (current !== 'about:blank' && isAllowedSetupUrl(current, environment)) lastKnownGoodUrl = current;
      markBrowserUsable(generation, 'ready');
      lastLifecycle = navigationLifecycleDiagnostic('did-finish-load', current, true, 0, currentStepId);
      publish({ loading: false }, generation);
      installDomObserver(generation, createdView)
        .then(() => applyPageGuide(generation, createdView))
        .catch(() => {});
    });
    on('did-stop-loading', () => {
      lastLifecycle = navigationLifecycleDiagnostic('did-stop-loading', webContents.getURL(), true, 0, currentStepId);
      if (browserState === 'loading') markBrowserUsable(generation, 'ready');
      publish({ loading: false }, generation);
    });
    on('did-fail-load', (_event, errorCode, _description, validatedUrl, isMainFrame) => {
      lastLifecycle = navigationLifecycleDiagnostic('did-fail-load', validatedUrl, isMainFrame, errorCode, currentStepId);
      if (!isMainFrame || Number(errorCode) === -3) return;
      markBrowserUsable(generation, 'recoverable-error');
      guideState = 'idle';
      const location = sanitizeSetupLocation(validatedUrl);
      publish({ hostname: location.hostname, loading: false, errorCode: 'SETUP_PAGE_LOAD_FAILED', retryAvailable: true }, generation);
    });
    on('render-process-gone', () => {
      failedBounds = { ...currentBounds };
      browserState = 'failed';
      lastLifecycle = navigationLifecycleDiagnostic('render-process-gone', webContents.getURL(), true, 0, currentStepId);
      const failure = lastLifecycle;
      closeSetupAssistant('web-contents-crashed', {
        browserState: 'failed',
        lastLifecycle: failure,
        errorCode: 'SETUP_BROWSER_PROCESS_FAILED',
        retryAvailable: true
      }).catch(() => {});
    });
    on('destroyed', () => {
      failedBounds = { ...currentBounds };
      closeSetupAssistant('web-contents-destroyed', {
        browserState: 'failed',
        errorCode: 'SETUP_BROWSER_PROCESS_FAILED',
        retryAvailable: true
      }).catch(() => {});
    });

    const browserSession = webContents.session;
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    if (typeof browserSession.setPermissionCheckHandler === 'function') browserSession.setPermissionCheckHandler(() => false);
    const downloadListener = (event, _item, owner) => {
      if (!isCurrent(generation, createdView) || owner?.id !== webContents.id) return;
      event.preventDefault();
      publish({ errorCode: 'SETUP_DOWNLOAD_BLOCKED' }, generation);
    };
    browserSession.on('will-download', downloadListener);
    downloadBinding = { session: browserSession, handler: downloadListener, generation };
  }

  function removeGenerationListeners(generation) {
    for (const binding of listenerBindings.filter(binding => binding.generation === generation)) {
      binding.emitter.removeListener(binding.eventName, binding.handler);
    }
    listenerBindings = listenerBindings.filter(binding => binding.generation !== generation);
    if (downloadBinding?.generation === generation) {
      downloadBinding.session.removeListener('will-download', downloadBinding.handler);
      downloadBinding = null;
    }
  }

  function startReadinessWatchdog(generation, createdView) {
    clearReadiness();
    readyPromise = new Promise(resolve => { readinessResolve = resolve; });
    readinessTimer = setTimeout(() => {
      if (!isCurrent(generation, createdView) || browserState !== 'creating') return;
      readinessTimer = null;
      if (readinessResolve) readinessResolve(false);
      readinessResolve = null;
      readyPromise = null;
      browserState = 'startup-timeout';
      guideState = 'idle';
      blockedState = { navigationBlocked: false, navigationType: 'readiness-timeout', blockedHostname: '', blockedStepId: currentStepId };
      publish({ loading: false, errorCode: 'SETUP_BROWSER_START_TIMEOUT', retryAvailable: true }, generation);
    }, Math.max(25, Number(readinessTimeoutMs) || 15000));
  }

  function reconcileOrphanedSetupLease() {
    if (hasLiveControllerState() || !coordinator.hasActive('setup_assistant')) return false;
    const orphan = coordinator.current().find(entry => entry.operation === 'setup_assistant');
    return orphan ? coordinator.end(orphan.token) : false;
  }

  async function createFreshGeneration(payload = {}) {
    reconcileOrphanedSetupLease();
    coordinator.assertInactive();
    operationToken = coordinator.begin('setup_assistant');
    controllerState = 'opening';
    const generation = ++generationSequence;
    currentGeneration = generation;
    browserIdentity = 0;
    browserState = 'creating';
    currentBounds = normalizeBounds(payload.bounds || {});
    setupLocale = String(payload.locale || 'en-CA').toLowerCase().startsWith('fr') ? 'fr-CA' : 'en-CA';
    failedBounds = { ...currentBounds };
    clearTransientState();
    try {
      await beforeOpen();
      if (generation !== currentGeneration || controllerState !== 'opening') throw Object.assign(new Error('SETUP_OPEN_CANCELLED'), { code: 'SETUP_OPEN_CANCELLED' });
      const createdView = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          navigateOnDragDrop: false,
          spellcheck: false,
          partition: SETUP_PARTITION
        }
      });
      view = createdView;
      browserIdentity = Number(createdView.webContents.id || 0);
      bindViewEvents(createdView, generation);
      attach(createdView);
      if (currentBounds.width > 0 && currentBounds.height > 0) createdView.setBounds(currentBounds);
      controllerState = 'open';
      startReadinessWatchdog(generation, createdView);
      let navigation;
      try {
        navigation = createdView.webContents.loadURL(DEVELOPER_PORTAL_URL);
      } catch (error) {
        navigation = Promise.reject(error);
      }
      pendingNavigation = Promise.resolve(navigation)
        .catch(error => {
          if (!isCurrent(generation, createdView)) return;
          clearReadiness();
          browserState = 'recoverable-error';
          lastLifecycle = navigationLifecycleDiagnostic('did-fail-load', DEVELOPER_PORTAL_URL, true, Number(error?.errno || 0), currentStepId);
          publish({ loading: false, errorCode: 'SETUP_PAGE_LOAD_FAILED', retryAvailable: true }, generation);
        })
        .finally(() => {
          if (isCurrent(generation, createdView)) pendingNavigation = null;
        });
      return publish({}, generation);
    } catch (error) {
      await closeSetupAssistant('initialization-failed');
      throw error;
    }
  }

  async function open(payload = {}) {
    if (openPromise) await openPromise.catch(() => {});
    openPromise = (async () => {
      if (hasLiveControllerState()) await closeSetupAssistant('fresh-open');
      return createFreshGeneration(payload);
    })();
    try { return await openPromise; }
    finally { openPromise = null; }
  }

  async function setStep(payload = {}) {
    if (!active()) throw Object.assign(new Error('SETUP_NOT_OPEN'), { code: 'SETUP_NOT_OPEN' });
    const step = setupStep(payload.stepId);
    if (!step) throw Object.assign(new Error('SETUP_STEP_INVALID'), { code: 'SETUP_STEP_INVALID' });
    const apiKey = payload.credentialState?.apiKey === true;
    const apiSecret = payload.credentialState?.apiSecret === true;
    const requestedPhase = ['copy-key', 'paste-key', 'copy-secret', 'paste-secret', 'ready'].includes(payload.credentialPhase)
      ? payload.credentialPhase
      : '';
    guideContext = {
      apiKey,
      apiSecret,
      businessConfirmed: guideContext.businessConfirmed === true,
      credentialPhase: requestedPhase || (!apiKey ? (guideContext.credentialPhase === 'paste-key' ? 'paste-key' : 'copy-key')
        : (!apiSecret ? (guideContext.credentialPhase === 'paste-secret' ? 'paste-secret' : 'copy-secret') : 'ready'))
    };
    if (currentPageState === PAGE_STATES.UNRECOGNIZED) currentStepId = step.id;
    if (step.id === 'finish' && currentPageState === PAGE_STATES.TRACKING_ENABLED) {
      detach();
      return publish({ highlightTargetFound: false });
    }
    attach();
    if (currentBounds.width > 0 && currentBounds.height > 0) view.setBounds(currentBounds);
    if (browserState === 'ready') return applyPageGuide(currentGeneration, view);
    return publish();
  }

  async function retryCurrentStep(payload = {}) {
    const bounds = normalizeBounds(payload.bounds || (failedBounds.width ? failedBounds : currentBounds));
    if (hasLiveControllerState()) await closeSetupAssistant('retry-browser');
    return open({ bounds });
  }

  async function navigateBack() {
    if (!active()) return { ok: false, code: 'SETUP_NOT_OPEN' };
    const navigation = safeBackNavigationState(view.webContents);
    if (!navigation.enabled) return { ok: false, code: 'SETUP_BACK_UNAVAILABLE' };
    guideWorkSequence += 1;
    clearProductAttempt();
    clearOffFlowTimer();
    currentClassification = null;
    currentPageState = PAGE_STATES.UNRECOGNIZED;
    highlightTarget = '';
    guideState = 'idle';
    browserState = 'loading';
    Promise.resolve(view.webContents.executeJavaScript(buildClearHighlightScript(), true)).catch(() => {});
    publish({ loading: true, highlightTargetFound: false });
    view.webContents.navigationHistory.goBack();
    return { ok: true, usedNavigationHistory: true };
  }

  async function startOver(payload = {}) {
    const bounds = normalizeBounds(payload.bounds || currentBounds);
    const locale = String(payload.locale || setupLocale);
    if (liveView()) {
      try { view.webContents.navigationHistory?.clear?.(); } catch (_) {}
    }
    if (hasLiveControllerState()) await closeSetupAssistant('start-over');
    return open({ bounds, locale });
  }

  function useCustomerNumber(payload = {}) {
    if (!active()) return { ok: false, code: 'SETUP_CUSTOMER_NUMBER_UNAVAILABLE' };
    const candidate = customerCandidates.get(String(payload.candidateId || ''));
    if (!candidate) return { ok: false, code: 'SETUP_CUSTOMER_NUMBER_CANDIDATE_INVALID' };
    guideContext.businessConfirmed = true;
    if (browserState === 'ready') applyPageGuide(currentGeneration, view).catch(() => {});
    return { ok: true, customerNumber: candidate.number, businessName: candidate.businessName };
  }

  function setBounds(bounds = {}) {
    currentBounds = normalizeBounds(bounds);
    if (!active() || currentStepId === 'finish') return snapshot();
    if (currentBounds.width < 80 || currentBounds.height < 80) {
      try { detach(); } catch (_) { attached = false; }
      return publish({ attached: false, errorCode: 'SETUP_BOUNDS_UNAVAILABLE' });
    }
    attach();
    view.setBounds(currentBounds);
    return publish();
  }

  function focus() {
    if (!active()) return { ok: false, code: 'SETUP_NOT_OPEN' };
    attach();
    getWindow()?.focus();
    view.webContents.focus();
    return snapshot();
  }

  async function closeSetupAssistant(reason = 'requested', finalOverrides = {}) {
    if (closePromise) return closePromise;
    const closingView = view;
    const closingWebContents = closingView?.webContents || null;
    const closingGeneration = currentGeneration;
    const closingToken = operationToken;
    const closingBounds = { ...currentBounds };
    controllerState = 'closing';
    currentGeneration = 0;
    guideWorkSequence += 1;
    if (domRefreshTimer) clearTimeout(domRefreshTimer);
    domRefreshTimer = null;
    clearReadiness();
    pendingNavigation = null;
    closePromise = (async () => {
      let cleanupFailed = false;
      const attempt = callback => {
        try { callback(); } catch (_) { cleanupFailed = true; }
      };
      try {
        removeGenerationListeners(closingGeneration);
        if (closingWebContents && !closingWebContents.isDestroyed()) {
          Promise.resolve(closingWebContents.executeJavaScript(buildClearHighlightScript(), true)).catch(() => {});
        }
        attempt(() => detach(closingView));
        attempt(() => {
          if (!closingWebContents || closingWebContents.isDestroyed()) return;
          try { closingWebContents.close({ waitForBeforeUnload: false }); } catch (_) { cleanupFailed = true; }
          if (!closingWebContents.isDestroyed()) closingWebContents.destroy();
        });
      } finally {
        try {
          if (closingToken) coordinator.end(closingToken);
        } finally {
          if (operationToken === closingToken) operationToken = '';
          if (view === closingView) view = null;
          attached = false;
          browserIdentity = 0;
          browserState = 'closed';
          currentBounds = { x: 0, y: 0, width: 0, height: 0 };
          if (Object.keys(finalOverrides).length) failedBounds = closingBounds;
          clearTransientState();
          listenerBindings = listenerBindings.filter(binding => binding.generation !== closingGeneration);
          if (downloadBinding?.generation === closingGeneration) downloadBinding = null;
          controllerState = 'idle';
          openPromise = null;
          readyPromise = null;
          pendingNavigation = null;
        }
      }
      const state = snapshot({
        active: false,
        attached: false,
        controllerState: 'idle',
        browserState: 'closed',
        browserPreparing: false,
        browserReady: false,
        highlightTargetFound: false,
        retryAvailable: false,
        openPromiseActive: false,
        readyPromiseActive: false,
        pendingNavigationActive: false,
        reason: String(reason || 'requested').slice(0, 80),
        ...finalOverrides,
        ...(cleanupFailed ? { errorCode: 'SETUP_CLEANUP_PARTIAL' } : {})
      });
      emit('setupAssistant:stateChanged', state);
      return state;
    })();
    try { return await closePromise; }
    finally { closePromise = null; }
  }

  return Object.freeze({
    active,
    hasLiveControllerState,
    snapshot,
    open,
    setStep,
    retryCurrentStep,
    navigateBack,
    startOver,
    useCustomerNumber,
    setBounds,
    focus,
    close: closeSetupAssistant,
    closeSetupAssistant,
    reconcileOrphanedSetupLease
  });
}

module.exports = { DOM_CHANGE_SENTINEL, ACTION_SENTINEL_PREFIX, normalizeBounds, setupCalloutLabels, safeBackNavigationState, createSetupAssistantController };
