'use strict';

(function publish(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SetupAssistantRenderer = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const STEPS = Object.freeze([
    Object.freeze({ id: 'sign-in', labelKey: 'setupAssistant.step.signIn.label', titleKey: 'setupAssistant.step.signIn.title', guidanceKey: 'setupAssistant.step.signIn.guidance', expectedKey: 'setupAssistant.step.signIn.expected', fallbackKey: 'setupAssistant.step.signIn.fallback' }),
    Object.freeze({ id: 'verify', labelKey: 'setupAssistant.step.verify.label', titleKey: 'setupAssistant.step.verify.title', guidanceKey: 'setupAssistant.step.verify.guidance', expectedKey: 'setupAssistant.step.verify.expected', fallbackKey: 'setupAssistant.step.verify.fallback' }),
    Object.freeze({ id: 'business', labelKey: 'setupAssistant.step.business.label', titleKey: 'setupAssistant.step.business.title', guidanceKey: 'setupAssistant.step.business.guidance', expectedKey: 'setupAssistant.step.business.expected', fallbackKey: 'setupAssistant.step.business.fallback' }),
    Object.freeze({ id: 'create-app', labelKey: 'setupAssistant.step.createApp.label', titleKey: 'setupAssistant.step.createApp.title', guidanceKey: 'setupAssistant.step.createApp.guidance', expectedKey: 'setupAssistant.step.createApp.expected', fallbackKey: 'setupAssistant.step.createApp.fallback' }),
    Object.freeze({ id: 'credentials', labelKey: 'setupAssistant.step.credentials.label', titleKey: 'setupAssistant.step.credentials.title', guidanceKey: 'setupAssistant.step.credentials.guidance', expectedKey: 'setupAssistant.step.credentials.expected', fallbackKey: 'setupAssistant.step.credentials.fallback' }),
    Object.freeze({ id: 'tracking', labelKey: 'setupAssistant.step.tracking.label', titleKey: 'setupAssistant.step.tracking.title', guidanceKey: 'setupAssistant.step.tracking.guidance', expectedKey: 'setupAssistant.step.tracking.expected', fallbackKey: 'setupAssistant.step.tracking.fallback' }),
    Object.freeze({ id: 'finish', labelKey: 'setupAssistant.step.finish.label', titleKey: 'setupAssistant.step.finish.title', guidanceKey: 'setupAssistant.step.finish.guidance', expectedKey: 'setupAssistant.step.finish.expected', fallbackKey: 'setupAssistant.step.finish.fallback' })
  ]);

  const ADAPTIVE_STATES = new Set([
    'DEV_PORTAL_SIGNED_OUT', 'LOGIN_PAGE', 'LOGIN_SUBMITTED', 'POST_AUTH_SETTLING', 'IDENTITY_METHOD_SELECTION', 'IDENTITY_CHALLENGE', 'SECURITY_QUESTION', 'MFA_INTRO', 'MFA_CODE', 'SESSION_LIMIT',
    'DEV_PORTAL_AUTHENTICATED', 'BUSINESS_TARGET_RESOLVING', 'BUSINESS_MENU_REQUIRED', 'BUSINESS_SELECTION', 'BUSINESS_ACCOUNT_FOUND', 'BUSINESS_CONFIRMED', 'APPS_PAGE', 'CREATE_APP',
    'CREATE_APP_SELECT_PRODUCTION', 'CREATE_APP_TEST_SELECTED', 'CREATE_APP_ENTER_NAME', 'CREATE_APP_READY',
    'CREDENTIALS_GENERATED', 'APP_DASHBOARD', 'API_PRODUCTS', 'API_PRODUCT_CATALOG', 'TRACKING_PRODUCT_CONFIRMATION',
    'WRONG_API_PRODUCT', 'TRACKING_REQUIRED_AFTER_WRONG_PRODUCT', 'TRACKING_ENABLED', 'OFF_FLOW_PAGE'
  ]);

  const BUSINESS_CONTEXT_STATES = new Set([
    'DEV_PORTAL_AUTHENTICATED', 'BUSINESS_TARGET_RESOLVING', 'BUSINESS_MENU_REQUIRED',
    'BUSINESS_SELECTION', 'BUSINESS_ACCOUNT_FOUND', 'BUSINESS_CONFIRMED'
  ]);

  const STATE_GUIDANCE = Object.freeze({
    DEV_PORTAL_SIGNED_OUT: 'portalSignIn',
    LOGIN_PAGE: 'login',
    LOGIN_SUBMITTED: 'mfaIntro',
    POST_AUTH_SETTLING: 'postAuthSettling',
    IDENTITY_METHOD_SELECTION: 'identityMethod',
    IDENTITY_CHALLENGE: 'identity',
    SECURITY_QUESTION: 'securityQuestion',
    MFA_INTRO: 'mfaIntro',
    MFA_CODE: 'mfaCode',
    SESSION_LIMIT: 'sessionLimit',
    DEV_PORTAL_AUTHENTICATED: 'business',
    BUSINESS_TARGET_RESOLVING: 'businessTargetResolving',
    BUSINESS_MENU_REQUIRED: 'businessMenu',
    BUSINESS_SELECTION: 'businessMenu',
    BUSINESS_ACCOUNT_FOUND: 'businessFound',
    BUSINESS_CONFIRMED: 'apps',
    APPS_PAGE: 'appsList',
    CREATE_APP: 'createApp',
    CREATE_APP_SELECT_PRODUCTION: 'createAppProduction',
    CREATE_APP_TEST_SELECTED: 'createAppTest',
    CREATE_APP_ENTER_NAME: 'createAppName',
    CREATE_APP_READY: 'createAppReady',
    CREDENTIALS_GENERATED: 'credentials',
    APP_DASHBOARD: 'apiProducts',
    API_PRODUCTS: 'apiProducts',
    API_PRODUCT_CATALOG: 'productCatalog',
    TRACKING_PRODUCT_CONFIRMATION: 'trackingConfirmation',
    WRONG_API_PRODUCT: 'wrongApiProduct',
    TRACKING_REQUIRED_AFTER_WRONG_PRODUCT: 'trackingStillRequired',
    TRACKING_ENABLED: 'trackingEnabled',
    OFF_FLOW_PAGE: 'offFlow'
  });

  function feedbackTonePlan(kind) {
    return kind === 'error'
      ? Object.freeze({ frequencies: [330, 245], durationMs: 190, volume: 0.22, masterGain: 0.6 })
      : Object.freeze({ frequencies: [523, 659], durationMs: 180, volume: 0.2, masterGain: 0.6 });
  }

  function createFeedbackGate(options = {}) {
    let enabled = options.enabled !== false;
    const played = new Set();
    return Object.freeze({
      setEnabled(value) { enabled = value !== false; },
      emit(kind, eventId) {
        const id = String(eventId || '');
        if (!id || played.has(id)) return false;
        played.add(id);
        if (enabled) options.play?.(kind, feedbackTonePlan(kind));
        options.visual?.(kind, id);
        return true;
      },
      reset() { played.clear(); },
      enabled: () => enabled
    });
  }

  function customerNumberState(value) {
    const input = String(value || '').trim().slice(0, 30);
    const valid = /^\d{1,10}$/.test(input);
    return { valid, normalized: valid ? input.padStart(10, '0') : input };
  }

  const SETUP_DRAFT_KEYS = Object.freeze([
    'webUsername', 'webPassword', 'estCustomerNumber', 'trackingApiClientId',
    'trackingApiClientSecret', 'trackingApiEnvironment', 'trackingProductEnabled', 'customerNumberVerified'
  ]);
  const GUIDED_DRAFT_FIELDS = Object.freeze({
    setupAssistantWebUsername: 'webUsername',
    setupAssistantWebPassword: 'webPassword',
    setupAssistantCustomerNumber: 'estCustomerNumber',
    setupAssistantClientId: 'trackingApiClientId',
    setupAssistantClientSecret: 'trackingApiClientSecret',
    setupAssistantApiEnvironment: 'trackingApiEnvironment'
  });
  const SETTINGS_DRAFT_FIELDS = Object.freeze({
    webUsername: 'webUsername',
    webPassword: 'webPassword',
    estCustomerNumber: 'estCustomerNumber',
    trackingClientId: 'trackingApiClientId',
    trackingClientSecret: 'trackingApiClientSecret',
    trackingApiEnvironment: 'trackingApiEnvironment'
  });

  function createSetupDraft(values = {}) {
    return Object.freeze({
      webUsername: String(values.webUsername || ''),
      webPassword: String(values.webPassword || ''),
      estCustomerNumber: String(values.estCustomerNumber ?? values.customerNumber ?? ''),
      trackingApiClientId: String(values.trackingApiClientId ?? values.trackingClientId ?? ''),
      trackingApiClientSecret: String(values.trackingApiClientSecret ?? values.trackingClientSecret ?? ''),
      trackingApiEnvironment: String(values.trackingApiEnvironment || 'production'),
      trackingProductEnabled: values.trackingProductEnabled === true,
      customerNumberVerified: values.customerNumberVerified === true
    });
  }

  function patchSetupDraft(draft, patch = {}) {
    const next = { ...createSetupDraft(draft) };
    for (const key of SETUP_DRAFT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      next[key] = ['trackingProductEnabled', 'customerNumberVerified'].includes(key) ? patch[key] === true : String(patch[key] ?? '');
    }
    return Object.freeze(next);
  }

  function draftPatchForField(fieldId, value) {
    const key = GUIDED_DRAFT_FIELDS[String(fieldId || '')];
    return key ? { [key]: String(value ?? '') } : null;
  }

  function assessCustomerCandidates(selectedValue, candidates = []) {
    const selected = customerNumberState(selectedValue).normalized;
    const available = Array.isArray(candidates) ? candidates : [];
    const createApp = available.filter(candidate => candidate?.source === 'create-app-customer-label');
    const matchingCreateApp = Boolean(selected && createApp.some(candidate => candidate.number === selected));
    const conflictingCreateApp = Boolean(selected && createApp.some(candidate => candidate.number !== selected));
    return Object.freeze({
      matchingCreateApp,
      conflictingCreateApp,
      visibleCandidates: matchingCreateApp && !conflictingCreateApp
        ? available.filter(candidate => candidate.source !== 'create-app-customer-label')
        : available
    });
  }

  function shouldPreserveConfirmedBusinessProgress(currentStepId, pageState, confirmed) {
    return confirmed === true
      && currentStepId === 'create-app'
      && BUSINESS_CONTEXT_STATES.has(String(pageState || ''));
  }

  function rectanglesOverlap(left, right) {
    return left.x < right.x + right.width && left.x + left.width > right.x
      && left.y < right.y + right.height && left.y + left.height > right.y;
  }

  function nativeBrowserBounds(rect = {}, viewport = {}, excludedRects = []) {
    let left = Math.max(0, Number(rect.left) || 0);
    const top = Math.max(0, Number(rect.top) || 0);
    let right = Math.min(Number(viewport.width) || 0, Number(rect.right) || 0);
    const bottom = Math.min(Number(viewport.height) || 0, Number(rect.bottom) || 0);
    for (const excluded of excludedRects) {
      const protectedRect = {
        x: Number(excluded?.left) || 0,
        y: Number(excluded?.top) || 0,
        width: Math.max(0, (Number(excluded?.right) || 0) - (Number(excluded?.left) || 0)),
        height: Math.max(0, (Number(excluded?.bottom) || 0) - (Number(excluded?.top) || 0))
      };
      const candidate = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
      if (!rectanglesOverlap(candidate, protectedRect)) continue;
      if (protectedRect.x >= left) right = Math.min(right, protectedRect.x);
      else if (protectedRect.x + protectedRect.width <= right) left = Math.max(left, protectedRect.x + protectedRect.width);
      else return { x: 0, y: 0, width: 0, height: 0 };
    }
    return {
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(0, Math.round(right - left)),
      height: Math.max(0, Math.round(bottom - top))
    };
  }

  function completionState(values = {}, stored = {}) {
    const clientId = String(values.trackingApiClientId ?? values.trackingClientId ?? '').trim();
    const clientSecret = String(values.trackingApiClientSecret ?? values.trackingClientSecret ?? '');
    const environmentChanged = Boolean(stored.trackingApiEnvironment)
      && String(values.trackingApiEnvironment || '') !== stored.trackingApiEnvironment;
    const replacingTrackingCredentials = Boolean(clientId || clientSecret || environmentChanged);
    return {
      webUsername: Boolean(String(values.webUsername || '').trim()),
      webPassword: Boolean(values.webPassword)
        || (stored.webPassword === true && (!stored.webUsername || String(values.webUsername || '').trim() === stored.webUsername)),
      customerNumber: customerNumberState(values.estCustomerNumber ?? values.customerNumber).valid,
      trackingClientId: replacingTrackingCredentials ? Boolean(clientId) : stored.trackingClientId === true,
      trackingClientSecret: replacingTrackingCredentials ? Boolean(clientSecret) : stored.trackingClientSecret === true,
      trackingProduct: values.trackingProductEnabled === true
    };
  }

  function completionReady(summary = {}) {
    return ['webUsername', 'webPassword', 'customerNumber', 'trackingClientId', 'trackingClientSecret', 'trackingProduct'].every(key => summary[key] === true);
  }

  function createController(deps) {
    const doc = deps.document;
    const api = deps.api;
    const tr = deps.tr;
    const saveSettings = deps.saveSettings;
    const storedState = deps.storedState;
    const byId = id => doc.getElementById(id);
    let stepIndex = 0;
    let open = false;
    let resizeObserver = null;
    let settingsStatusObserver = null;
    let rejectedCustomerCandidateSignature = '';
    let adaptivePageState = '';
    let setupDraft = null;
    let settingsBaseline = null;
    let saveCompleted = false;
    let pageContext = {};
    let latestClassificationVersion = 0;
    let confirmedBusiness = null;
    let audioContext = null;
    let feedbackVisualTimer = null;
    let lastFeedbackSemantic = '';
    let feedbackTransitionSequence = 0;
    let hasHydratedClassification = false;
    let lastFocusedCredentialPhase = '';
    let previousPageState = '';
    let restarting = false;

    function playTone(_kind, plan) {
      if (!audioContext || audioContext.state === 'closed') return;
      const start = audioContext.currentTime;
      const gain = audioContext.createGain();
      const master = audioContext.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(plan.volume, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + (plan.durationMs / 1000));
      master.gain.setValueAtTime(Math.min(0.6, Number(plan.masterGain) || 0.6), start);
      gain.connect(master);
      master.connect(audioContext.destination);
      plan.frequencies.forEach((frequency, index) => {
        const oscillator = audioContext.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, start + (index * 0.075));
        oscillator.connect(gain);
        oscillator.start(start + (index * 0.075));
        oscillator.stop(start + (plan.durationMs / 1000) + 0.08);
      });
    }

    function showFeedback(kind, messageKey) {
      const element = byId('setupAssistantFeedback');
      if (!element) return;
      if (feedbackVisualTimer) clearTimeout(feedbackVisualTimer);
      element.classList.toggle('error', kind === 'error');
      element.textContent = tr(messageKey);
      setHidden('setupAssistantFeedback', false);
      feedbackVisualTimer = setTimeout(() => {
        feedbackVisualTimer = null;
        setHidden('setupAssistantFeedback', true);
      }, 3200);
    }

    function clearFeedback() {
      if (feedbackVisualTimer) clearTimeout(feedbackVisualTimer);
      feedbackVisualTimer = null;
      setHidden('setupAssistantFeedback', true);
    }

    function switchEnabled(id) {
      return byId(id)?.getAttribute('aria-checked') !== 'false';
    }

    function renderSoundSwitch(id, stateId, enabled) {
      const control = byId(id);
      if (control) control.setAttribute('aria-checked', enabled ? 'true' : 'false');
      setText(stateId, tr(enabled ? 'settings.guidanceSoundsOn' : 'settings.guidanceSoundsOff'));
    }

    const feedback = createFeedbackGate({
      enabled: true,
      play: playTone,
      visual: () => {}
    });

    function feedbackEvent(kind, semanticId, messageKey) {
      const generation = Number(pageContext.browserGeneration || 0);
      const eventId = `${generation}:${semanticId}`;
      const emitted = feedback.emit(kind, eventId);
      if (emitted && messageKey) showFeedback(kind, messageKey);
      return emitted;
    }

    function feedbackTransition(kind, semanticId, messageKey) {
      if (!hasHydratedClassification || lastFeedbackSemantic === semanticId) {
        lastFeedbackSemantic = semanticId;
        return false;
      }
      lastFeedbackSemantic = semanticId;
      feedbackTransitionSequence += 1;
      return feedbackEvent(kind, `${semanticId}:${feedbackTransitionSequence}`, messageKey);
    }

    async function unlockAudio() {
      const AudioContextCtor = deps.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextCtor) return;
      if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextCtor();
      try { await audioContext.resume?.(); } catch (_) {}
    }

    function values() {
      return setupDraft || createSetupDraft();
    }

    function standardSettingsSnapshot() {
      return Object.freeze({
        webUsername: byId('webUsername')?.value || '',
        webPassword: byId('webPassword')?.value || '',
        estCustomerNumber: byId('estCustomerNumber')?.value || '',
        trackingApiClientId: byId('trackingClientId')?.value || '',
        trackingApiClientSecret: byId('trackingClientSecret')?.value || '',
        trackingApiEnvironment: byId('trackingApiEnvironment')?.value || 'production',
        rememberSettings: byId('rememberSettings')?.checked === true
      });
    }

    function writeField(id, value) {
      const field = byId(id);
      if (field) field.value = String(value ?? '');
    }

    function mirrorDraftToSettings() {
      if (!setupDraft) return;
      for (const [fieldId, draftKey] of Object.entries(SETTINGS_DRAFT_FIELDS)) writeField(fieldId, setupDraft[draftKey]);
    }

    function mirrorDraftToAssistant() {
      if (!setupDraft) return;
      writeField('setupAssistantWebUsername', setupDraft.webUsername);
      writeField('setupAssistantWebPassword', setupDraft.webPassword);
      writeField('setupAssistantCustomerNumber', setupDraft.estCustomerNumber);
      writeField('setupAssistantClientId', setupDraft.trackingApiClientId);
      writeField('setupAssistantClientSecret', setupDraft.trackingApiClientSecret);
      writeField('setupAssistantApiEnvironment', setupDraft.trackingApiEnvironment);
    }

    function updateDraft(patch, options = {}) {
      setupDraft = patchSetupDraft(setupDraft, patch);
      mirrorDraftToAssistant();
      if (options.mirror !== false) mirrorDraftToSettings();
      renderChecklist();
      return setupDraft;
    }

    function restoreSettingsBaseline() {
      if (!settingsBaseline) return;
      writeField('webUsername', settingsBaseline.webUsername);
      writeField('webPassword', settingsBaseline.webPassword);
      writeField('estCustomerNumber', settingsBaseline.estCustomerNumber);
      writeField('trackingClientId', settingsBaseline.trackingApiClientId);
      writeField('trackingClientSecret', settingsBaseline.trackingApiClientSecret);
      writeField('trackingApiEnvironment', settingsBaseline.trackingApiEnvironment);
      if (byId('rememberSettings')) byId('rememberSettings').checked = settingsBaseline.rememberSettings;
    }

    function credentialState() {
      const current = values();
      return {
        apiKey: Boolean(String(current.trackingApiClientId || '').trim()),
        apiSecret: Boolean(current.trackingApiClientSecret)
      };
    }

    function setText(id, text) {
      const element = byId(id);
      if (element) element.textContent = text;
    }

    function setHidden(id, hidden) {
      const element = byId(id);
      if (!element) return;
      element.classList.toggle('hidden', hidden);
      element.hidden = hidden;
      element.setAttribute('aria-hidden', hidden ? 'true' : 'false');
    }

    function renderSettingsStatusSegments() {
      const status = byId('settingsStatus');
      if (!status || status.dataset.cpcrSegmenting === 'true' || status.querySelector?.('[data-settings-status-tone]')) return;
      const text = String(status.textContent || '');
      const tokens = [
        [tr('settings.status.webOsEncrypted'), 'good', 'var(--success-text)'],
        [tr('settings.status.webLocalEncrypted'), 'warn', 'var(--warning-text)'],
        [tr('settings.status.webNotSaved'), 'bad', 'var(--danger-text)'],
        [tr('settings.status.apiReady'), 'good', 'var(--success-text)'],
        [tr('settings.status.apiMissing'), 'bad', 'var(--danger-text)']
      ].filter(([token]) => token && text.includes(token));
      if (!tokens.length) return;
      const matches = tokens
        .map(([token, tone, color]) => ({ token, tone, color, index: text.indexOf(token) }))
        .filter(match => match.index >= 0)
        .sort((left, right) => left.index - right.index);
      if (!matches.length) return;
      status.dataset.cpcrSegmenting = 'true';
      const children = [];
      let offset = 0;
      for (const match of matches) {
        if (match.index < offset) continue;
        if (match.index > offset) children.push(doc.createTextNode(text.slice(offset, match.index)));
        const span = doc.createElement('span');
        span.dataset.settingsStatusTone = match.tone;
        span.style.color = match.color;
        span.textContent = match.token;
        children.push(span);
        offset = match.index + match.token.length;
      }
      if (offset < text.length) children.push(doc.createTextNode(text.slice(offset)));
      status.replaceChildren(...children);
      if (text.includes(tr('settings.status.apiMissing'))) status.classList.remove('good', 'warn', 'bad');
      delete status.dataset.cpcrSegmenting;
    }

    function observeSettingsStatus() {
      renderSettingsStatusSegments();
      const status = byId('settingsStatus');
      const Observer = deps.MutationObserver || globalThis.MutationObserver;
      if (!status || typeof Observer !== 'function' || settingsStatusObserver) return;
      settingsStatusObserver = new Observer(() => renderSettingsStatusSegments());
      settingsStatusObserver.observe(status, { childList: true, characterData: true, subtree: true });
    }

    function showError(messageKey = '') {
      setHidden('setupAssistantError', !messageKey);
      setText('setupAssistantError', messageKey ? tr(messageKey) : '');
    }

    function showErrorText(message = '') {
      setHidden('setupAssistantError', !message);
      setText('setupAssistantError', message);
    }

    function browserBounds() {
      const slot = byId('setupAssistantBrowserSlot');
      if (!slot || !open || STEPS[stepIndex].id === 'finish') return { x: 0, y: 0, width: 0, height: 0 };
      const rect = slot.getBoundingClientRect();
      const protectedRects = ['setupAssistantStepsPanel', 'setupAssistantGuidance']
        .map(id => byId(id)?.getBoundingClientRect())
        .filter(Boolean);
      return nativeBrowserBounds(rect, {
        width: doc.documentElement.clientWidth,
        height: doc.documentElement.clientHeight
      }, protectedRects);
    }

    async function syncBounds() {
      if (!open) return;
      await api.setSetupAssistantBounds(browserBounds());
    }

    function renderProgress() {
      const list = byId('setupAssistantSteps');
      if (!list) return;
      list.replaceChildren(...STEPS.map((step, index) => {
        const item = doc.createElement('li');
        item.textContent = tr(step.labelKey);
        item.classList.toggle('active', index === stepIndex);
        item.classList.toggle('complete', index < stepIndex);
        item.setAttribute('aria-current', index === stepIndex ? 'step' : 'false');
        return item;
      }));
    }

    function renderChecklist() {
      const list = byId('setupAssistantChecklist');
      if (!list) return;
      const current = values();
      const stored = storedState();
      const summary = completionState(current, stored);
      const supplied = {
        webUsername: Boolean(String(current.webUsername || '').trim()) && String(current.webUsername || '').trim() !== String(stored.webUsername || '').trim(),
        webPassword: Boolean(current.webPassword),
        customerNumber: customerNumberState(current.estCustomerNumber).valid && customerNumberState(current.estCustomerNumber).normalized !== customerNumberState(stored.customerNumber).normalized,
        trackingClientId: Boolean(String(current.trackingApiClientId || '').trim()),
        trackingClientSecret: Boolean(current.trackingApiClientSecret),
        trackingProduct: current.trackingProductEnabled === true
      };
      const rows = [
        ['webUsername', 'setupAssistant.check.webUsername'],
        ['webPassword', 'setupAssistant.check.webPassword'],
        ['customerNumber', 'setupAssistant.check.customerNumber'],
        ['trackingClientId', 'setupAssistant.check.clientId'],
        ['trackingClientSecret', 'setupAssistant.check.clientSecret'],
        ['trackingProduct', 'setupAssistant.check.trackingProduct']
      ];
      list.replaceChildren(...rows.map(([key, labelKey]) => {
        const row = doc.createElement('div');
        row.className = `setup-assistant-check ${summary[key] ? 'good' : 'bad'}`;
        const label = doc.createElement('span');
        label.textContent = tr(labelKey);
        const status = doc.createElement('strong');
        status.textContent = tr(!summary[key]
          ? 'setupAssistant.check.missing'
          : (supplied[key] ? 'setupAssistant.check.ready' : 'setupAssistant.check.saved'));
        row.append(label, status);
        return row;
      }));
      if (byId('setupAssistantSaveFinish')) byId('setupAssistantSaveFinish').disabled = !completionReady(summary);
    }

    function renderCustomerCandidates(candidates = []) {
      const container = byId('setupAssistantCustomerCandidates');
      const list = byId('setupAssistantCustomerCandidateList');
      if (!container || !list) return;
      if (confirmedBusiness) {
        list.replaceChildren();
        setHidden('setupAssistantCustomerCandidates', true);
        return;
      }
      const assessment = assessCustomerCandidates(setupDraft?.estCustomerNumber, candidates);
      let available = assessment.visibleCandidates;
      if (assessment.matchingCreateApp && !assessment.conflictingCreateApp) {
        setupDraft = patchSetupDraft(setupDraft, { customerNumberVerified: true });
        setText('setupAssistantCustomerValidation', tr('setupAssistant.customerNumber.verified'));
      }
      if (assessment.conflictingCreateApp) {
        const conflict = available.map(candidate => candidate.number).sort().join(':');
        feedbackEvent('error', `customer-number-conflict:${conflict}`, 'setupAssistant.feedback.customerConflict');
      }
      const signature = available.map(candidate => String(candidate.candidateId || '')).join('|');
      const rejected = Boolean(signature && signature === rejectedCustomerCandidateSignature);
      setHidden('setupAssistantCustomerCandidates', available.length === 0 || rejected);
      setText('setupAssistantCustomerCandidateIntro', tr(assessment.conflictingCreateApp
        ? 'setupAssistant.customerNumber.mismatch'
        : (available.length > 1 ? 'setupAssistant.customerNumber.multipleFound' : 'setupAssistant.customerNumber.found')));
      setText('setupAssistantCustomerReject', tr(assessment.conflictingCreateApp
        ? 'setupAssistant.customerNumber.keepCurrent'
        : 'setupAssistant.customerNumber.reject'));
      list.replaceChildren(...available.map(candidate => {
        const row = doc.createElement('div');
        row.className = 'setup-assistant-candidate';
        const detail = doc.createElement('div');
        if (candidate.businessName) {
          const business = doc.createElement('span');
          business.textContent = String(candidate.businessName || '');
          detail.append(business);
        }
        const numberLabel = doc.createElement('span');
        numberLabel.textContent = tr('setupAssistant.customerNumber.detectedLabel');
        const number = doc.createElement('strong');
        number.textContent = String(candidate.number || '');
        const context = doc.createElement('span');
        const contextKeys = {
          'developer-business-selector': 'setupAssistant.customerNumber.context.developerBusiness',
          'viewing-business': 'setupAssistant.customerNumber.context.viewingBusiness',
          'customer-label': 'setupAssistant.customerNumber.context.customerLabel',
          'create-app-customer-label': 'setupAssistant.customerNumber.context.createApp',
          'business-summary': 'setupAssistant.customerNumber.context.businessSummary'
        };
        context.textContent = tr(contextKeys[candidate.source] || 'setupAssistant.customerNumber.context.developerBusiness');
        detail.append(numberLabel, number, context);
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'success';
        button.dataset.candidateId = String(candidate.candidateId || '');
        button.textContent = tr(available.length === 1 ? 'setupAssistant.customerNumber.confirm' : 'setupAssistant.customerNumber.use');
        row.append(detail, button);
        return row;
      }));
    }

    function guidanceKeys(step) {
      if (!ADAPTIVE_STATES.has(adaptivePageState)) return step;
      let stateKey = STATE_GUIDANCE[adaptivePageState];
      if (adaptivePageState === 'BUSINESS_SELECTION' && pageContext.businessSettingsTarget === true) stateKey = 'businessSettings';
      if (adaptivePageState === 'BUSINESS_MENU_REQUIRED' && pageContext.targetRole === 'currentBusinessControl'
          && pageContext.trackingTargetFound !== true) stateKey = 'businessMenuIndicatorMissing';
      if (adaptivePageState === 'API_PRODUCT_CATALOG' && pageContext.trackingTargetFound !== true) stateKey = 'productCatalogMissing';
      if (adaptivePageState === 'CREDENTIALS_GENERATED') {
        const phaseKeys = {
          'copy-key': 'credentialsCopyKey',
          'paste-key': 'credentialsPasteKey',
          'copy-secret': 'credentialsCopySecret',
          'paste-secret': 'credentialsPasteSecret',
          ready: 'credentialsDone'
        };
        stateKey = phaseKeys[pageContext.credentialPhase] || 'credentialsCopyKey';
      }
      const prefix = `setupAssistant.state.${stateKey}`;
      return {
        titleKey: `${prefix}.title`,
        guidanceKey: `${prefix}.guidance`,
        expectedKey: `${prefix}.expected`,
        fallbackKey: `${prefix}.fallback`
      };
    }

    function guidanceText(key) {
      return tr(key)
        .replace('{businessName}', String(pageContext.currentBusinessName || tr('setupAssistant.customerNumber.currentBusinessFallback')))
        .replace('{trackingProduct}', String(pageContext.trackingProductName || tr('setupAssistant.trackingProduct.fallbackName')))
        .replace('{selectedProduct}', String(pageContext.selectedProduct || tr('setupAssistant.trackingProduct.unknown')))
        .replace('{appName}', String(pageContext.appName || tr('setupAssistant.appName.recommended')));
    }

    function render(options = {}) {
      const step = STEPS[stepIndex];
      const guidance = guidanceKeys(step);
      renderSoundSwitch('setupAssistantGuidanceSounds', 'setupAssistantGuidanceSoundsState', feedback.enabled());
      setText('setupAssistantStepNumber', tr('setupAssistant.stepNumber').replace('{current}', String(stepIndex + 1)).replace('{total}', String(STEPS.length)));
      setText('setupAssistantStepTitle', guidanceText(guidance.titleKey));
      setText('setupAssistantStepGuidance', guidanceText(guidance.guidanceKey));
      setText('setupAssistantExpectedTarget', tr(guidance.expectedKey));
      setText('setupAssistantFallback', tr(guidance.fallbackKey));
      setHidden('setupAssistantFallback', true);
      setHidden('setupAssistantVerificationNotice', step.id !== 'verify');
      setHidden('setupAssistantAccountFields', step.id !== 'sign-in');
      setHidden('setupAssistantCustomerFields', step.id !== 'business');
      setHidden('setupAssistantApiFields', step.id !== 'credentials');
      setHidden('setupAssistantBusinessConfirmed', step.id !== 'business' || !confirmedBusiness);
      if (confirmedBusiness) {
        setText('setupAssistantConfirmedBusinessName', confirmedBusiness.businessName);
        setText('setupAssistantConfirmedCustomerNumber', tr('setupAssistant.businessConfirmed.customerNumber').replace('{number}', confirmedBusiness.customerNumber));
      }
      setHidden('setupAssistantLocalLoading', adaptivePageState !== 'POST_AUTH_SETTLING');
      setHidden('setupAssistantFinish', step.id !== 'finish');
      setHidden('setupAssistantCompletionSurface', step.id !== 'finish');
      const credentialPhase = pageContext.credentialPhase || 'copy-key';
      const keyPaste = step.id === 'credentials' && credentialPhase === 'paste-key';
      const secretPaste = step.id === 'credentials' && credentialPhase === 'paste-secret';
      setHidden('setupAssistantApiKeyField', !keyPaste);
      setHidden('setupAssistantApiSecretField', !secretPaste);
      byId('setupAssistantClientId')?.classList.toggle('setup-assistant-local-target', keyPaste);
      byId('setupAssistantClientSecret')?.classList.toggle('setup-assistant-local-target', secretPaste);
      setHidden('setupAssistantApiKeyCallout', !keyPaste);
      setHidden('setupAssistantApiSecretCallout', !secretPaste);
      if (byId('setupAssistantClientId')) byId('setupAssistantClientId').placeholder = tr('setupAssistant.placeholder.apiKey');
      if (byId('setupAssistantClientSecret')) byId('setupAssistantClientSecret').placeholder = tr('setupAssistant.placeholder.apiSecret');
      const credentialStatusKey = credentialPhase === 'ready'
        ? 'setupAssistant.feedback.credentialsCaptured'
        : (credentialState().apiSecret ? 'setupAssistant.feedback.apiSecretCaptured' : (credentialState().apiKey ? 'setupAssistant.feedback.apiKeyCaptured' : ''));
      setHidden('setupAssistantCredentialStatus', !credentialStatusKey);
      if (credentialStatusKey) setText('setupAssistantCredentialStatus', tr(credentialStatusKey));
      setHidden('setupAssistantBack', true);
      setHidden('setupAssistantNext', true);
      setHidden('setupAssistantSaveFinish', step.id !== 'finish');
      setHidden('setupAssistantCantFind', step.id === 'finish');
      setHidden('setupAssistantPageStatus', step.id === 'finish');
      const offFlow = adaptivePageState === 'OFF_FLOW_PAGE';
      const back = byId('setupAssistantBrowserBack');
      if (back) {
        back.disabled = pageContext.canGoBack !== true;
        back.classList.toggle('setup-assistant-local-action-target', offFlow && pageContext.canGoBack === true);
      }
      setHidden('setupAssistantBackCallout', !(offFlow && pageContext.canGoBack === true));
      if (!options.preserveRetry) setHidden('setupAssistantRetry', true);
      byId('setupAssistantBrowserSlot')?.classList.toggle('finish', step.id === 'finish');
      renderProgress();
      renderChecklist();
      if (step.id !== 'business') renderCustomerCandidates([]);
      if (!options.preserveError) showError('');
    }

    async function goTo(index) {
      stepIndex = Math.max(0, Math.min(STEPS.length - 1, index));
      adaptivePageState = '';
      render();
      const result = await api.setSetupAssistantStep({ stepId: STEPS[stepIndex].id, credentialState: credentialState() });
      if (!result?.ok) showError(result?.code === 'SETUP_ASSISTANT_ACTIVE' ? 'setupAssistant.error.step3Active' : 'setupAssistant.error.navigation');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await syncBounds();
    }

    function initializeDraft() {
      settingsBaseline = standardSettingsSnapshot();
      setupDraft = createSetupDraft({ ...settingsBaseline, trackingApiEnvironment: 'production', trackingProductEnabled: false });
      saveCompleted = false;
      pageContext = {};
      confirmedBusiness = null;
      lastFeedbackSemantic = '';
      feedbackTransitionSequence = 0;
      hasHydratedClassification = false;
      lastFocusedCredentialPhase = '';
      previousPageState = '';
      feedback.reset();
      const soundsEnabled = deps.guidanceSounds?.() !== false;
      feedback.setEnabled(soundsEnabled);
      renderSoundSwitch('setupAssistantGuidanceSounds', 'setupAssistantGuidanceSoundsState', soundsEnabled);
      mirrorDraftToAssistant();
    }

    async function openAssistant() {
      await unlockAudio();
      initializeDraft();
      stepIndex = 0;
      adaptivePageState = '';
      rejectedCustomerCandidateSignature = '';
      open = true;
      const modal = byId('setupAssistant');
      modal.classList.remove('hidden');
      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
      render();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const result = await api.openSetupAssistant({ bounds: browserBounds(), locale: doc.documentElement.lang });
      if (!result?.ok) {
        showError(result?.code === 'PROTECTED_OPERATION_ACTIVE' ? 'setupAssistant.error.protectedOperation' : 'setupAssistant.error.open');
        return;
      }
      resizeObserver = new ResizeObserver(() => syncBounds().catch(() => {}));
      resizeObserver.observe(byId('setupAssistantBrowserSlot'));
      byId('setupAssistantWebUsername')?.focus();
    }

    function clearLocalFields() {
      for (const id of ['setupAssistantWebUsername', 'setupAssistantWebPassword', 'setupAssistantCustomerNumber', 'setupAssistantClientId', 'setupAssistantClientSecret']) {
        if (byId(id)) byId(id).value = '';
      }
      adaptivePageState = '';
      stepIndex = 0;
      rejectedCustomerCandidateSignature = '';
      setupDraft = null;
      settingsBaseline = null;
      saveCompleted = false;
      pageContext = {};
      confirmedBusiness = null;
      lastFeedbackSemantic = '';
      hasHydratedClassification = false;
      if (feedbackVisualTimer) clearTimeout(feedbackVisualTimer);
      feedbackVisualTimer = null;
      setHidden('setupAssistantFeedback', true);
      setHidden('setupAssistantStartOverConfirm', true);
    }

    async function closeAssistant(options = {}) {
      resizeObserver?.disconnect();
      resizeObserver = null;
      await api.closeSetupAssistant();
      if (options.saved !== true && saveCompleted !== true) restoreSettingsBaseline();
      clearLocalFields();
      open = false;
      const modal = byId('setupAssistant');
      modal.classList.add('hidden');
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      byId('guidedCanadaPostSetup')?.focus();
    }

    async function useCustomerNumber(candidateId) {
      const result = await api.useSetupAssistantCustomerNumber({ candidateId });
      if (!result?.ok || !/^\d{10}$/.test(String(result.customerNumber || ''))) {
        showError('setupAssistant.error.customerNumberUse');
        return;
      }
      updateDraft({ estCustomerNumber: result.customerNumber, customerNumberVerified: true });
      confirmedBusiness = {
        businessName: String(result.businessName || pageContext.currentBusinessName || ''),
        customerNumber: String(result.customerNumber)
      };
      rejectedCustomerCandidateSignature = '';
      setHidden('setupAssistantCustomerCandidates', true);
      setHidden('setupAssistantBusinessConfirmed', false);
      setText('setupAssistantConfirmedBusinessName', confirmedBusiness.businessName);
      setText('setupAssistantConfirmedCustomerNumber', tr('setupAssistant.businessConfirmed.customerNumber').replace('{number}', confirmedBusiness.customerNumber));
      setText('setupAssistantCustomerValidation', tr('setupAssistant.customerNumber.selected'));
      feedbackEvent('success', 'business-confirmed', 'setupAssistant.feedback.businessConfirmed');
      renderChecklist();
    }

    async function refreshCredentialGuide(credentialPhase = pageContext.credentialPhase) {
      if (!open || STEPS[stepIndex].id !== 'credentials') return;
      await api.setSetupAssistantStep({ stepId: 'credentials', credentialState: credentialState(), credentialPhase });
    }

    async function retryCurrentStep() {
      showError('');
      setText('setupAssistantPageStatus', tr('setupAssistant.page.preparing'));
      setHidden('setupAssistantBrowserPlaceholder', false);
      const result = await api.retrySetupAssistantStep({ bounds: browserBounds() });
      if (!result?.ok) showError('setupAssistant.error.navigation');
    }

    async function saveAndFinish() {
      const current = values();
      const summary = completionState(current, storedState());
      if (!completionReady(summary)) {
        renderChecklist();
        showError('setupAssistant.error.incomplete');
        feedbackEvent('error', 'save-validation-failed', 'setupAssistant.feedback.saveFailed');
        return;
      }
      const normalized = updateDraft({
        webUsername: String(current.webUsername).trim(),
        estCustomerNumber: customerNumberState(current.estCustomerNumber).normalized,
        trackingApiClientId: String(current.trackingApiClientId).trim(),
        trackingApiClientSecret: String(current.trackingApiClientSecret).trim()
      });
      mirrorDraftToSettings();
      if (byId('trackingApiEnvironment')) byId('trackingApiEnvironment').value = normalized.trackingApiEnvironment;
      if (byId('rememberSettings')) byId('rememberSettings').checked = true;
      const result = await saveSettings();
      if (!result?.ok) {
        showErrorText(result?.error || tr('setupAssistant.error.save'));
        feedbackEvent('error', 'save-failed', 'setupAssistant.feedback.saveFailed');
        return;
      }
      const trackingCredentialsSupplied = Boolean(normalized.trackingApiClientId || normalized.trackingApiClientSecret);
      const credentialSaveFailed = (Boolean(normalized.webPassword) && result.passwordCredentialUpdated !== true)
        || (trackingCredentialsSupplied && (result.trackingApiCredentialsUpdated !== true || result.trackingApiCredentialsStored !== true));
      if (credentialSaveFailed) {
        showError('setupAssistant.error.credentialSave');
        feedbackEvent('error', 'credential-save-failed', 'setupAssistant.feedback.saveFailed');
        return;
      }
      if (trackingCredentialsSupplied && typeof api.loadConfig === 'function') {
        const persisted = await api.loadConfig();
        if (persisted?.trackingApiCredentialsStored !== true) {
          showError('setupAssistant.error.credentialSave');
          feedbackEvent('error', 'credential-persistence-verification-failed', 'setupAssistant.feedback.saveFailed');
          return;
        }
      }
      saveCompleted = true;
      setText('settingsStatus', tr('settings.savedStatus'));
      feedbackEvent('success', 'save-finish-complete', 'setupAssistant.feedback.settingsSaved');
      await closeAssistant({ saved: true });
    }

    function pageStateChanged(state = {}) {
      if (!open) return;
      if (restarting && state.controllerState === 'idle' && state.browserState === 'closed') return;
      if (!state.classification && (state.loading || state.browserPreparing)) {
        setHidden('setupAssistantBrowserPlaceholder', state.browserPreparing !== true);
        setText('setupAssistantPageStatus', tr(state.browserPreparing ? 'setupAssistant.page.preparing' : 'setupAssistant.page.loading'));
        return;
      }
      if (!state.classification && state.pageState === 'UNRECOGNIZED'
          && !state.navigationBlocked && !['startup-timeout', 'recoverable-error', 'failed'].includes(state.browserState)) return;
      const classification = state.classification && typeof state.classification === 'object' ? state.classification : null;
      if (classification) {
        const version = Number(classification.version || 0);
        if (version && version < latestClassificationVersion) return;
        latestClassificationVersion = Math.max(latestClassificationVersion, version);
        state = { ...state, ...classification };
      }
      pageContext = {
        browserGeneration: Number(state.browserGeneration || state.generation || 0),
        currentBusinessName: String(state.currentBusinessName || ''),
        trackingProductName: String(state.trackingProductName || ''),
        trackingTargetFound: state.highlightTargetFound === true,
        businessSettingsTarget: state.businessSettingsTarget === true,
        targetType: String(state.targetType || 'none'),
        targetRole: String(state.targetRole || ''),
        targetElementRole: String(state.targetElementRole || ''),
        targetResolved: state.targetResolved === true,
        overlayInstalled: state.overlayInstalled === true,
        primarySelectorMatched: state.primarySelectorMatched === true,
        businessTargetDiagnostic: String(state.businessTargetDiagnostic || ''),
        targetSurface: String(state.targetSurface || 'none'),
        canGoBack: state.canGoBack === true,
        credentialPhase: String(state.credentialPhase || pageContext.credentialPhase || 'copy-key'),
        appName: String(state.appName || ''),
        selectedProduct: [state.selectedProductName, state.selectedProductVersion].filter(Boolean).join(' '),
        selectedProductName: String(state.selectedProductName || ''),
        selectedProductVersion: String(state.selectedProductVersion || ''),
        selectedPlanName: String(state.selectedPlanName || ''),
        productAttemptId: String(state.productAttemptId || ''),
        overlayInstanceId: String(state.overlayInstanceId || '')
      };
      const preserveBusinessProgress = shouldPreserveConfirmedBusinessProgress(
        STEPS[stepIndex]?.id,
        state.pageState,
        Boolean(confirmedBusiness)
      );
      const adaptiveIndex = STEPS.findIndex(step => step.id === state.stepId);
      if (!preserveBusinessProgress && adaptiveIndex >= 0 && state.pageState !== 'UNRECOGNIZED') stepIndex = adaptiveIndex;
      if (!preserveBusinessProgress) {
        adaptivePageState = state.pageState === 'BUSINESS_SELECTION' && (state.customerNumberCandidates?.length || 0) > 0
          ? 'BUSINESS_ACCOUNT_FOUND'
          : (ADAPTIVE_STATES.has(state.pageState) ? state.pageState : '');
      }
      if (state.pageState === 'TRACKING_ENABLED' && setupDraft?.trackingProductEnabled !== true) {
        setupDraft = patchSetupDraft(setupDraft, { trackingProductEnabled: true });
      }
      render({ preserveError: true, preserveRetry: true });
      renderCustomerCandidates(preserveBusinessProgress ? [] : state.customerNumberCandidates);
      if (pageContext.credentialPhase !== lastFocusedCredentialPhase) {
        lastFocusedCredentialPhase = pageContext.credentialPhase;
        const localTarget = pageContext.credentialPhase === 'paste-key' ? byId('setupAssistantClientId')
          : (pageContext.credentialPhase === 'paste-secret' ? byId('setupAssistantClientSecret') : null);
        localTarget?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        localTarget?.focus?.();
      }
      if (state.pageState === 'API_PRODUCT_CATALOG'
          && ['WRONG_API_PRODUCT', 'TRACKING_PRODUCT_CONFIRMATION'].includes(previousPageState)) clearFeedback();
      const transitionFeedback = {
        POST_AUTH_SETTLING: ['success', 'post-authenticated', 'setupAssistant.feedback.signInComplete'],
        CREATE_APP_TEST_SELECTED: ['error', 'test-app-selected', 'setupAssistant.feedback.testSelected'],
        CREATE_APP_READY: ['success', `app-ready:${pageContext.appName}`, 'setupAssistant.feedback.appReady'],
        CREDENTIALS_GENERATED: ['success', 'production-app-created', 'setupAssistant.feedback.appCreated'],
        TRACKING_PRODUCT_CONFIRMATION: ['success', `tracking-selected:${pageContext.productAttemptId}`, 'setupAssistant.feedback.trackingSelected'],
        WRONG_API_PRODUCT: ['error', `wrong-product:${pageContext.productAttemptId}:${pageContext.selectedProduct}`, 'setupAssistant.feedback.wrongProduct'],
        TRACKING_REQUIRED_AFTER_WRONG_PRODUCT: ['error', `tracking-still-required:${pageContext.selectedProduct}`, 'setupAssistant.feedback.trackingStillRequired'],
        TRACKING_ENABLED: ['success', 'tracking-enabled', 'setupAssistant.feedback.trackingEnabled'],
        OFF_FLOW_PAGE: ['error', 'off-flow-page', 'setupAssistant.feedback.offFlow']
      }[state.pageState];
      if (transitionFeedback) feedbackTransition(...transitionFeedback);
      else if (ADAPTIVE_STATES.has(state.pageState)) lastFeedbackSemantic = state.pageState;
      if (previousPageState === 'CREATE_APP_TEST_SELECTED'
          && ['CREATE_APP_ENTER_NAME', 'CREATE_APP_READY'].includes(state.pageState)) {
        feedbackEvent('success', `production-selected:${classification?.version || 0}`, 'setupAssistant.feedback.productionSelected');
      }
      if (previousPageState === 'OFF_FLOW_PAGE' && ADAPTIVE_STATES.has(state.pageState) && state.pageState !== 'OFF_FLOW_PAGE') {
        feedbackEvent('success', `returned-to-setup:${classification?.version || 0}`, 'setupAssistant.feedback.returnedToSetup');
      }
      previousPageState = state.pageState;
      hasHydratedClassification = true;
      if (state.pageState === 'TRACKING_ENABLED') {
        setHidden('setupAssistantDetectedState', true);
        setHidden('setupAssistantFallback', true);
        setHidden('setupAssistantCantFind', true);
        setHidden('setupAssistantPageStatus', true);
        setText('setupAssistantPageStatus', '');
        showError('');
        return;
      }
      const detectionKey = ADAPTIVE_STATES.has(state.pageState) ? 'setupAssistant.detected.pageRecognized' : '';
      setHidden('setupAssistantDetectedState', !detectionKey);
      setText('setupAssistantDetectedState', detectionKey ? tr(detectionKey) : '');
      setHidden('setupAssistantRetry', state.retryAvailable !== true);
      setHidden('setupAssistantBrowserPlaceholder', state.browserPreparing !== true);
      if (state.navigationBlocked) {
        const hostname = String(state.blockedHostname || tr('setupAssistant.blockedHost.unknown'));
        showErrorText(tr('setupAssistant.error.navigationBlocked').replace('{hostname}', hostname));
      } else if (state.browserState === 'startup-timeout') {
        showError('setupAssistant.error.browserStart');
      } else if (state.browserState === 'recoverable-error' || state.browserState === 'failed') {
        const host = String(state.lastLifecycle?.hostname || state.hostname || tr('setupAssistant.blockedHost.unknown'));
        const category = String(state.lastLifecycle?.errorCategory || 'navigation_failed').replace(/_/g, ' ');
        const key = state.browserState === 'failed' ? 'setupAssistant.error.browserStopped' : 'setupAssistant.error.loadFailed';
        showErrorText(tr(key).replace('{hostname}', host).replace('{category}', category));
      } else if (state.loading || state.retryAvailable === false) showError('');
      const key = state.browserPreparing
        ? 'setupAssistant.page.preparing'
        : (state.browserState === 'loading'
          ? 'setupAssistant.page.loading'
          : (state.highlightTargetFound
            ? 'setupAssistant.page.targetFound'
            : (ADAPTIVE_STATES.has(state.pageState) ? 'setupAssistant.page.knownStateNoTarget' : 'setupAssistant.page.manualFallback')));
      setText('setupAssistantPageStatus', tr(key));
    }

    async function browserBack() {
      if (byId('setupAssistantBrowserBack')?.disabled) return;
      clearFeedback();
      byId('setupAssistantBrowserBack')?.classList.remove('setup-assistant-local-action-target');
      setHidden('setupAssistantBackCallout', true);
      const result = await api.backSetupAssistant();
      if (!result?.ok) showError('setupAssistant.error.backUnavailable');
    }

    function showStartOverConfirmation(show) {
      setHidden('setupAssistantStartOverConfirm', !show);
      if (show) byId('setupAssistantStartOverCancel')?.focus();
      else byId('setupAssistantStartOver')?.focus();
    }

    async function startOver() {
      showStartOverConfirmation(false);
      restarting = true;
      confirmedBusiness = null;
      adaptivePageState = '';
      stepIndex = 0;
      previousPageState = '';
      lastFeedbackSemantic = '';
      lastFocusedCredentialPhase = '';
      pageContext = {};
      clearFeedback();
      render({ preserveError: false });
      mirrorDraftToAssistant();
      mirrorDraftToSettings();
      const result = await api.startOverSetupAssistant({ bounds: browserBounds(), locale: doc.documentElement.lang });
      restarting = false;
      if (!result?.ok) {
        showError('setupAssistant.error.startOver');
        return;
      }
      const credentials = credentialState();
      await api.setSetupAssistantStep({
        stepId: 'sign-in',
        credentialState: credentials,
        credentialPhase: credentials.apiKey && credentials.apiSecret ? 'ready' : (credentials.apiKey ? 'copy-secret' : 'copy-key')
      });
    }

    function bind() {
      observeSettingsStatus();
      byId('guidedCanadaPostSetup')?.addEventListener('click', () => openAssistant().catch(() => showError('setupAssistant.error.open')));
      byId('setupAssistantClose')?.addEventListener('click', () => closeAssistant().catch(() => {}));
      byId('setupAssistantBrowserBack')?.addEventListener('click', () => browserBack().catch(() => showError('setupAssistant.error.backUnavailable')));
      byId('setupAssistantStartOver')?.addEventListener('click', () => showStartOverConfirmation(true));
      byId('setupAssistantStartOverCancel')?.addEventListener('click', () => showStartOverConfirmation(false));
      byId('setupAssistantStartOverConfirmButton')?.addEventListener('click', () => startOver().catch(() => {
        restarting = false;
        showError('setupAssistant.error.startOver');
      }));
      byId('setupAssistantCantFind')?.addEventListener('click', () => setHidden('setupAssistantFallback', false));
      byId('setupAssistantRetry')?.addEventListener('click', () => retryCurrentStep().catch(() => showError('setupAssistant.error.navigation')));
      byId('setupAssistantSaveFinish')?.addEventListener('click', () => saveAndFinish().catch(() => showError('setupAssistant.error.save')));
      byId('setupAssistantCustomerCandidateList')?.addEventListener('click', event => {
        const button = event.target?.closest?.('button[data-candidate-id]');
        if (button) useCustomerNumber(button.dataset.candidateId).catch(() => showError('setupAssistant.error.customerNumberUse'));
      });
      byId('setupAssistantCustomerReject')?.addEventListener('click', () => {
        const buttons = [...(byId('setupAssistantCustomerCandidateList')?.querySelectorAll?.('button[data-candidate-id]') || [])];
        rejectedCustomerCandidateSignature = buttons.map(button => String(button.dataset.candidateId || '')).join('|');
        setHidden('setupAssistantCustomerCandidates', true);
        if (!byId('setupAssistantCustomerFields')?.hidden) {
          if (byId('setupAssistantManualCustomer')) byId('setupAssistantManualCustomer').open = true;
          byId('setupAssistantCustomerNumber')?.focus();
        }
      });
      byId('setupAssistantCustomerNumber')?.addEventListener('input', () => {
        const state = customerNumberState(byId('setupAssistantCustomerNumber').value);
        updateDraft({
          ...draftPatchForField('setupAssistantCustomerNumber', byId('setupAssistantCustomerNumber').value),
          customerNumberVerified: false
        });
        setText('setupAssistantCustomerValidation', tr(state.valid ? 'setupAssistant.customerNumber.valid' : 'setupAssistant.customerNumber.invalid'));
      });
      for (const id of ['setupAssistantWebUsername', 'setupAssistantWebPassword']) {
        byId(id)?.addEventListener('input', () => updateDraft(draftPatchForField(id, byId(id).value)));
      }
      for (const id of ['setupAssistantClientId', 'setupAssistantClientSecret']) {
        byId(id)?.addEventListener('input', () => {
          const before = credentialState();
          updateDraft(draftPatchForField(id, byId(id).value));
          const after = credentialState();
          let nextPhase = pageContext.credentialPhase;
          if (id === 'setupAssistantClientId' && !before.apiKey && after.apiKey) {
            nextPhase = after.apiSecret ? 'ready' : 'copy-secret';
            feedbackEvent('success', 'api-key-captured', '');
          }
          if (id === 'setupAssistantClientSecret' && !before.apiSecret && after.apiSecret) {
            nextPhase = after.apiKey ? 'ready' : 'copy-key';
            feedbackEvent('success', 'api-secret-captured', '');
          }
          pageContext.credentialPhase = nextPhase;
          render({ preserveError: true, preserveRetry: true });
          refreshCredentialGuide(nextPhase).catch(() => {});
        });
      }
      byId('setupAssistantGuidanceSounds')?.addEventListener('click', () => {
        const enabled = !switchEnabled('setupAssistantGuidanceSounds');
        feedback.setEnabled(enabled);
        renderSoundSwitch('setupAssistantGuidanceSounds', 'setupAssistantGuidanceSoundsState', enabled);
        deps.onGuidanceSoundsChanged?.(enabled);
        api.saveConfig?.({ guidanceSounds: enabled }).catch(() => {});
        if (enabled) feedbackEvent('success', `sounds-preview:${Date.now()}`, '');
      });
      byId('setupAssistantApiEnvironment')?.addEventListener('change', () => updateDraft(draftPatchForField('setupAssistantApiEnvironment', byId('setupAssistantApiEnvironment').value)));
      api.onSetupAssistantState?.(pageStateChanged);
    }

    function localize() {
      if (open) render({ preserveError: true, preserveRetry: true });
      renderSettingsStatusSegments();
    }

    return Object.freeze({ bind, localize, openAssistant, closeAssistant, goTo, saveAndFinish, pageStateChanged, completionState: () => completionState(values(), storedState()) });
  }

  return {
    STEPS,
    SETUP_DRAFT_KEYS,
    GUIDED_DRAFT_FIELDS,
    SETTINGS_DRAFT_FIELDS,
    customerNumberState,
    createSetupDraft,
    patchSetupDraft,
    draftPatchForField,
    assessCustomerCandidates,
    shouldPreserveConfirmedBusinessProgress,
    rectanglesOverlap,
    nativeBrowserBounds,
    completionState,
    completionReady,
    feedbackTonePlan,
    createFeedbackGate,
    createController
  };
});
