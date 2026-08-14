'use strict';

const { validateCustomerNumber } = require('./input-validation');
const { mockOrigin } = require('./origin-policy');

const SETUP_PARTITION = 'persist:canadapost-claims-builtin';
const DEVELOPER_PORTAL_URL = 'https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/';
const ACCOUNT_SIGN_IN_URL = 'https://www.canadapost-postescanada.ca/lfe-cap/en/login';
const ACCOUNT_HOME_URL = 'https://www.canadapost-postescanada.ca/dash/en';

const OFFICIAL_SETUP_DOMAIN_FAMILIES = Object.freeze([
  'canadapost-postescanada.ca',
  'canadapost.ca'
]);

const PAGE_STATES = Object.freeze({
  DEV_PORTAL_SIGNED_OUT: 'DEV_PORTAL_SIGNED_OUT',
  LOGIN_PAGE: 'LOGIN_PAGE',
  LOGIN_SUBMITTED: 'LOGIN_SUBMITTED',
  POST_AUTH_SETTLING: 'POST_AUTH_SETTLING',
  IDENTITY_METHOD_SELECTION: 'IDENTITY_METHOD_SELECTION',
  IDENTITY_CHALLENGE: 'IDENTITY_CHALLENGE',
  SECURITY_QUESTION: 'SECURITY_QUESTION',
  MFA_INTRO: 'MFA_INTRO',
  MFA_CODE: 'MFA_CODE',
  SESSION_LIMIT: 'SESSION_LIMIT',
  DEV_PORTAL_AUTHENTICATED: 'DEV_PORTAL_AUTHENTICATED',
  BUSINESS_TARGET_RESOLVING: 'BUSINESS_TARGET_RESOLVING',
  BUSINESS_MENU_REQUIRED: 'BUSINESS_MENU_REQUIRED',
  BUSINESS_SELECTION: 'BUSINESS_SELECTION',
  BUSINESS_CONFIRMED: 'BUSINESS_CONFIRMED',
  APPS_PAGE: 'APPS_PAGE',
  CREATE_APP: 'CREATE_APP',
  CREATE_APP_SELECT_PRODUCTION: 'CREATE_APP_SELECT_PRODUCTION',
  CREATE_APP_TEST_SELECTED: 'CREATE_APP_TEST_SELECTED',
  CREATE_APP_ENTER_NAME: 'CREATE_APP_ENTER_NAME',
  CREATE_APP_READY: 'CREATE_APP_READY',
  CREDENTIALS_GENERATED: 'CREDENTIALS_GENERATED',
  APP_DASHBOARD: 'APP_DASHBOARD',
  API_PRODUCTS: 'API_PRODUCTS',
  API_PRODUCT_CATALOG: 'API_PRODUCT_CATALOG',
  TRACKING_PRODUCT_CONFIRMATION: 'TRACKING_PRODUCT_CONFIRMATION',
  WRONG_API_PRODUCT: 'WRONG_API_PRODUCT',
  TRACKING_REQUIRED_AFTER_WRONG_PRODUCT: 'TRACKING_REQUIRED_AFTER_WRONG_PRODUCT',
  TRACKING_ENABLED: 'TRACKING_ENABLED',
  OFF_FLOW_PAGE: 'OFF_FLOW_PAGE',
  UNRECOGNIZED: 'UNRECOGNIZED'
});

const SETUP_STEPS = Object.freeze([
  Object.freeze({ id: 'sign-in', labelKey: 'setupAssistant.step.signIn.label', titleKey: 'setupAssistant.step.signIn.title', guidanceKey: 'setupAssistant.step.signIn.guidance', expectedKey: 'setupAssistant.step.signIn.expected', fallbackKey: 'setupAssistant.step.signIn.fallback', startUrl: DEVELOPER_PORTAL_URL }),
  Object.freeze({ id: 'verify', labelKey: 'setupAssistant.step.verify.label', titleKey: 'setupAssistant.step.verify.title', guidanceKey: 'setupAssistant.step.verify.guidance', expectedKey: 'setupAssistant.step.verify.expected', fallbackKey: 'setupAssistant.step.verify.fallback', startUrl: '' }),
  Object.freeze({ id: 'business', labelKey: 'setupAssistant.step.business.label', titleKey: 'setupAssistant.step.business.title', guidanceKey: 'setupAssistant.step.business.guidance', expectedKey: 'setupAssistant.step.business.expected', fallbackKey: 'setupAssistant.step.business.fallback', startUrl: '' }),
  Object.freeze({ id: 'create-app', labelKey: 'setupAssistant.step.createApp.label', titleKey: 'setupAssistant.step.createApp.title', guidanceKey: 'setupAssistant.step.createApp.guidance', expectedKey: 'setupAssistant.step.createApp.expected', fallbackKey: 'setupAssistant.step.createApp.fallback', startUrl: '' }),
  Object.freeze({ id: 'credentials', labelKey: 'setupAssistant.step.credentials.label', titleKey: 'setupAssistant.step.credentials.title', guidanceKey: 'setupAssistant.step.credentials.guidance', expectedKey: 'setupAssistant.step.credentials.expected', fallbackKey: 'setupAssistant.step.credentials.fallback', startUrl: '' }),
  Object.freeze({ id: 'tracking', labelKey: 'setupAssistant.step.tracking.label', titleKey: 'setupAssistant.step.tracking.title', guidanceKey: 'setupAssistant.step.tracking.guidance', expectedKey: 'setupAssistant.step.tracking.expected', fallbackKey: 'setupAssistant.step.tracking.fallback', startUrl: '' }),
  Object.freeze({ id: 'finish', labelKey: 'setupAssistant.step.finish.label', titleKey: 'setupAssistant.step.finish.title', guidanceKey: 'setupAssistant.step.finish.guidance', expectedKey: 'setupAssistant.step.finish.expected', fallbackKey: 'setupAssistant.step.finish.fallback', startUrl: '' })
]);

const STATE_TO_STEP = Object.freeze({
  [PAGE_STATES.DEV_PORTAL_SIGNED_OUT]: 'sign-in',
  [PAGE_STATES.LOGIN_PAGE]: 'sign-in',
  [PAGE_STATES.LOGIN_SUBMITTED]: 'verify',
  [PAGE_STATES.POST_AUTH_SETTLING]: 'business',
  [PAGE_STATES.IDENTITY_METHOD_SELECTION]: 'verify',
  [PAGE_STATES.IDENTITY_CHALLENGE]: 'verify',
  [PAGE_STATES.SECURITY_QUESTION]: 'verify',
  [PAGE_STATES.MFA_INTRO]: 'verify',
  [PAGE_STATES.MFA_CODE]: 'verify',
  [PAGE_STATES.SESSION_LIMIT]: 'verify',
  [PAGE_STATES.DEV_PORTAL_AUTHENTICATED]: 'business',
  [PAGE_STATES.BUSINESS_TARGET_RESOLVING]: 'business',
  [PAGE_STATES.BUSINESS_MENU_REQUIRED]: 'business',
  [PAGE_STATES.BUSINESS_SELECTION]: 'business',
  [PAGE_STATES.BUSINESS_CONFIRMED]: 'business',
  [PAGE_STATES.APPS_PAGE]: 'create-app',
  [PAGE_STATES.CREATE_APP]: 'create-app',
  [PAGE_STATES.CREATE_APP_SELECT_PRODUCTION]: 'create-app',
  [PAGE_STATES.CREATE_APP_TEST_SELECTED]: 'create-app',
  [PAGE_STATES.CREATE_APP_ENTER_NAME]: 'create-app',
  [PAGE_STATES.CREATE_APP_READY]: 'create-app',
  [PAGE_STATES.CREDENTIALS_GENERATED]: 'credentials',
  [PAGE_STATES.APP_DASHBOARD]: 'tracking',
  [PAGE_STATES.API_PRODUCTS]: 'tracking',
  [PAGE_STATES.API_PRODUCT_CATALOG]: 'tracking',
  [PAGE_STATES.TRACKING_PRODUCT_CONFIRMATION]: 'tracking',
  [PAGE_STATES.WRONG_API_PRODUCT]: 'tracking',
  [PAGE_STATES.TRACKING_REQUIRED_AFTER_WRONG_PRODUCT]: 'tracking',
  [PAGE_STATES.TRACKING_ENABLED]: 'finish'
});

function classificationFingerprint(value = {}) {
  return [
    value.pageState || value.state || '',
    value.selectedProductName || value.productName || '',
    value.selectedProductVersion || value.productVersion || '',
    value.selectedPlanName || value.plan || '',
    value.overlayInstanceId || '',
    value.productAttemptId || '',
    value.targetKey || '',
    value.targetSurface || 'none',
    value.targetResolved === true ? 'target-resolved' : 'target-unresolved',
    value.overlayInstalled === true ? 'overlay-installed' : 'overlay-missing'
  ].map(part => String(part).replace(/\s+/g, ' ').trim()).join('|');
}

function setupStep(stepId) {
  return SETUP_STEPS.find(step => step.id === String(stepId || '')) || null;
}

function stepForPageState(pageState) {
  return STATE_TO_STEP[String(pageState || '')] || '';
}

function isOfficialSetupHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return OFFICIAL_SETUP_DOMAIN_FAMILIES.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

function isAllowedSetupUrl(value, env = process.env) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol === 'about:' && parsed.href === 'about:blank') return true;
    if (parsed.protocol === 'https:' && isOfficialSetupHostname(parsed.hostname)) return true;
    const mock = mockOrigin(env);
    return Boolean(mock && parsed.origin === mock);
  } catch (_) {
    return false;
  }
}

function blockedNavigationDiagnostic(value, navigationType, stepId) {
  let hostname = '';
  try { hostname = new URL(String(value || '')).hostname.toLowerCase(); } catch (_) {}
  return Object.freeze({
    blockedHostname: hostname,
    navigationType: String(navigationType || 'navigation').slice(0, 40),
    stepId: setupStep(stepId)?.id || 'unknown'
  });
}

function safeNavigationErrorCategory(errorCode) {
  const code = Number(errorCode || 0);
  if (code === -3) return 'navigation_aborted';
  if (code <= -200 && code > -300) return 'certificate_error';
  if ([-105, -137].includes(code)) return 'name_resolution_failed';
  if ([-102, -106, -109, -118].includes(code)) return 'connection_failed';
  return code ? 'navigation_failed' : 'browser_process_failed';
}

function navigationLifecycleDiagnostic(eventType, value, isMainFrame, errorCode, stepId) {
  let hostname = '';
  try { hostname = new URL(String(value || '')).hostname.toLowerCase(); } catch (_) {}
  const code = Number(errorCode || 0);
  return Object.freeze({
    eventType: String(eventType || 'navigation').slice(0, 40),
    hostname,
    mainFrame: isMainFrame === true,
    errorCode: Number.isFinite(code) ? code : 0,
    errorCategory: safeNavigationErrorCategory(code),
    stepId: setupStep(stepId)?.id || 'unknown'
  });
}

function approvedPopupLoadOptions(details = {}) {
  const options = {};
  const data = Array.isArray(details.postBody?.data) ? details.postBody.data : [];
  if (data.length) options.postData = data;
  const contentType = String(details.postBody?.contentType || '').trim();
  const boundary = String(details.postBody?.boundary || '').trim();
  if (data.length && contentType && !/[\r\n]/.test(contentType) && !/[\r\n]/.test(boundary)) {
    const value = boundary && /^multipart\/form-data$/i.test(contentType) ? `${contentType}; boundary=${boundary}` : contentType;
    options.extraHeaders = `Content-Type: ${value}\r\n`;
  }
  if (details.referrer && typeof details.referrer === 'object') options.httpReferrer = details.referrer;
  return options;
}

function sanitizeSetupLocation(value) {
  try {
    const parsed = new URL(String(value || ''));
    const pathname = parsed.pathname.split('/').map(segment => (
      /%40|@|\d{6,}|[a-f0-9]{24,}/i.test(segment) ? '[redacted-id]' : segment
    )).join('/').slice(0, 500);
    return { hostname: parsed.hostname.toLowerCase(), pathname };
  } catch (_) {
    return { hostname: '', pathname: '' };
  }
}

function classifySetupPage(value) {
  const { hostname, pathname } = sanitizeSetupLocation(value);
  const path = pathname.toLowerCase();
  if (!hostname || !isOfficialSetupHostname(hostname)) return PAGE_STATES.UNRECOGNIZED;
  if (/session-limit/.test(path)) return PAGE_STATES.SESSION_LIMIT;
  if (/(?:sso|auth|login|signin|sign-in)/.test(hostname) || /(?:login|signin|sign-in|forgot|reset)/.test(path)) return PAGE_STATES.LOGIN_PAGE;
  if (/(?:developer|developpeur)/.test(hostname) || /devportal-portaildesdeveloppeurs/.test(path)) return PAGE_STATES.DEV_PORTAL_SIGNED_OUT;
  return PAGE_STATES.UNRECOGNIZED;
}

function normalizeAccessibleControlName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/[▼▽▾⌄⌃▲△▴]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function accessibleControlName(metadata = {}) {
  return normalizeAccessibleControlName(
    metadata.ariaLabel || metadata.labelledBy || metadata.associatedLabel
    || metadata.text || metadata.title || metadata.placeholder || ''
  );
}

function isSafeCurrentBusinessLink(metadata = {}, currentUrl = '') {
  const name = normalizeAccessibleControlName(metadata.name).toLowerCase();
  if (String(metadata.role || '').toLowerCase() !== 'link' || metadata.inAuthenticatedHeader !== true
      || metadata.currentIndicator !== true || !name) return false;
  if (/^(?:home|overview|apps?|apis?|products?|documentation|support|help|fr|en|user menu|profile|sign in|view organization settings|register an organization|delete organization|manage|analytics|notifications)$/i.test(name)) return false;
  if (/register|delete|settings|profile|user|another organization|switch/i.test(`${metadata.identity || ''} ${name}`)) return false;
  const href = String(metadata.href || '').trim();
  if (!href || href === '#' || /^javascript:\s*void\s*\(?(?:0)?\)?;?$/i.test(href)) return true;
  try {
    const current = new URL(String(currentUrl || ''));
    const destination = new URL(href, current);
    return destination.origin === current.origin && destination.pathname === current.pathname
      && (!destination.search || destination.search === current.search);
  } catch (_) {
    return false;
  }
}

function resolveAuthenticatedHeaderOrganizationControl(controls = []) {
  const excluded = /^(?:fr|en|apps?|portal settings|param[èe]tres du portail|user menu|profile|sign in|view organization settings|register an organization|delete organization)$/i;
  const values = (Array.isArray(controls) ? controls : []).map((control, index) => ({
    index,
    role: String(control?.role || '').toLowerCase(),
    name: normalizeAccessibleControlName(control?.name),
    identity: String(control?.identity || '').toLowerCase().slice(0, 500),
    inHeader: control?.inHeader === true,
    visible: control?.visible !== false,
    viewportPresent: control?.viewportPresent !== false,
    dropdown: control?.dropdown === true,
    organizationEvidence: control?.organizationEvidence === true,
    profileEvidence: control?.profileEvidence === true,
    languageEvidence: control?.languageEvidence === true,
    order: Number.isFinite(Number(control?.order)) ? Number(control.order) : index
  })).filter(control => control.inHeader && control.visible && control.viewportPresent
    && ['link', 'button'].includes(control.role) && control.name);
  let profiles = values.filter(control => control.profileEvidence || /(?:^|[\s_-])(?:user|profile|avatar|person)(?:$|[\s_-])/i.test(control.identity));
  if (!profiles.length) {
    const languageOrder = Math.max(-1, ...values.filter(control => control.languageEvidence).map(control => control.order));
    const dropdownsAfterLanguage = values.filter(control => control.dropdown && control.order > languageOrder);
    if (languageOrder >= 0 && dropdownsAfterLanguage.length >= 2) profiles = [dropdownsAfterLanguage.at(-1)];
  }
  if (profiles.length !== 1) return null;
  const profile = profiles[0];
  const preceding = values.filter(control => control.order < profile.order
    && control.index !== profile.index
    && !control.profileEvidence
    && !control.languageEvidence
    && !excluded.test(control.name)
    && !/(?:profile|user|avatar|person|portal.settings|language)/i.test(control.identity))
    .sort((left, right) => right.order - left.order);
  const candidate = preceding[0];
  if (!candidate) return null;
  const hasLanguageBefore = values.some(control => control.languageEvidence && control.order < candidate.order);
  if (!candidate.organizationEvidence && !candidate.dropdown && !hasLanguageBefore) return null;
  return Object.freeze({ controlIndex: candidate.index, profileControlIndex: profile.index, businessName: candidate.name });
}

function describeKnownOrganizationControl(metadata = {}) {
  const currentOrg = normalizeAccessibleControlName(metadata.currentOrgText);
  const title = String(metadata.title || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const titleBusiness = /^current organization\s*:\s*(.+)$/i.exec(title)?.[1] || '';
  const businessName = currentOrg || normalizeAccessibleControlName(titleBusiness) || normalizeAccessibleControlName(metadata.accessibleName);
  const open = String(metadata.ariaExpanded || '').toLowerCase() === 'true' || metadata.submenuVisible === true;
  return Object.freeze({
    businessName,
    open,
    state: open ? 'BUSINESS_SELECTION' : 'BUSINESS_MENU_REQUIRED'
  });
}

function normalizedSemanticControls(controls = []) {
  return (Array.isArray(controls) ? controls : []).map(control => ({
    role: String(control?.role || '').trim().toLowerCase(),
    name: normalizeAccessibleControlName(control?.name).toLowerCase(),
    kind: String(control?.kind || '').trim().toLowerCase(),
    semantic: String(control?.semantic || '').trim().toLowerCase(),
    inActiveDialog: control?.inActiveDialog === true,
    checked: control?.checked === true
  }));
}

function recognizeApiProductConfirmation(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!/add api product|ajouter un produit api/i.test(text)
      || !/default[ -]plan|plan par d[ée]faut/i.test(text)) return null;
  const matches = [...text.matchAll(/\(?\s*(\d+\.\d+\.\d+)\s*\)?/g)]
    .map(match => {
      const prefix = text.slice(0, match.index).split(/\b(?:plan|forfait)\b/i).at(-1) || '';
      const productName = prefix.replace(/^.*(?:add api product|ajouter un produit api|api product|produit api)\s*/i, '').trim().slice(-80);
      return { productName, version: match[1] };
    })
    .filter(product => /^[A-Za-z][A-Za-z &'-]{1,80}$/.test(product.productName));
  const selected = matches.at(-1);
  if (!selected) return null;
  return Object.freeze({
    ...selected,
    planName: /plan par d[ée]faut/i.test(text) ? 'Default plan' : (/default[ -]plan/i.exec(text)?.[0] || 'Default plan'),
    supportedTracking: /^tracking$/i.test(selected.productName) && selected.version === '2.0.0'
  });
}

function recognizeAssignedApiProducts(value) {
  const rows = String(value || '').split(/\n+/).map(row => row.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return rows.flatMap(row => [...row.matchAll(/([A-Za-z][A-Za-z &'-]{1,80}?)\s*\(?\s*(\d+\.\d+\.\d+)\s*\)?/g)]
    .map(match => ({ productName: match[1].trim(), version: match[2] })))
    .filter(product => !/api products?|default plan/i.test(product.productName));
}

function classifySetupSignals(signals = {}) {
  const pathname = String(signals.pathname || '').toLowerCase();
  const controls = normalizedSemanticControls(signals.controls);
  const text = (Array.isArray(signals.text) ? signals.text : [])
    .map(value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 240))
    .filter(Boolean);
  const allNames = controls.map(control => control.name);
  const allText = [...text, ...allNames].join(' \n ');
  const dialogs = (Array.isArray(signals.dialogs) ? signals.dialogs : []).map(value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 600));
  const dialogControls = normalizedSemanticControls(signals.dialogControls);
  const statusText = (Array.isArray(signals.statusText) ? signals.statusText : []).map(value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 600)).join(' \n ');
  const apiProductText = (Array.isArray(signals.apiProductText) ? signals.apiProductText : []).map(value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 600)).join(' \n ');
  const dialogText = dialogs.join(' \n ');
  const hasControl = (role, pattern) => controls.some(control => (!role || control.role === role) && pattern.test(control.name));
  const hasAnyControl = pattern => controls.some(control => pattern.test(control.name));
  const businesses = Array.isArray(signals.businesses) ? signals.businesses : [];
  const hasBusinessSelector = controls.some(control => control.semantic === 'business-selector');
  const hasAuthenticatedProfile = controls.some(control => control.semantic === 'authenticated-profile');
  const hasAuthenticatedApps = controls.some(control => control.role === 'link' && /^apps|applications$/i.test(control.name));
  const hasAuthenticatedContent = /(?:organization|organisation)\s+(?:analytics|manage|notifications)|create new app|api products|view organization settings/i.test(allText);
  const authenticated = hasBusinessSelector || hasAuthenticatedProfile || hasAuthenticatedApps || hasAuthenticatedContent || businesses.length > 0;
  const dialogHas = (role, pattern) => dialogControls.some(control => (!role || control.role === role) && pattern.test(control.name));
  const trackingVersion = /tracking\s*(?:api\s*)?\(?\s*2\.0\.0\s*\)?|rep[ée]rage\s*\(?\s*2\.0\.0\s*\)?/i;
  const trackingAdded = /api product added|produit api ajout[ée]/i.test(statusText)
    && trackingVersion.test(`${statusText} ${apiProductText}`);
  const trackingAssigned = trackingVersion.test(apiProductText);
  const selectedProduct = recognizeApiProductConfirmation(dialogText);
  const hasExactDialogAdd = dialogHas('link', /^add$|^ajouter$/i);
  const hasDialogBack = dialogHas('', /^back$|^retour$/i);
  const nonTrackingAssigned = recognizeAssignedApiProducts(apiProductText)
    .find(product => !/^tracking$/i.test(product.productName));

  if (trackingAdded || trackingAssigned) return PAGE_STATES.TRACKING_ENABLED;
  if (/app credentials generated/i.test(allText) || (hasAnyControl(/^copy api key$/i) && hasAnyControl(/^copy api secret$/i))) return PAGE_STATES.CREDENTIALS_GENERATED;
  if (selectedProduct && hasExactDialogAdd && hasDialogBack) {
    return selectedProduct.supportedTracking ? PAGE_STATES.TRACKING_PRODUCT_CONFIRMATION : PAGE_STATES.WRONG_API_PRODUCT;
  }
  if (/add api product|ajouter un produit api/i.test(dialogText)
      && (dialogHas('link', /^get access to tracking$/i)
        || dialogControls.some(control => control.role === 'link' && /^get access to /i.test(control.name)))) return PAGE_STATES.API_PRODUCT_CATALOG;
  if (/session-limit/.test(pathname) || hasAnyControl(/^disconnect session$/i)) return PAGE_STATES.SESSION_LIMIT;
  if (hasControl('textbox', /^access code$/i)) return PAGE_STATES.MFA_CODE;
  const hasAnswerInput = controls.some(control => control.role === 'textbox'
    && /^(?:answer|security answer|r[ée]ponse|r[ée]ponse de s[ée]curit[ée])$/i.test(control.name));
  const verificationRadios = controls.filter(control => control.role === 'radio');
  if (/verify your identity|v[ée]rifiez votre identit[ée]/i.test(allText)
      && verificationRadios.length >= 2
      && !hasAnswerInput
      && hasControl('button', /^continue|continuer$/i)) return PAGE_STATES.IDENTITY_METHOD_SELECTION;
  if (/security question|question de s[ée]curit[ée]/i.test(allText)
      && hasAnswerInput
      && hasControl('button', /^continue|continuer$/i)) return PAGE_STATES.SECURITY_QUESTION;
  if (/verify your identity|v[ée]rifiez votre identit[ée]|confirm your identity|identity verification/i.test(allText)
      && hasControl('button', /^continue|continuer$/i)) return PAGE_STATES.IDENTITY_CHALLENGE;
  if (hasControl('button', /^continue$/i) && /(?:verify|verification|access code|confirm your identity|security code)/i.test(allText)) return PAGE_STATES.MFA_INTRO;
  if (hasControl('textbox', /^username$/i) && hasControl('textbox', /^password$/i) && hasControl('button', /^sign in$/i)) return PAGE_STATES.LOGIN_PAGE;
  if (hasControl('textbox', /^app name$/i) && hasControl('button', /^create$/i) && hasAnyControl(/^production$/i)) {
    if (signals.createApp?.testSelected === true) return PAGE_STATES.CREATE_APP_TEST_SELECTED;
    if (signals.createApp?.productionSelected !== true) return PAGE_STATES.CREATE_APP_SELECT_PRODUCTION;
    if (signals.createApp?.appNamePresent !== true) return PAGE_STATES.CREATE_APP_ENTER_NAME;
    return PAGE_STATES.CREATE_APP_READY;
  }
  if (nonTrackingAssigned && hasAnyControl(/^add api product$/i)) return PAGE_STATES.TRACKING_REQUIRED_AFTER_WRONG_PRODUCT;
  if (hasAnyControl(/^add api product$/i)) return PAGE_STATES.API_PRODUCTS;
  if (/(?:api products|produits api)/i.test(allText)) return PAGE_STATES.APP_DASHBOARD;
  if (hasAnyControl(/^create new app$/i) || controls.some(control => /production/.test(control.name) && /app|claim runner/.test(control.name))) return PAGE_STATES.APPS_PAGE;
  if (businesses.length && hasAnyControl(/^apps$/i)) return PAGE_STATES.BUSINESS_CONFIRMED;
  if (businesses.length) return PAGE_STATES.BUSINESS_SELECTION;
  if (hasBusinessSelector) return PAGE_STATES.BUSINESS_MENU_REQUIRED;
  if (!authenticated && hasControl('link', /^sign in$/i)
      && (/developer portal/i.test(allText) || /devportal-portaildesdeveloppeurs/.test(pathname))) return PAGE_STATES.DEV_PORTAL_SIGNED_OUT;
  if (hasAnyControl(/^apps$/i) || /developer portal/i.test(allText)) return PAGE_STATES.DEV_PORTAL_AUTHENTICATED;
  if (hasControl('button', /^continue$/i)) return PAGE_STATES.LOGIN_SUBMITTED;
  return PAGE_STATES.UNRECOGNIZED;
}

function recognizeCustomerNumberText(value, options = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!text) return [];
  const matches = [];
  const add = (number, source, priority, businessName = '') => {
    const validated = validateCustomerNumber(number);
    if (!validated.valid) return;
    matches.push({
      number: validated.normalized,
      businessName: String(businessName || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      source,
      confidence: 'high',
      priority
    });
  };
  let match = /\bviewing\s+page\s+as\s*:?\s*(.{1,160}?)\s*\(\s*(\d{1,10})\s*\)/i.exec(text);
  if (match) add(match[2], 'viewing-business', 30, match[1]);
  match = /(?:customer\s*(?:number|no\.?|#)|num[ée]ro\s+de\s+client)\s*[:#-]?\s*(\d{1,10})\b/i.exec(text);
  if (match) add(match[1], 'customer-label', 40);
  if (options.developerBusinessSelector === true) {
    match = /^(.{2,160}?)\s*\(\s*(\d{1,10})\s*\)\s*$/i.exec(text);
    if (match && !/^(?:user|username|account id|reference)$/i.test(match[1].trim())) add(match[2], 'developer-business-selector', 35, match[1]);
  }
  if (options.businessContext === true && /\b(?:business|company|commercial|merchant|entreprise|account)\b/i.test(text)) {
    match = /(?:business|company|commercial|merchant|entreprise|account).{0,120}?(?:number|no\.?|#|identity|id)?\s*[:#(-]?\s*(\d{1,10})\s*\)?/i.exec(text);
    if (match) add(match[1], 'business-summary', 20);
  }
  return matches.sort((left, right) => right.priority - left.priority);
}

function recognizeBusinessMenuStructure(parts = []) {
  const bounded = (Array.isArray(parts) ? parts : [])
    .map(value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180))
    .filter(Boolean)
    .slice(0, 80);
  const combined = bounded.join(' ').slice(0, 1200);
  if (!/\bviewing\s+page\s+as\s*:?/i.test(combined)) return [];
  const match = /\bviewing\s+page\s+as\s*:?\s*(.{1,160}?)\s*\(\s*(\d{1,10})\s*\)/i.exec(combined);
  if (!match) return [];
  const validated = validateCustomerNumber(match[2]);
  const businessName = String(match[1] || '').replace(/^[\s:–—-]+|[\s:–—-]+$/g, '').trim().slice(0, 160);
  if (!validated.valid || !businessName || /^(?:user|profile|account|customer number)$/i.test(businessName)) return [];
  return [{
    number: validated.normalized,
    businessName,
    source: 'viewing-business',
    confidence: 'high',
    priority: 50
  }];
}

function discoverCustomerNumberCandidates(records = []) {
  const candidates = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const matches = recognizeCustomerNumberText(record?.text, {
      businessContext: record?.businessContext === true,
      developerBusinessSelector: record?.developerBusinessSelector === true
    });
    for (const match of matches) {
      const existing = candidates.get(match.number);
      if (!existing || match.priority > existing.priority) candidates.set(match.number, match);
    }
  }
  return [...candidates.values()].sort((left, right) => right.priority - left.priority || left.number.localeCompare(right.number));
}

function maskCustomerNumber(value) {
  const number = validateCustomerNumber(value).normalized;
  if (!number) return '';
  return `${'•'.repeat(Math.max(0, number.length - 4))}${number.slice(-4)}`;
}

function rectanglesIntersect(left, right) {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function calculateCalloutPlacement(targetRect, calloutSize, viewport, interactiveRects = [], gap = 12) {
  const target = {
    left: Number(targetRect?.left) || 0,
    top: Number(targetRect?.top) || 0,
    right: Number(targetRect?.right) || 0,
    bottom: Number(targetRect?.bottom) || 0
  };
  const width = Math.max(1, Number(calloutSize?.width) || 1);
  const height = Math.max(1, Number(calloutSize?.height) || 1);
  const viewportWidth = Math.max(0, Number(viewport?.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport?.height) || 0);
  const margin = 8;
  const sideCandidates = [
    { position: 'right', left: target.right + gap, top: target.top + ((target.bottom - target.top) - height) / 2 },
    { position: 'left', left: target.left - width - gap, top: target.top + ((target.bottom - target.top) - height) / 2 },
    { position: 'above', left: target.left + ((target.right - target.left) - width) / 2, top: target.top - height - gap },
    { position: 'below', left: target.left + ((target.right - target.left) - width) / 2, top: target.bottom + gap }
  ];
  const belowCandidates = [
    sideCandidates[3],
    { position: 'below-left', left: target.left, top: target.bottom + gap },
    { position: 'below-right', left: target.right - width, top: target.bottom + gap }
  ];
  const nearTopEdge = target.top < margin + height + gap;
  const candidates = nearTopEdge
    ? [...belowCandidates, sideCandidates[0], sideCandidates[1], sideCandidates[2]]
    : sideCandidates;
  for (const candidate of candidates) {
    const rect = {
      left: candidate.left,
      top: candidate.top,
      right: candidate.left + width,
      bottom: candidate.top + height
    };
    if (rect.left < margin || rect.top < margin || rect.right > viewportWidth - margin || rect.bottom > viewportHeight - margin) continue;
    if (rectanglesIntersect(rect, target)) continue;
    if ((Array.isArray(interactiveRects) ? interactiveRects : []).some(other => rectanglesIntersect(rect, other))) continue;
    return { position: candidate.position, left: Math.round(candidate.left), top: Math.round(candidate.top) };
  }
  return null;
}

function installSetupOverlay(primary, secondary, callout, requiredTargets = [], options = {}) {
  if (typeof window.__cpcrSetupCleanup === 'function') window.__cpcrSetupCleanup();
  if (!primary || !document.documentElement.contains(primary)) return false;
  const style = document.createElement('style');
  style.setAttribute('data-cpcr-setup-overlay-style', 'true');
  style.textContent = `
    .cpcr-setup-primary { outline: 4px solid #ffb000 !important; outline-offset: 5px !important; box-shadow: 0 0 0 5px rgba(0, 38, 80, .92), 0 0 28px 12px rgba(255, 176, 0, .9) !important; animation: cpcrSetupPulse 1.8s ease-in-out infinite !important; }
    .cpcr-setup-secondary { outline: 2px solid #00a3ff !important; outline-offset: 3px !important; box-shadow: 0 0 0 2px rgba(0, 38, 80, .7) !important; }
    .cpcr-setup-required { outline: 2px solid #00a3ff !important; outline-offset: 3px !important; box-shadow: none !important; }
    .cpcr-setup-evidence { outline: 2px solid #00a3ff !important; outline-offset: 2px !important; box-shadow: none !important; animation: none !important; }
    @keyframes cpcrSetupPulse { 0%, 100% { box-shadow: 0 0 0 5px rgba(0, 38, 80, .92), 0 0 18px 8px rgba(255, 176, 0, .65); } 50% { box-shadow: 0 0 0 7px rgba(0, 38, 80, 1), 0 0 34px 16px rgba(255, 176, 0, 1); } }
    @keyframes cpcrSetupBounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(7px); } }
    @media (prefers-reduced-motion: reduce) { .cpcr-setup-primary, .cpcr-setup-pointer { animation: none !important; } }
  `;
  (document.head || document.documentElement).appendChild(style);
  primary.classList.add('cpcr-setup-primary');
  if (options.targetType === 'evidence') primary.classList.add('cpcr-setup-evidence');
  primary.setAttribute('data-cpcr-setup-highlight', 'primary');
  const secondaryTargets = [...new Set(Array.isArray(secondary) ? secondary : [])].filter(element => element && element !== primary).slice(0, 4);
  for (const element of secondaryTargets) {
    element.classList.add('cpcr-setup-secondary');
    element.setAttribute('data-cpcr-setup-highlight', 'secondary');
  }
  const required = [...new Set(Array.isArray(requiredTargets) ? requiredTargets : [])].filter(Boolean).slice(0, 2);
  for (const element of required) element.classList.add('cpcr-setup-required');
  const requiredBadge = required.length && options.requiredLabel ? document.createElement('div') : null;
  if (requiredBadge) {
    requiredBadge.setAttribute('data-cpcr-setup-overlay', 'true');
    requiredBadge.setAttribute('aria-hidden', 'true');
    requiredBadge.textContent = String(options.requiredLabel).slice(0, 40);
    requiredBadge.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;background:#0067a3;color:#fff;border-radius:3px;padding:3px 6px;font:800 11px/1 system-ui,sans-serif;letter-spacing:.05em;';
    document.documentElement.appendChild(requiredBadge);
  }
  const pointer = document.createElement('div');
  pointer.className = 'cpcr-setup-pointer';
  pointer.setAttribute('data-cpcr-setup-overlay', 'true');
  pointer.setAttribute('aria-hidden', 'true');
  pointer.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#002650;color:#fff;border:3px solid #ffb000;border-radius:7px;padding:9px 13px;font:900 14px/1.1 system-ui,sans-serif;letter-spacing:.06em;box-shadow:0 6px 22px rgba(0,0,0,.5);animation:cpcrSetupBounce 1.8s ease-in-out infinite;max-width:210px;text-align:center;';
  const pointerLabel = document.createElement('span');
  pointerLabel.textContent = String(callout || '').slice(0, 80);
  const pointerArrow = document.createElement('span');
  pointerArrow.textContent = '▶';
  pointerArrow.style.cssText = 'position:absolute;color:#ffb000;font-size:20px;line-height:1;text-shadow:0 2px 2px rgba(0,0,0,.65);';
  pointer.append(pointerLabel, pointerArrow);
  document.documentElement.appendChild(pointer);
  let frame = 0;
  let lastRect = null;
  const reposition = () => {
    if (!document.documentElement.contains(primary) || !document.documentElement.contains(pointer)) return;
    if (!callout) {
      pointer.style.display = 'none';
      return;
    }
    const rect = primary.getBoundingClientRect();
    if (lastRect && Math.max(
      Math.abs(rect.left - lastRect.left), Math.abs(rect.top - lastRect.top),
      Math.abs(rect.width - lastRect.width), Math.abs(rect.height - lastRect.height)
    ) <= 3) return;
    lastRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (requiredBadge && required[0]) {
      const requiredRect = required[0].getBoundingClientRect();
      requiredBadge.style.left = Math.max(6, Math.min(window.innerWidth - 100, requiredRect.left + 6)) + 'px';
      requiredBadge.style.top = Math.max(6, requiredRect.top + 6) + 'px';
    }
    const pointerRect = pointer.getBoundingClientRect();
    const interactiveRects = [...document.querySelectorAll('input, textarea, button, a[href], select, label, [role="button"], [role="link"], [role="radio"], [role="checkbox"]')]
      .filter(element => element !== primary && !element.closest('[data-cpcr-setup-overlay]'))
      .map(element => element.getBoundingClientRect())
      .filter(other => other.width > 0 && other.height > 0)
      .map(other => ({ left: other.left, top: other.top, right: other.right, bottom: other.bottom }));
    const placement = calculateCalloutPlacement(
      { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      { width: pointerRect.width, height: pointerRect.height },
      { width: window.innerWidth, height: window.innerHeight },
      interactiveRects,
      12
    );
    if (!placement) {
      pointer.style.display = 'none';
      return;
    }
    pointer.style.display = 'block';
    pointer.style.left = `${placement.left}px`;
    pointer.style.top = `${placement.top}px`;
    pointerArrow.style.left = 'auto';
    pointerArrow.style.right = 'auto';
    pointerArrow.style.top = 'auto';
    pointerArrow.style.bottom = 'auto';
    if (placement.position === 'right') {
      pointerArrow.textContent = '◀';
      pointerArrow.style.left = '-18px';
      pointerArrow.style.top = 'calc(50% - 10px)';
    } else if (placement.position === 'left') {
      pointerArrow.textContent = '▶';
      pointerArrow.style.right = '-18px';
      pointerArrow.style.top = 'calc(50% - 10px)';
    } else if (placement.position === 'above') {
      pointerArrow.textContent = '▼';
      pointerArrow.style.left = 'calc(50% - 10px)';
      pointerArrow.style.bottom = '-18px';
    } else {
      pointerArrow.textContent = '▲';
      pointerArrow.style.left = 'calc(50% - 10px)';
      pointerArrow.style.top = '-18px';
    }
  };
  const schedule = () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(reposition);
  };
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(schedule) : null;
  observer?.observe(primary);
  const timer = window.setInterval(schedule, 1000);
  window.__cpcrSetupCleanup = () => {
    if (frame) window.cancelAnimationFrame(frame);
    window.clearInterval(timer);
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    observer?.disconnect();
    pointer.remove();
    requiredBadge?.remove();
    style.remove();
    for (const element of [primary, ...secondaryTargets, ...required]) {
      element.classList.remove('cpcr-setup-primary', 'cpcr-setup-secondary', 'cpcr-setup-required', 'cpcr-setup-evidence');
      element.removeAttribute('data-cpcr-setup-highlight');
    }
    delete window.__cpcrSetupCleanup;
  };
  if (window.__cpcrSetupLastPrimary !== primary) primary.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  window.__cpcrSetupLastPrimary = primary;
  schedule();
  return true;
}

function buildPageGuideScript(context = {}) {
  const credentialState = {
    apiKey: context.apiKey === true,
    apiSecret: context.apiSecret === true
  };
  const businessConfirmed = context.businessConfirmed === true;
  const suppressTargets = context.suppressTargets === true;
  const credentialPhase = String(context.credentialPhase || 'copy-key');
  const calloutLabels = Object.freeze({
    signIn: '',
    continue: '',
    accessCode: '',
    securityQuestion: '',
    disconnectSession: '',
    openBusinessMenu: '',
    viewOrganizationSettings: '',
    confirmBusiness: '',
    apps: '',
    createNewApp: '',
    useExistingApp: '',
    selectProduction: '',
    createApp: '',
    copyApiKey: '',
    copyApiSecret: '',
    addApiProduct: '',
    getAccessTracking: '',
    clickAdd: '',
    back: '',
    appName: '',
    required: '',
    ...context.calloutLabels
  });
  return `(() => {
    if (typeof window.__cpcrSetupCleanup === 'function') window.__cpcrSetupCleanup();
    const normalizeAccessibleName = value => String(value || '').normalize('NFKC')
      .replace(/[\uE000-\uF8FF]/g, '').replace(/[▼▽▾⌄⌃▲△▴]/g, '').replace(/\\s+/g, ' ').trim().slice(0, 180);
    const accessibleName = element => {
      const labelledBy = String(element.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
        .map(id => document.getElementById(id)?.textContent || '').join(' ');
      const associatedLabel = [...(element.labels || [])].map(label => label.textContent || '').join(' ');
      const explicitLabel = element.id ? document.querySelector('label[for="' + CSS.escape(element.id) + '"]')?.textContent || '' : '';
      return normalizeAccessibleName(element.getAttribute('aria-label') || labelledBy || associatedLabel || explicitLabel
        || element.textContent || element.getAttribute('name') || element.getAttribute('title') || element.getAttribute('placeholder') || '');
    };
    const roleOf = element => {
      const explicit = String(element.getAttribute('role') || '').toLowerCase();
      if (explicit) return explicit;
      if (element.matches('a[href]')) return 'link';
      if (element.matches('button, input[type="button"], input[type="submit"]')) return 'button';
      if (element.matches('input[type="radio"]')) return 'radio';
      if (element.matches('input:not([type]), input[type="text"], input[type="email"], input[type="password"], textarea')) return 'textbox';
      return '';
    };
    const visible = element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    const viewportVisible = element => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    };
    const structuralOverlays = [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')]
      .filter(element => viewportVisible(element) && /^(?:add api product|ajouter un produit api)$/i.test(normalizeAccessibleName(element.textContent)))
      .map(heading => {
        let candidate = heading.parentElement;
        for (let depth = 0; candidate && depth < 7; depth += 1, candidate = candidate.parentElement) {
          if (!visible(candidate)) continue;
          const controls = [...candidate.querySelectorAll('a[href], button, [role="link"], [role="button"]')].filter(visible);
          const names = controls.map(accessibleName);
          const text = normalizeAccessibleName(candidate.textContent).slice(0, 600);
          const isCatalog = names.some(name => /^get access to /i.test(name));
          const isConfirmation = /[A-Za-z][A-Za-z &'-]{1,80}\\s*\\(?\\s*\\d+\\.\\d+\\.\\d+\\s*\\)?/i.test(text)
            && /default plan|default-plan|plan par d[ée]faut/i.test(text)
            && names.some(name => /^add$|^ajouter$/i.test(name))
            && names.some(name => /^back$|^retour$/i.test(name));
          if (controls.length >= 2 && (isCatalog || isConfirmation) && String(candidate.textContent || '').length <= 12000) return candidate;
        }
        return null;
      }).filter(Boolean);
    const visibleDialogs = [...new Set([
      ...document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"]'),
      ...structuralOverlays
    ])]
      .filter(viewportVisible)
      .sort((left, right) => (Number.parseInt(window.getComputedStyle(left).zIndex, 10) || 0) - (Number.parseInt(window.getComputedStyle(right).zIndex, 10) || 0));
    const activeDialog = visibleDialogs.at(-1) || null;
    const normalizeAccessibleControlName = ${normalizeAccessibleControlName.toString()};
    const isSafeCurrentBusinessLink = ${isSafeCurrentBusinessLink.toString()};
    const resolveAuthenticatedHeaderOrganizationControl = ${resolveAuthenticatedHeaderOrganizationControl.toString()};
    const describeKnownOrganizationControl = ${describeKnownOrganizationControl.toString()};
    const knownOrganizationSection = document.querySelector('section[aria-label="Consumer organization Selection"]')
      || document.querySelector('section[id^="block-consumerorganizationselection-"][aria-label*="organization" i]');
    const knownBusinessLink = knownOrganizationSection?.querySelector(
      '.consumerorgSelectBlock li.dropit-trigger > a[title^="Current organization:"]'
    ) || null;
    const knownBusinessTrigger = knownBusinessLink?.closest('li.dropit-trigger') || null;
    const knownBusinessSubmenu = knownBusinessTrigger?.querySelector(':scope > ul.dropitmenu-submenu, :scope > ul.dropit-submenu') || null;
    const knownBusinessDescription = knownBusinessLink ? describeKnownOrganizationControl({
      currentOrgText: knownBusinessLink.querySelector('.currentOrg')?.textContent || '',
      title: knownBusinessLink.getAttribute('title') || '',
      accessibleName: accessibleName(knownBusinessLink),
      ariaExpanded: knownBusinessTrigger?.getAttribute('aria-expanded') || '',
      submenuVisible: Boolean(knownBusinessSubmenu && visible(knownBusinessSubmenu))
    }) : null;
    const elements = [...document.querySelectorAll('button, a[href], input, textarea, [role="button"], [role="link"], [role="radio"], [role="textbox"], [role="option"], [role="menuitem"], [role="row"], [class*="business" i], [class*="account-selector" i], label')]
      .filter(element => !element.closest('script, style, noscript') && visible(element)
        && (activeDialog?.contains(element) || viewportVisible(element)));
    const entries = elements.map(element => {
      const name = accessibleName(element);
      const descendantIdentity = [...element.querySelectorAll('[class], [id], [data-icon], [aria-label], [title]')].slice(0, 12)
        .map(item => [item.id, item.className, item.getAttribute('data-icon'), item.getAttribute('aria-label'), item.getAttribute('title')].join(' ')).join(' ');
      const identity = [element.id, element.className, element.getAttribute('data-testid'), element.getAttribute('aria-label'), element.getAttribute('aria-controls'), descendantIdentity].join(' ');
      const inDeveloperHeader = element.closest('header, nav, [role="banner"]') !== null;
      const businessIdentity = /business|company|customer|organization|organisation|entreprise|account-selector|switch-account/i.test(identity);
      const menuButton = element.matches('button, [role="button"], [aria-haspopup="menu"], [aria-haspopup="listbox"]');
      const href = String(element.getAttribute('href') || '').trim();
      const rawName = String(element.getAttribute('aria-label') || element.textContent || '');
      const currentBusinessLink = isSafeCurrentBusinessLink({
        role: roleOf(element), name, href, identity, inAuthenticatedHeader: inDeveloperHeader,
        currentIndicator: menuButton || businessIdentity || /[\uE000-\uF8FF]/.test(rawName)
      }, location.href);
      const currentBusinessHeaderLink = roleOf(element) === 'link' && inDeveloperHeader
        && (menuButton || /[\uE000-\uF8FF]|[▼▽▾⌄⌃▲△▴]/.test(rawName))
        && !/user menu|sign in|profile|my account|language|help|search|view organization settings|register|delete|switch|another organization/i.test(identity + ' ' + name);
      const authenticatedProfile = inDeveloperHeader && /profile|my account|signed in|mon compte|profil|avatar|(?:^|[\s_-])user(?:$|[\s_-])|(?:^|[\s_-])person(?:$|[\s_-])/i.test(identity + ' ' + name);
      const dropdown = menuButton || element.hasAttribute('aria-expanded')
        || /[\uE000-\uF8FF]|[▼▽▾⌄⌃▲△▴]/.test(rawName) || /caret|chevron|dropdown/i.test(identity);
      return {
        element,
        role: roleOf(element),
        name,
        identity,
        kind: String(element.getAttribute('type') || '').toLowerCase(),
        semantic: authenticatedProfile
          ? 'authenticated-profile'
          : (businessIdentity || currentBusinessLink || currentBusinessHeaderLink || (inDeveloperHeader && menuButton && !/user menu|sign in|language|help|search|profile/i.test(name)) ? 'business-selector' : ''),
        inActiveDialog: Boolean(activeDialog && activeDialog.contains(element)),
        inDeveloperHeader,
        dropdown,
        organizationEvidence: businessIdentity || /building|briefcase|office|company|organisation/i.test(identity),
        profileEvidence: authenticatedProfile,
        languageEvidence: /^(?:fr|en)$/i.test(name) || /language|langue/i.test(identity),
        safeBusinessMenuToggle: dropdown || currentBusinessLink || currentBusinessHeaderLink,
        checked: element.checked === true
      };
    }).filter(entry => entry.name);
    const knownBusinessEntry = knownBusinessLink ? entries.find(entry => entry.element === knownBusinessLink) || null : null;
    if (knownBusinessEntry) {
      knownBusinessEntry.semantic = 'business-selector';
      knownBusinessEntry.safeBusinessMenuToggle = true;
      knownBusinessEntry.structuralBusinessTarget = true;
      knownBusinessEntry.knownOrganizationTarget = true;
      knownBusinessEntry.businessMenuOpen = knownBusinessDescription?.open === true;
    }
    const structuralHeaderTarget = knownBusinessLink ? null : resolveAuthenticatedHeaderOrganizationControl(entries.map((entry, index) => ({
      role: entry.role,
      name: entry.name,
      identity: entry.identity,
      inHeader: entry.inDeveloperHeader,
      visible: visible(entry.element),
      viewportPresent: viewportVisible(entry.element),
      dropdown: entry.dropdown,
      organizationEvidence: entry.organizationEvidence,
      profileEvidence: entry.profileEvidence,
      languageEvidence: entry.languageEvidence,
      order: index
    })));
    if (!knownBusinessLink && structuralHeaderTarget) {
      const organizationEntry = entries[structuralHeaderTarget.controlIndex];
      const profileEntry = entries[structuralHeaderTarget.profileControlIndex];
      organizationEntry.semantic = 'business-selector';
      organizationEntry.safeBusinessMenuToggle = true;
      organizationEntry.structuralBusinessTarget = true;
      profileEntry.semantic = 'authenticated-profile';
    }
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, [role="heading"], dt, legend')];
    const safeText = headings
      .map(element => String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240)).filter(Boolean).slice(0, 80);
    const productHeading = headings.find(element => /^(?:api products|produits api)$/i.test(String(element.textContent || '').replace(/\\s+/g, ' ').trim()));
    const productSection = productHeading?.closest('section, article, [role="region"]') || productHeading?.parentElement;
    if (productSection) {
      safeText.push(...[...productSection.querySelectorAll('p, li, [role="status"]')]
        .map(element => String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240))
        .filter(text => /tracking|rep[ée]rage|api product|produit api|enabled|active|access|acc[èe]s/i.test(text)).slice(0, 20));
    }
    const dialogs = (activeDialog ? [activeDialog] : [])
      .map(element => [
        element.getAttribute('aria-label') || '',
        element.querySelector('h1, h2, h3, [role="heading"]')?.textContent || '',
        ...[...element.querySelectorAll('button, a[href], [role="button"], [role="link"]')].map(accessibleName),
        ...[...element.querySelectorAll('[role="row"], [role="option"], label, tr, th, td, p, span, div')]
          .map(item => String(item.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(item => /tracking|rep[ée]rage|default[ -]plan|plan par d[ée]faut|add api product|ajouter un produit api/i.test(item))
          .slice(0, 40)
      ].join(' ').replace(/\\s+/g, ' ').trim().slice(0, 600));
    const statusText = [...document.querySelectorAll('[role="alert"], [role="status"], .alert, [class*="success" i], [class*="notification" i]')]
      .filter(element => visible(element) && !element.closest('[data-cpcr-setup-overlay]'))
      .map(element => String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600))
      .filter(item => /api product added|produit api ajout[ée]|tracking\\s*\\(?\\s*2\\.0\\.0|rep[ée]rage\\s*\\(?\\s*2\\.0\\.0/i.test(item)).slice(0, 30);
    const apiProductText = productSection
      ? [...productSection.querySelectorAll('tr, li, [role="row"], [class*="product" i]')]
        .filter(visible)
        .map(element => String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600))
        .filter(text => /[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ &'-]{1,100}\\s*\\(?\\s*\\d+\\.\\d+\\.\\d+\\s*\\)?/i.test(text)).slice(0, 30)
      : [];
    const recognize = ${recognizeCustomerNumberText.toString()};
    const validateCustomerNumber = value => { const input = String(value || '').trim(); return { valid: /^\\d{1,10}$/.test(input), normalized: input.padStart(10, '0') }; };
    const byNumber = new Map();
    const recognizeBusinessMenu = ${recognizeBusinessMenuStructure.toString()};
    const boundedAncestor = (start, preferredSelector, predicate) => {
      const preferred = start.closest(preferredSelector);
      if (preferred && visible(preferred) && String(preferred.textContent || '').length <= 2400 && predicate(preferred)) return preferred;
      let candidate = start.parentElement;
      for (let depth = 0; candidate && depth < 5; depth += 1, candidate = candidate.parentElement) {
        if (!visible(candidate)) continue;
        const text = String(candidate.textContent || '');
        if (text.length > 2400) break;
        if (predicate(candidate)) return candidate;
      }
      return null;
    };
    for (const entry of entries) {
      const identity = [entry.element.id, entry.element.className, entry.element.getAttribute('data-testid'), entry.element.getAttribute('aria-label')].join(' ');
      const developerBusinessSelector = /business|company|customer|account|organization|organisation|entreprise/i.test(identity)
        || entry.element.closest('[aria-label*="business" i], [aria-label*="account" i], [data-testid*="business" i], [class*="business" i], [class*="account-selector" i]') !== null;
      for (const match of recognize(entry.name, { developerBusinessSelector, businessContext: developerBusinessSelector })) {
        if (match.source === 'business-summary' && entry.element.closest('nav, header')) continue;
        const existing = byNumber.get(match.number);
        if (!existing || match.priority > existing.priority) byNumber.set(match.number, { ...match, element: entry.element });
      }
    }
    const organizationSettingsLinks = entries
      .filter(entry => entry.role === 'link' && /^view organization settings$|^voir les param[èe]tres de l['’]organisation$/i.test(entry.name));
    const viewingLabels = [...document.querySelectorAll('span, p, div, strong, small, [role="heading"]')]
      .filter(element => {
        if (!viewportVisible(element)) return false;
        const directText = [...element.childNodes]
          .filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent || '').join(' ').replace(/\\s+/g, ' ').trim();
        const boundedText = directText || (![...element.children].length ? String(element.textContent || '').replace(/\\s+/g, ' ').trim() : '');
        return /^viewing\\s+page\\s+as\\s*:?$/i.test(boundedText);
      });
    const businessContainerAnchors = [...viewingLabels, ...organizationSettingsLinks.map(entry => entry.element)];
    const businessContainers = [...new Set(businessContainerAnchors.map(anchor => boundedAncestor(
      anchor,
      '[role="menu"], [role="listbox"], [class*="popover" i], [class*="dropdown" i], [class*="business" i], [class*="account-menu" i]',
      container => /viewing\\s+page\\s+as/i.test(String(container.textContent || ''))
        && /\\(\\s*\\d{1,10}\\s*\\)/.test(String(container.textContent || ''))
    )).filter(Boolean))];
    for (const container of businessContainers) {
      const parts = [...container.querySelectorAll('span, p, div, strong, small, [role="heading"], [role="menuitem"]')]
        .filter(element => visible(element) && ![...element.children].some(child => visible(child)))
        .map(element => String(element.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 80);
      if (!parts.length) parts.push(String(container.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600));
      for (const match of recognizeBusinessMenu(parts)) {
        const existing = byNumber.get(match.number);
        if (!existing || match.priority > existing.priority) byNumber.set(match.number, { ...match, element: container });
      }
    }
    const customerLabels = [...document.querySelectorAll('label, dt, [role="term"], strong, span, p, div, h1, h2, h3, h4')]
      .filter(element => viewportVisible(element) && /^(?:customer\\s*(?:number|no\\.?|#)|num[ée]ro\\s+de\\s+client)\\s*:?$/i.test(String(element.textContent || '').replace(/\\s+/g, ' ').trim()));
    for (const label of customerLabels.slice(0, 8)) {
      const container = boundedAncestor(
        label,
        '.field, .form-item, dl, section, article, [role="group"]',
        candidate => /\\b\\d{1,10}\\b/.test(String(candidate.textContent || ''))
      ) || label.parentElement;
      const text = String(container?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
      for (const match of recognize(text, {})) {
        const createAppPage = /create new app|cr[ée]er une nouvelle application/i.test(safeText.join(' '));
        const namedBusinessSelectors = entries.filter(entry => entry.semantic === 'business-selector' && !entry.inActiveDialog);
        const businessName = namedBusinessSelectors.length === 1 ? namedBusinessSelectors[0].name : '';
        const candidate = {
          ...match,
          businessName: match.businessName || businessName,
          source: createAppPage ? 'create-app-customer-label' : 'organization-settings-customer-label',
          priority: createAppPage ? 60 : 80,
          element: container || label
        };
        const existing = byNumber.get(candidate.number);
        if (!existing || candidate.priority > existing.priority) byNumber.set(candidate.number, candidate);
      }
    }
    const businesses = [...byNumber.values()].sort((left, right) => right.priority - left.priority || left.number.localeCompare(right.number)).slice(0, 8);
    const PAGE_STATES = ${JSON.stringify(PAGE_STATES)};
    const STATE_TO_STEP = ${JSON.stringify(STATE_TO_STEP)};
    const recognizeApiProductConfirmation = ${recognizeApiProductConfirmation.toString()};
    const recognizeAssignedApiProducts = ${recognizeAssignedApiProducts.toString()};
    const classify = ${classifySetupSignals.toString()};
    const normalizedSemanticControls = ${normalizedSemanticControls.toString()};
    const appNameEntry = entries.find(entry => entry.role === 'textbox' && /^app name$|^nom de l['’]application$/i.test(entry.name));
    const productionEntry = entries.find(entry => entry.role === 'radio' && /^production$/i.test(entry.name));
    const testEntry = entries.find(entry => entry.role === 'radio' && /^test$/i.test(entry.name));
    const appName = appNameEntry ? String(appNameEntry.element.value || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : '';
    const classifiedState = classify({
      pathname: location.pathname,
      controls: entries.map(entry => ({ role: entry.role, name: entry.name, kind: entry.kind, semantic: entry.semantic, inActiveDialog: entry.inActiveDialog, checked: entry.checked })),
      dialogControls: entries.filter(entry => entry.inActiveDialog).map(entry => ({ role: entry.role, name: entry.name, kind: entry.kind, semantic: entry.semantic, inActiveDialog: true, checked: entry.checked })),
      text: safeText,
      dialogs,
      statusText,
      apiProductText,
      createApp: {
        productionSelected: productionEntry?.checked === true,
        testSelected: testEntry?.checked === true,
        appNamePresent: Boolean(appName)
      },
      businesses: businesses.map(candidate => ({ number: candidate.number, businessName: candidate.businessName }))
    });
    let state = classifiedState === 'BUSINESS_CONFIRMED' && !${JSON.stringify(businessConfirmed)} ? 'BUSINESS_SELECTION' : classifiedState;
    if (knownBusinessDescription?.open === true && state === 'BUSINESS_MENU_REQUIRED') state = 'BUSINESS_SELECTION';
    const eligibleEntries = activeDialog ? entries.filter(entry => entry.inActiveDialog) : entries;
    const exact = (role, expression) => eligibleEntries.find(entry => (!role || entry.role === role) && expression.test(entry.name));
    const all = (role, expression) => eligibleEntries.filter(entry => (!role || entry.role === role) && expression.test(entry.name)).map(entry => entry.element);
    let primaryEntry = null;
    let secondary = [];
    let required = [];
    let trackingProductName = '';
    const callouts = ${JSON.stringify(calloutLabels)};
    let callout = '';
    const businessSelectors = entries.filter(entry => entry.semantic === 'business-selector' && !entry.inActiveDialog);
    const structuralBusinessControls = businessSelectors.filter(entry => entry.structuralBusinessTarget === true);
    const preferredBusinessControls = knownBusinessEntry
      ? (knownBusinessDescription?.open === true ? [] : [knownBusinessEntry])
      : (structuralBusinessControls.length === 1 ? structuralBusinessControls : businessSelectors);
    const currentBusinessControls = preferredBusinessControls.filter(entry => (knownBusinessEntry ? true : entry.inDeveloperHeader)
      && entry.safeBusinessMenuToggle
      && (entry.role === 'link' || entry.role === 'button'));
    if (state === 'DEV_PORTAL_SIGNED_OUT') {
      primaryEntry = exact('link', /^sign in$/i) || exact('', /^sign in$/i);
      secondary = all('', /^user menu$/i);
      callout = callouts.signIn;
    } else if (state === 'LOGIN_PAGE') {
      primaryEntry = exact('button', /^sign in$/i);
      secondary = [...all('textbox', /^username$/i), ...all('textbox', /^password$/i)];
      callout = callouts.signIn;
    } else if (state === 'IDENTITY_METHOD_SELECTION' || state === 'IDENTITY_CHALLENGE' || state === 'MFA_INTRO' || state === 'LOGIN_SUBMITTED') {
      primaryEntry = exact('button', /^continue$/i);
      callout = callouts.continue;
    } else if (state === 'SECURITY_QUESTION') {
      primaryEntry = entries.find(entry => entry.role === 'textbox' && !/^username$|^password$|^access code$/i.test(entry.name)) || exact('button', /^continue$/i);
      secondary = all('button', /^continue$/i);
      callout = callouts.securityQuestion;
    } else if (state === 'MFA_CODE') {
      primaryEntry = exact('textbox', /^access code$/i);
      secondary = all('button', /^continue$/i);
      callout = callouts.accessCode;
    } else if (state === 'SESSION_LIMIT') {
      primaryEntry = exact('button', /^disconnect session$/i);
      secondary = all('radio', /.+/i);
      callout = callouts.disconnectSession;
    } else if (state === 'BUSINESS_MENU_REQUIRED' || state === 'BUSINESS_SELECTION' || state === 'DEV_PORTAL_AUTHENTICATED') {
      primaryEntry = businesses[0]
        ? null
        : (organizationSettingsLinks.length === 1
          ? organizationSettingsLinks[0]
          : (currentBusinessControls.length === 1 ? currentBusinessControls[0] : null));
      callout = businesses.length
        ? callouts.confirmBusiness
        : (primaryEntry === organizationSettingsLinks[0] ? callouts.viewOrganizationSettings : callouts.openBusinessMenu);
    } else if (state === 'BUSINESS_CONFIRMED') {
      primaryEntry = exact('link', /^apps$/i) || exact('', /^apps$/i);
      callout = callouts.apps;
    } else if (state === 'APPS_PAGE') {
      primaryEntry = entries.find(entry => /production/i.test(entry.name) && /app|claim runner/i.test(entry.name)) || exact('link', /^create new app$/i) || exact('', /^create new app$/i);
      secondary = all('', /^create new app$/i);
      callout = primaryEntry && /^create new app$/i.test(primaryEntry.name || '') ? callouts.createNewApp : callouts.useExistingApp;
    } else if (state === 'CREATE_APP' || state === 'CREATE_APP_SELECT_PRODUCTION' || state === 'CREATE_APP_TEST_SELECTED') {
      const production = exact('radio', /^production$/i) || exact('', /^production$/i);
      primaryEntry = production;
      callout = callouts.selectProduction;
    } else if (state === 'CREATE_APP_ENTER_NAME') {
      primaryEntry = appNameEntry || exact('textbox', /^app name$/i);
      callout = callouts.appName;
    } else if (state === 'CREATE_APP_READY') {
      primaryEntry = exact('button', /^create$/i);
      secondary = appNameEntry ? [appNameEntry.element] : [];
      callout = callouts.createApp;
    } else if (state === 'CREDENTIALS_GENERATED') {
      if (${JSON.stringify(credentialPhase)} === 'paste-key' || ${JSON.stringify(credentialPhase)} === 'paste-secret') {
        primaryEntry = null;
        callout = '';
      } else if (!${JSON.stringify(credentialState.apiKey)}) {
        primaryEntry = exact('button', /^copy api key$/i);
        callout = callouts.copyApiKey;
      } else if (!${JSON.stringify(credentialState.apiSecret)}) {
        primaryEntry = exact('button', /^copy api secret$/i);
        callout = callouts.copyApiSecret;
      } else {
        primaryEntry = exact('', /^ok$/i);
        callout = callouts.continue;
      }
    } else if (state === 'API_PRODUCTS' || state === 'APP_DASHBOARD' || state === 'TRACKING_REQUIRED_AFTER_WRONG_PRODUCT') {
      primaryEntry = exact('', /^add api product$/i);
      callout = callouts.addApiProduct;
    } else if (state === 'API_PRODUCT_CATALOG') {
      const trackingAccess = eligibleEntries.filter(entry => entry.role === 'link' && /^get access to tracking$/i.test(entry.name));
      if (trackingAccess.length === 1) {
        primaryEntry = trackingAccess[0];
        let card = primaryEntry.element.closest('article, li, [role="group"], [role="listitem"], [class*="card" i], [class*="product" i]');
        if (!card) {
          let candidate = primaryEntry.element.parentElement;
          for (let depth = 0; candidate && depth < 6; depth += 1, candidate = candidate.parentElement) {
            const candidateText = String(candidate.textContent || '').replace(/\\s+/g, ' ').trim();
            if (candidateText.length > 2400) break;
            if (/\\btracking\\b/i.test(candidateText) && candidate.contains(primaryEntry.element)) {
              card = candidate;
              break;
            }
          }
        }
        const cardText = String(card?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
        if (!card || !/\\btracking\\b/i.test(cardText)) primaryEntry = null;
        if (primaryEntry) {
          secondary = card ? [card] : [];
          required = secondary;
          trackingProductName = /tracking\\s*\\(?\\s*\\d+(?:\\.\\d+){1,2}\\s*\\)?/i.exec(cardText)?.[0] || '';
          primaryEntry.element.scrollIntoView({ block: 'center', inline: 'nearest' });
          const targetRect = primaryEntry.element.getBoundingClientRect();
          const ownerRect = activeDialog?.getBoundingClientRect();
          const insideOwnerViewport = !ownerRect || (targetRect.bottom > ownerRect.top && targetRect.top < ownerRect.bottom
            && targetRect.right > ownerRect.left && targetRect.left < ownerRect.right);
          if (!primaryEntry.element.isConnected || !visible(primaryEntry.element) || !insideOwnerViewport) primaryEntry = null;
        }
      }
      callout = callouts.getAccessTracking;
    } else if (state === 'TRACKING_PRODUCT_CONFIRMATION') {
      const addLinks = eligibleEntries.filter(entry => entry.role === 'link' && /^add$/i.test(entry.name));
      primaryEntry = addLinks.length === 1 ? addLinks[0] : null;
      const tracking = eligibleEntries.filter(entry => /tracking\\s*\\(?\\s*\\d+(?:\\.\\d+){1,2}\\s*\\)?/i.test(entry.name));
      const structuralTracking = activeDialog ? [...activeDialog.querySelectorAll('tr, [role="row"], div, p, span')]
        .filter(element => visible(element)
          && /tracking\\s*\\(?\\s*\\d+(?:\\.\\d+){1,2}\\s*\\)?/i.test(normalizeAccessibleName(element.textContent))
          && ![...element.children].some(child => visible(child)
            && /tracking\\s*\\(?\\s*\\d+(?:\\.\\d+){1,2}\\s*\\)?/i.test(normalizeAccessibleName(child.textContent))))
        .slice(0, 4) : [];
      secondary = [...new Set([...tracking.map(entry => entry.element), ...structuralTracking])];
      required = secondary;
      trackingProductName = tracking[0]?.name
        || /tracking\\s*\\(?\\s*\\d+(?:\\.\\d+){1,2}\\s*\\)?/i.exec(dialogs.join(' '))?.[0] || '';
      callout = callouts.clickAdd;
    } else if (state === 'WRONG_API_PRODUCT') {
      const backLinks = eligibleEntries.filter(entry => /^(?:back|retour)$/i.test(entry.name));
      primaryEntry = backLinks.length === 1 ? backLinks[0] : null;
      callout = callouts.back;
    }
    if (${JSON.stringify(suppressTargets)}) {
      primaryEntry = null;
      secondary = [];
      required = [];
      callout = '';
    }
    const selectedProduct = recognizeApiProductConfirmation(dialogs.join(' '));
    const overlayIds = window.__cpcrSetupOverlayIds instanceof WeakMap ? window.__cpcrSetupOverlayIds : new WeakMap();
    window.__cpcrSetupOverlayIds = overlayIds;
    window.__cpcrSetupOverlaySequence = Number(window.__cpcrSetupOverlaySequence || 0);
    let overlayInstanceId = '';
    if (activeDialog && selectedProduct) {
      if (!overlayIds.has(activeDialog)) overlayIds.set(activeDialog, ++window.__cpcrSetupOverlaySequence);
      overlayInstanceId = 'overlay-' + overlayIds.get(activeDialog);
    }
    const installedWrongProduct = recognizeAssignedApiProducts(apiProductText.join('\\n')).find(product => !/^tracking$/i.test(product.productName));
    const contextualProduct = selectedProduct || (state === 'TRACKING_REQUIRED_AFTER_WRONG_PRODUCT' ? installedWrongProduct : null);
    const primary = primaryEntry?.element || null;
    const currentBusinessTarget = state === 'BUSINESS_MENU_REQUIRED'
      && currentBusinessControls.length === 1
      && primaryEntry === currentBusinessControls[0];
    let overlayInstalled = false;
    if (primary) {
      const rectanglesIntersect = ${rectanglesIntersect.toString()};
      const calculateCalloutPlacement = ${calculateCalloutPlacement.toString()};
      const install = ${installSetupOverlay.toString()};
      overlayInstalled = install(primary, secondary, callout, required, { targetType: 'action', requiredLabel: callouts.required }) === true;
    }
    const publishedState = ['DEV_PORTAL_AUTHENTICATED', 'BUSINESS_MENU_REQUIRED'].includes(state)
      && (!currentBusinessTarget || !overlayInstalled)
      ? 'BUSINESS_TARGET_RESOLVING'
      : state;
    const knownRect = knownBusinessLink?.getBoundingClientRect();
    const businessTargetDiagnostic = 'primary-selector=' + Boolean(knownBusinessLink)
      + ' visible=' + Boolean(knownBusinessLink && viewportVisible(knownBusinessLink))
      + ' open=' + Boolean(knownBusinessDescription?.open)
      + ' rect=' + (knownRect
        ? [knownRect.left, knownRect.top, knownRect.width, knownRect.height].map(value => Math.round(value)).join(',')
        : 'none');
    if (publishedState === 'BUSINESS_TARGET_RESOLVING'
        && window.__cpcrSetupLastBusinessDiagnostic !== businessTargetDiagnostic) {
      window.__cpcrSetupLastBusinessDiagnostic = businessTargetDiagnostic;
      console.info('[Claim Runner Guided Setup] ' + businessTargetDiagnostic);
    } else if (publishedState === 'BUSINESS_MENU_REQUIRED') {
      delete window.__cpcrSetupLastBusinessDiagnostic;
    }
    return {
      found: overlayInstalled,
      pageState: publishedState,
      visibleStepId: STATE_TO_STEP[publishedState] || '',
      targetKey: currentBusinessTarget ? 'current-business-control' : callout.toLowerCase().replace(/\\s+/g, '-'),
      primaryTarget: overlayInstalled,
      animatedCallout: overlayInstalled,
      targetResolved: currentBusinessTarget,
      overlayInstalled,
      primarySelectorMatched: Boolean(knownBusinessLink),
      businessTargetDiagnostic,
      targetSurface: overlayInstalled ? 'browser' : 'none',
      targetRole: currentBusinessTarget ? 'currentBusinessControl' : '',
      targetElementRole: primaryEntry?.role || '',
      targetElementTag: primary ? String(primary.tagName || '').toLowerCase() : '',
      targetType: primary ? 'action' : (businesses.length ? 'evidence' : 'none'),
      autoExpandedBusinessMenu: false,
      businessSelectorName: knownBusinessDescription?.businessName
        || (currentBusinessControls.length === 1 ? currentBusinessControls[0].name : ''),
      businessSettingsTarget: Boolean(primaryEntry && primaryEntry === organizationSettingsLinks[0]),
      trackingProductName,
      selectedProductName: contextualProduct?.productName || '',
      selectedProductVersion: contextualProduct?.version || '',
      selectedPlanName: selectedProduct?.planName || '',
      overlayInstanceId,
      appName,
      candidates: businesses.map(candidate => ({ number: candidate.number, businessName: candidate.businessName, source: candidate.source }))
    };
  })()`;
}

function buildHighlightScript(stepOrContext) {
  const context = typeof stepOrContext === 'object' && stepOrContext !== null ? stepOrContext : {};
  return buildPageGuideScript(context);
}

function buildCustomerDiscoveryScript() {
  return buildPageGuideScript({});
}

function buildDomObserverScript() {
  return `(() => {
    if (window.__cpcrSetupDomObserver) return true;
    const sentinel = '__CPCR_SETUP_DOM_CHANGED__';
    let timer = 0;
    const belongsToOverlay = node => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      return Boolean(element?.closest?.('[data-cpcr-setup-overlay], [data-cpcr-setup-overlay-style], [data-cpcr-setup-highlight]'));
    };
    const meaningful = mutation => {
      if (belongsToOverlay(mutation.target)) return false;
      if (mutation.type === 'attributes' && mutation.attributeName === 'class'
          && /cpcr-setup/i.test(String(mutation.oldValue || '') + ' ' + String(mutation.target?.className || ''))) return false;
      if (mutation.type === 'attributes') return true;
      if (mutation.type === 'characterData') return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(node => !belongsToOverlay(node));
    };
    const observer = new MutationObserver(mutations => {
      if (!mutations.some(meaningful)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => console.debug(sentinel), 80);
    });
    const controlName = element => String(element?.getAttribute?.('aria-label') || element?.textContent || '')
      .replace(/[\uE000-\uF8FF]/g, '').replace(/[▼▽▾⌄⌃▲△▴]/g, '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    const clickListener = event => {
      const control = event.target?.closest?.('button, a[href], [role="button"], [role="link"]');
      const name = controlName(control);
      if (/^copy api key$/i.test(name)) console.debug('__CPCR_SETUP_ACTION__:COPY_API_KEY');
      else if (/^copy api secret$/i.test(name)) console.debug('__CPCR_SETUP_ACTION__:COPY_API_SECRET');
      else if (/^get access to /i.test(name)) console.debug('__CPCR_SETUP_ACTION__:PRODUCT_ACCESS');
      else if (/^(?:back|retour)$/i.test(name)) console.debug('__CPCR_SETUP_ACTION__:PRODUCT_BACK');
    };
    const formListener = event => {
      const control = event.target;
      const name = controlName(control) || controlName(control?.labels?.[0]);
      if (/^(?:app name|production|test)$/i.test(name)) console.debug(sentinel);
    };
    document.addEventListener('click', clickListener, true);
    document.addEventListener('input', formListener, true);
    document.addEventListener('change', formListener, true);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['aria-expanded', 'aria-hidden', 'open', 'hidden', 'class', 'role']
    });
    window.__cpcrSetupDomObserver = observer;
    window.__cpcrSetupDomObserverCleanup = () => {
      window.clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('click', clickListener, true);
      document.removeEventListener('input', formListener, true);
      document.removeEventListener('change', formListener, true);
      delete window.__cpcrSetupDomObserver;
      delete window.__cpcrSetupDomObserverCleanup;
    };
    return true;
  })()`;
}

function buildClearHighlightScript() {
  return `(() => {
    if (typeof window.__cpcrSetupDomObserverCleanup === 'function') window.__cpcrSetupDomObserverCleanup();
    if (typeof window.__cpcrSetupCleanup === 'function') window.__cpcrSetupCleanup();
    document.querySelectorAll('[data-cpcr-setup-highlight]').forEach(element => {
      element.classList.remove('cpcr-setup-primary', 'cpcr-setup-secondary', 'cpcr-setup-required');
      element.removeAttribute('data-cpcr-setup-highlight');
    });
    document.querySelectorAll('[data-cpcr-setup-overlay], [data-cpcr-setup-overlay-style]').forEach(element => element.remove());
    return true;
  })()`;
}

function guidanceTarget(pageState, context = {}) {
  const labelKey = {
    [PAGE_STATES.DEV_PORTAL_SIGNED_OUT]: 'signIn',
    [PAGE_STATES.LOGIN_PAGE]: 'signIn',
    [PAGE_STATES.IDENTITY_METHOD_SELECTION]: 'continue',
    [PAGE_STATES.IDENTITY_CHALLENGE]: 'continue',
    [PAGE_STATES.SECURITY_QUESTION]: 'securityQuestion',
    [PAGE_STATES.MFA_INTRO]: 'continue',
    [PAGE_STATES.MFA_CODE]: 'accessCode',
    [PAGE_STATES.SESSION_LIMIT]: 'disconnectSession',
    [PAGE_STATES.BUSINESS_MENU_REQUIRED]: 'openBusinessMenu',
    [PAGE_STATES.BUSINESS_SELECTION]: context.customerCandidate === true ? 'confirmBusiness' : 'openBusinessMenu',
    [PAGE_STATES.BUSINESS_CONFIRMED]: 'apps',
    [PAGE_STATES.APPS_PAGE]: 'createNewApp',
    [PAGE_STATES.CREATE_APP]: 'selectProduction',
    [PAGE_STATES.CREATE_APP_SELECT_PRODUCTION]: 'selectProduction',
    [PAGE_STATES.CREATE_APP_TEST_SELECTED]: 'selectProduction',
    [PAGE_STATES.CREATE_APP_ENTER_NAME]: 'appName',
    [PAGE_STATES.CREATE_APP_READY]: 'createApp',
    [PAGE_STATES.CREDENTIALS_GENERATED]: context.apiKey !== true ? 'copyApiKey' : (context.apiSecret !== true ? 'copyApiSecret' : 'continue'),
    [PAGE_STATES.API_PRODUCTS]: 'addApiProduct',
    [PAGE_STATES.API_PRODUCT_CATALOG]: 'getAccessTracking',
    [PAGE_STATES.TRACKING_PRODUCT_CONFIRMATION]: 'clickAdd',
    [PAGE_STATES.WRONG_API_PRODUCT]: 'back',
    [PAGE_STATES.TRACKING_REQUIRED_AFTER_WRONG_PRODUCT]: 'addApiProduct'
  }[String(pageState || '')];
  return { callout: String(context.calloutLabels?.[labelKey] || ''), key: String(pageState || '').toLowerCase(), primarySelectors: [], primaryText: [], secondarySelectors: [] };
}

function completionSummary(values = {}, stored = {}) {
  const customer = validateCustomerNumber(values.customerNumber);
  const clientId = String(values.trackingClientId || '').trim();
  const clientSecret = String(values.trackingClientSecret || '');
  const environmentChanged = Boolean(stored.trackingApiEnvironment)
    && String(values.trackingApiEnvironment || '') !== stored.trackingApiEnvironment;
  const replacingTrackingCredentials = Boolean(clientId || clientSecret || environmentChanged);
  return Object.freeze({
    webUsername: Boolean(String(values.webUsername || '').trim()),
    webPassword: Boolean(values.webPassword)
      || (stored.webPassword === true && (!stored.webUsername || String(values.webUsername || '').trim() === stored.webUsername)),
    customerNumber: customer.valid,
    trackingClientId: replacingTrackingCredentials ? Boolean(clientId) : stored.trackingClientId === true,
    trackingClientSecret: replacingTrackingCredentials ? Boolean(clientSecret) : stored.trackingClientSecret === true,
    trackingProduct: values.trackingProductEnabled === true
  });
}

function completionReady(summary = {}) {
  return ['webUsername', 'webPassword', 'customerNumber', 'trackingClientId', 'trackingClientSecret', 'trackingProduct']
    .every(key => summary[key] === true);
}

function redactSensitiveText(value, secrets = []) {
  let text = String(value || '');
  for (const secret of secrets) {
    if (secret) text = text.split(String(secret)).join('[REDACTED]');
  }
  return text
    .replace(/((?:password|passcode|api[_ -]?secret|client[_ -]?secret|authorization|access[_ -]?token)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
}

module.exports = {
  SETUP_PARTITION,
  ACCOUNT_SIGN_IN_URL,
  ACCOUNT_HOME_URL,
  DEVELOPER_PORTAL_URL,
  OFFICIAL_SETUP_DOMAIN_FAMILIES,
  PAGE_STATES,
  SETUP_STEPS,
  STATE_TO_STEP,
  setupStep,
  stepForPageState,
  classificationFingerprint,
  isOfficialSetupHostname,
  isAllowedSetupUrl,
  blockedNavigationDiagnostic,
  safeNavigationErrorCategory,
  navigationLifecycleDiagnostic,
  approvedPopupLoadOptions,
  sanitizeSetupLocation,
  classifySetupPage,
  classifySetupSignals,
  normalizeAccessibleControlName,
  accessibleControlName,
  isSafeCurrentBusinessLink,
  resolveAuthenticatedHeaderOrganizationControl,
  describeKnownOrganizationControl,
  recognizeApiProductConfirmation,
  recognizeAssignedApiProducts,
  guidanceTarget,
  recognizeCustomerNumberText,
  recognizeBusinessMenuStructure,
  discoverCustomerNumberCandidates,
  maskCustomerNumber,
  buildCustomerDiscoveryScript,
  buildDomObserverScript,
  buildPageGuideScript,
  buildHighlightScript,
  buildClearHighlightScript,
  rectanglesIntersect,
  calculateCalloutPlacement,
  validateCustomerNumber,
  completionSummary,
  completionReady,
  redactSensitiveText
};
