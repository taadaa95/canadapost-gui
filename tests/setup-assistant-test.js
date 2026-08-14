'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const setup = require('../lib/setup-assistant');
const inputValidation = require('../lib/input-validation');
const rendererSetup = require('../renderer/setup-assistant');
const { validateIpcPayload } = require('../lib/ipc-contracts');
const fixtures = require('./fixtures/setup-assistant-pages');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'setup-assistant.css'), 'utf8');
const setupRendererSource = fs.readFileSync(path.join(root, 'renderer', 'setup-assistant.js'), 'utf8');
const setupControllerSource = fs.readFileSync(path.join(root, 'main', 'setup-assistant-controller.js'), 'utf8');
const english = require('../locales/en-CA.json');
const french = require('../locales/fr-CA.json');

assert.match(html, /id="guidedCanadaPostSetup"[^>]*data-i18n="setupAssistant\.launch\.button"/);
assert.match(html, /id="setupAssistantBrowserSlot"[^>]*data-native-view-slot="true"/);
assert.match(html, /id="setupAssistantGuidance"[^>]*data-native-view-exclusion="true"/);
assert.match(html, /id="setupAssistantRetry"[^>]*data-i18n="setupAssistant\.retry"/);
assert.match(html, /id="setupAssistantSaveFinish"[^>]*data-i18n="setupAssistant\.saveFinish"/);
assert.match(html, /id="setupAssistantCustomerNumber"[^>]*maxlength="10"[^>]*pattern="\[0-9\]\{1,10\}"/);

const expectedSteps = ['sign-in', 'verify', 'business', 'create-app', 'credentials', 'tracking', 'finish'];
assert.deepStrictEqual(setup.SETUP_STEPS.map(step => step.id), expectedSteps);
assert.deepStrictEqual(rendererSetup.STEPS.map(step => step.id), expectedSteps);
assert.strictEqual(setup.SETUP_STEPS[0].startUrl, setup.DEVELOPER_PORTAL_URL, 'Setup must start directly at the Developer Portal');
assert.ok(setup.SETUP_STEPS.slice(1).every(step => !step.startUrl), 'visible progress must never replay hardcoded remote navigation');
assert.deepStrictEqual(validateIpcPayload('setupAssistant:setStep', { stepId: 'credentials', credentialState: { apiKey: true, apiSecret: false } }), {
  stepId: 'credentials', credentialState: { apiKey: true, apiSecret: false }
});
assert.deepStrictEqual(validateIpcPayload('setupAssistant:setStep', {
  stepId: 'credentials', credentialState: { apiKey: false, apiSecret: false }, credentialPhase: 'paste-key'
}), { stepId: 'credentials', credentialState: { apiKey: false, apiSecret: false }, credentialPhase: 'paste-key' });
assert.deepStrictEqual(validateIpcPayload('setupAssistant:retry', { bounds: { x: 1, y: 2, width: 300, height: 240 } }), {
  bounds: { x: 1, y: 2, width: 300, height: 240 }
});
assert.deepStrictEqual(validateIpcPayload('setupAssistant:back', {}), {});
assert.deepStrictEqual(validateIpcPayload('setupAssistant:startOver', { bounds: { width: 300, height: 240 }, locale: 'fr-CA' }), {
  bounds: { width: 300, height: 240 }, locale: 'fr-CA'
});

const expectedFixtureStates = {
  'dev-portal-signed-out': 'DEV_PORTAL_SIGNED_OUT',
  'canada-post-login': 'LOGIN_PAGE',
  'mfa-intro': 'IDENTITY_CHALLENGE',
  'identity-method-selection': 'IDENTITY_METHOD_SELECTION',
  'mfa-code': 'MFA_CODE',
  'security-question': 'SECURITY_QUESTION',
  'session-limit': 'SESSION_LIMIT',
  'dev-portal-business-selector': 'BUSINESS_CONFIRMED',
  'dev-portal-business-closed': 'BUSINESS_MENU_REQUIRED',
  'dev-portal-business-open': 'BUSINESS_CONFIRMED',
  'organization-settings': 'BUSINESS_CONFIRMED',
  'authenticated-hidden-sign-in': 'BUSINESS_MENU_REQUIRED',
  'apps-list': 'APPS_PAGE',
  'apps-list-empty': 'APPS_PAGE',
  'create-app': 'CREATE_APP_SELECT_PRODUCTION',
  'create-app-test-selected': 'CREATE_APP_TEST_SELECTED',
  'create-app-name-empty': 'CREATE_APP_ENTER_NAME',
  'create-app-ready': 'CREATE_APP_READY',
  'credentials-generated': 'CREDENTIALS_GENERATED',
  'app-dashboard-no-products': 'API_PRODUCTS',
  'api-product-catalog': 'API_PRODUCT_CATALOG',
  'tracking-product-confirmation': 'TRACKING_PRODUCT_CONFIRMATION',
  'wrong-product-confirmation-rating': 'WRONG_API_PRODUCT',
  'wrong-product-confirmation-shipping': 'WRONG_API_PRODUCT',
  'wrong-product-confirmation-returns': 'WRONG_API_PRODUCT',
  'dashboard-wrong-product-only': 'TRACKING_REQUIRED_AFTER_WRONG_PRODUCT',
  'tracking-added-banner': 'TRACKING_ENABLED',
  'tracking-existing-table': 'TRACKING_ENABLED',
  'app-dashboard-tracking-enabled': 'TRACKING_ENABLED'
};
for (const [name, expected] of Object.entries(expectedFixtureStates)) {
  const fixture = fixtures[name];
  assert.ok(fixture.html.includes('<'), `${name} must include synthetic accessible markup`);
  assert.strictEqual(setup.classifySetupSignals(fixture), expected, `${name} classification`);
}
assert.notStrictEqual(setup.classifySetupSignals({
  pathname: '/devportal-portaildesdeveloppeurs/',
  controls: [
    { role: 'link', name: 'Sign in' },
    { role: 'button', name: 'SYNTHETIC SHIPPING INC', semantic: 'business-selector' },
    { role: 'link', name: 'Apps' }
  ],
  text: ['Developer Portal']
}), 'DEV_PORTAL_SIGNED_OUT', 'strong authenticated controls suppress a stale Sign in element');
assert.strictEqual(setup.classifySetupSignals(fixtures['identity-method-selection']), 'IDENTITY_METHOD_SELECTION', 'verification choices are not an answer challenge');
assert.notStrictEqual(setup.classifySetupSignals(fixtures['identity-method-selection']), 'SECURITY_QUESTION', 'a Security question radio label alone is insufficient');
assert.strictEqual(setup.classifySetupSignals(fixtures['security-question']), 'SECURITY_QUESTION', 'a Security question heading plus Answer textbox is the actual challenge');
assert.strictEqual(setup.classifySetupSignals({
  ...fixtures['tracking-product-confirmation'],
  controls: [...fixtures['tracking-product-confirmation'].controls, { role: 'link', name: 'Sign in' }]
}), 'TRACKING_PRODUCT_CONFIRMATION', 'the active confirmation dialog outranks generic Sign in evidence');
assert.match(fixtures['dev-portal-signed-out'].html, /aria-label="User menu"[\s\S]*>Sign in</);
assert.match(fixtures['canada-post-login'].html, />Username<[\s\S]*type="password"[\s\S]*>Sign in</);
assert.match(fixtures['mfa-code'].html, />Access code<[\s\S]*>Continue</);
assert.match(fixtures['session-limit'].html, />Disconnect session</);
assert.match(fixtures['create-app'].html, /edit-field-app-type-production-label[\s\S]*>Production<[\s\S]*>App name<[\s\S]*>Create</);
assert.match(fixtures['credentials-generated'].html, />Copy API Key<[\s\S]*>Copy API Secret<[\s\S]*>OK</);
assert.match(fixtures['app-dashboard-no-products'].html, />API products<[\s\S]*>Add API product</);

const fullFlow = [
  'DEV_PORTAL_SIGNED_OUT', 'LOGIN_PAGE', 'IDENTITY_METHOD_SELECTION', 'MFA_CODE', 'SESSION_LIMIT', 'BUSINESS_CONFIRMED',
  'APPS_PAGE', 'CREATE_APP_READY', 'CREDENTIALS_GENERATED', 'API_PRODUCTS', 'API_PRODUCT_CATALOG', 'TRACKING_PRODUCT_CONFIRMATION', 'TRACKING_ENABLED'
];
assert.ok(fullFlow.indexOf('CREDENTIALS_GENERATED') < fullFlow.indexOf('API_PRODUCTS'), 'credentials must occur before API-product assignment');
assert.ok(fullFlow.indexOf('CREATE_APP_READY') < fullFlow.indexOf('CREDENTIALS_GENERATED'));
assert.strictEqual(setup.stepForPageState('SESSION_LIMIT'), 'verify', 'session limit is conditional within verification');
assert.strictEqual(setup.stepForPageState('POST_AUTH_SETTLING'), 'business', 'post-auth settling remains a transient internal business-step state');
assert.strictEqual(setup.stepForPageState('BUSINESS_TARGET_RESOLVING'), 'business', 'business target resolution remains an internal Step 3 state');
assert.strictEqual(setup.stepForPageState('DEV_PORTAL_AUTHENTICATED'), 'business', 'an authenticated user skips login and MFA guidance');
assert.strictEqual(setup.stepForPageState('APPS_PAGE'), 'create-app', 'an existing Production app remains selectable without duplicate creation');

assert.deepStrictEqual(inputValidation.validateCustomerNumber(' 1234567 '), { valid: true, normalized: '0001234567' });
assert.deepStrictEqual(inputValidation.validateCustomerNumber('12345678', { padToTenDigits: false }), { valid: true, normalized: '12345678' });
assert.deepStrictEqual(rendererSetup.customerNumberState('12345678'), { valid: true, normalized: '0012345678' });
assert.strictEqual(rendererSetup.customerNumberState('123 456').valid, false);

const candidates = setup.discoverCustomerNumberCandidates([
  { text: 'Username 12345678', businessContext: false },
  { text: 'SYNTHETIC SHIPPING INC (0001234567)', developerBusinessSelector: true },
  { text: 'Viewing page as OTHER BUSINESS (0007654321)', businessContext: false },
  { text: 'Customer number: 0005554443' }
]);
assert.deepStrictEqual(candidates.map(candidate => candidate.source), ['customer-label', 'developer-business-selector', 'viewing-business']);
assert.deepStrictEqual(candidates.map(candidate => candidate.number), ['0005554443', '0001234567', '0007654321']);
assert.strictEqual(candidates[1].businessName, 'SYNTHETIC SHIPPING INC');
assert.strictEqual(setup.maskCustomerNumber(candidates[1].number), '••••••4567');
assert.deepStrictEqual(setup.recognizeBusinessMenuStructure([
  'Viewing page as:', 'SYNTHETIC SHIPPING INC', '(0001234567)'
]), [{
  number: '0001234567', businessName: 'SYNTHETIC SHIPPING INC', source: 'viewing-business', confidence: 'high', priority: 50
}], 'multiline elements in one bounded business-menu container produce one candidate');
assert.deepStrictEqual(setup.recognizeBusinessMenuStructure(['Unrelated header', '(0001234567)']), [], 'unrelated parenthesized digits are ignored');
assert.strictEqual(setup.recognizeCustomerNumberText('Customer number 0001234567')[0].number, '0001234567', 'Create new app explicit Customer number is a strong fallback');
assert.strictEqual(setup.normalizeAccessibleControlName('SYNTHETIC SHIPPING INC \uE908'), 'SYNTHETIC SHIPPING INC', 'private-use icon glyphs do not change current-business identity');
assert.strictEqual(setup.normalizeAccessibleControlName('  ARBITRARY NORTH CO.  ▼  '), 'ARBITRARY NORTH CO.', 'dropdown arrows and whitespace do not change a dynamic business identity');
assert.strictEqual(setup.accessibleControlName({ ariaLabel: 'Get access to Tracking', text: 'Get access' }), 'Get access to Tracking');
assert.strictEqual(setup.accessibleControlName({ labelledBy: 'Get access to Tracking', text: 'Get access' }), 'Get access to Tracking');
assert.strictEqual(setup.accessibleControlName({ associatedLabel: 'Answer', value: 'must-not-be-read' }), 'Answer', 'accessible naming never reads a control value');
assert.strictEqual(setup.isSafeCurrentBusinessLink({ role: 'link', name: 'SYNTHETIC SHIPPING INC \uE908', href: '#', inAuthenticatedHeader: true, currentIndicator: true }, setup.DEVELOPER_PORTAL_URL), true);
assert.strictEqual(setup.isSafeCurrentBusinessLink({ role: 'link', name: 'Another organization', href: '#', inAuthenticatedHeader: true, currentIndicator: true }, setup.DEVELOPER_PORTAL_URL), false, 'another organization is never selected');
assert.strictEqual(setup.isSafeCurrentBusinessLink({ role: 'link', name: 'SYNTHETIC SHIPPING INC', href: '/organization/settings', inAuthenticatedHeader: true, currentIndicator: true }, setup.DEVELOPER_PORTAL_URL), false, 'normal navigation links are never auto-clicked');
const screenshotHeader = fixtures['dev-portal-screenshot-header'];
const screenshotBusiness = setup.resolveAuthenticatedHeaderOrganizationControl(screenshotHeader.headerControls);
assert.deepStrictEqual(screenshotBusiness, {
  controlIndex: 2,
  profileControlIndex: 3,
  businessName: 'ACME INDUSTRIES'
}, 'the clickable organization control immediately before the profile is resolved structurally');
assert.notStrictEqual(screenshotBusiness.controlIndex, screenshotBusiness.profileControlIndex, 'the profile selector is never the business target');
const arbitraryHeader = screenshotHeader.headerControls.map(control => ({ ...control }));
arbitraryHeader[2].name = 'ARBITRARY NORTHERN PARCELS';
assert.strictEqual(setup.resolveAuthenticatedHeaderOrganizationControl(arbitraryHeader).businessName, 'ARBITRARY NORTHERN PARCELS', 'business resolution never depends on a hardcoded name');
const structureOnlyHeader = screenshotHeader.headerControls.map(control => ({ ...control, organizationEvidence: false, profileEvidence: false, identity: 'caret-down' }));
structureOnlyHeader[1].languageEvidence = true;
assert.strictEqual(setup.resolveAuthenticatedHeaderOrganizationControl(structureOnlyHeader).controlIndex, 2, 'FR followed by two dropdowns resolves the organization immediately before the profile even without names or icon labels');
assert.deepStrictEqual(setup.describeKnownOrganizationControl(screenshotHeader.knownOrganization), {
  businessName: 'ACME INDUSTRIES',
  open: false,
  state: 'BUSINESS_MENU_REQUIRED'
}, 'the inspected live component uses .currentOrg and aria-expanded=false');
assert.strictEqual(setup.describeKnownOrganizationControl({
  title: 'Current organization: TITLE FALLBACK COMPANY',
  ariaExpanded: 'false'
}).businessName, 'TITLE FALLBACK COMPANY', 'the Current organization title prefix is the second business-name source');
assert.strictEqual(setup.describeKnownOrganizationControl({ ...screenshotHeader.knownOrganization, ariaExpanded: 'true' }).state, 'BUSINESS_SELECTION', 'aria-expanded=true removes the closed-menu target state');
assert.strictEqual(setup.describeKnownOrganizationControl({ ...screenshotHeader.knownOrganization, submenuVisible: true }).state, 'BUSINESS_SELECTION', 'a visible submenu removes the closed-menu target state');
assert.deepStrictEqual(setup.discoverCustomerNumberCandidates([
  { text: 'Canada Post Web Username: 12345678' },
  { text: 'Header reference 0001234567' }
]), [], 'generic 8-digit login identity and header digits are not customer numbers');
assert.notStrictEqual(english['setupAssistant.check.webUsername'], english['setupAssistant.check.customerNumber'], 'Web Username and Customer Number are separate fields');
assert.match(setupRendererSource, /useSetupAssistantCustomerNumber\(\{ candidateId \}\)/, 'customer replacement requires explicit confirmation');
assert.match(setupRendererSource, /setupAssistantCustomerReject/, 'another business can be chosen');
assert.match(setupRendererSource, /if \(confirmedBusiness\) \{[\s\S]{0,180}setupAssistantCustomerCandidates'[\s\S]{0,80}return;/, 'confirmed business replaces, rather than coexists with, actionable confirmation controls');

const secrets = {
  webUsername: 'synthetic-user',
  webPassword: 'synthetic-password-never-return',
  customerNumber: '0001234567',
  trackingClientId: 'synthetic-client-id-never-return',
  trackingClientSecret: 'synthetic-client-secret-never-return',
  trackingProductEnabled: true
};
const complete = setup.completionSummary(secrets);
assert.deepStrictEqual({ ...complete }, { webUsername: true, webPassword: true, customerNumber: true, trackingClientId: true, trackingClientSecret: true, trackingProduct: true });
assert.ok(!JSON.stringify(complete).includes('synthetic-'), 'completion summaries contain state only');
assert.strictEqual(setup.completionReady(complete), true);
assert.strictEqual(setup.completionReady(setup.completionSummary({ ...secrets, trackingClientSecret: '' })), false);
assert.strictEqual(setup.completionSummary({ webUsername: 'changed-user', customerNumber: '42' }, {
  webUsername: 'saved-user', webPassword: true, trackingClientId: true, trackingClientSecret: true
}).webPassword, false, 'a saved password cannot silently complete a changed username');

for (const url of [
  setup.DEVELOPER_PORTAL_URL,
  'https://sso-osu.canadapost-postescanada.ca/forgot',
  'https://nested.auth.canadapost-postescanada.ca/continue',
  'https://canadapost.ca/',
  'https://origin-www.canadapost.ca/signin',
  'about:blank'
]) assert.strictEqual(setup.isAllowedSetupUrl(url), true, `approved top-level URL: ${url}`);
for (const url of [
  'http://www.canadapost-postescanada.ca/login',
  'https://evil.example/login',
  'https://canadapost.ca.example.com/login',
  'https://canadapost-postescanada.ca.example.com/login'
]) assert.strictEqual(setup.isAllowedSetupUrl(url), false, `rejected top-level URL: ${url}`);
assert.strictEqual(setup.isAllowedSetupUrl('http://127.0.0.1:49123/setup', { NODE_ENV: 'test', MOCK_PORTAL_ORIGIN: 'http://127.0.0.1:49123' }), true);
assert.strictEqual(setup.isAllowedSetupUrl('http://127.0.0.1:49124/setup', { NODE_ENV: 'test', MOCK_PORTAL_ORIGIN: 'http://127.0.0.1:49123' }), false);
assert.strictEqual(setup.classifySetupPage('https://developer-developpeur.canadapost-postescanada.ca/devportal-portaildesdeveloppeurs/session-limit'), 'SESSION_LIMIT');
assert.strictEqual(setup.classifySetupPage('https://auth.canadapost.ca/reset'), 'LOGIN_PAGE');

const blocked = setup.blockedNavigationDiagnostic('https://login.example.com/private/path?token=synthetic#private', 'redirect', 'sign-in');
assert.deepStrictEqual({ ...blocked }, { blockedHostname: 'login.example.com', navigationType: 'redirect', stepId: 'sign-in' });
assert.doesNotMatch(JSON.stringify(blocked), /private|token|synthetic|path/);
const lifecycle = setup.navigationLifecycleDiagnostic('did-fail-load', 'https://sso-osu.canadapost-postescanada.ca/private?token=synthetic', true, -105, 'verify');
assert.strictEqual(lifecycle.errorCategory, 'name_resolution_failed');
assert.doesNotMatch(JSON.stringify(lifecycle), /private|token|synthetic/);

const postData = [{ bytes: Buffer.from('synthetic=value') }];
const popupOptions = setup.approvedPopupLoadOptions({ postBody: { contentType: 'application/x-www-form-urlencoded', data: postData } });
assert.strictEqual(popupOptions.postData, postData);
assert.match(popupOptions.extraHeaders, /application\/x-www-form-urlencoded/);

const calloutLabels = Object.fromEntries(Object.entries(english)
  .filter(([key]) => key.startsWith('setupAssistant.callout.'))
  .map(([key, value]) => [key.slice('setupAssistant.callout.'.length), value]));
const target = (state, context = {}) => setup.guidanceTarget(state, { ...context, calloutLabels }).callout;
assert.strictEqual(target('DEV_PORTAL_SIGNED_OUT'), 'SIGN IN HERE');
assert.strictEqual(target('MFA_CODE'), 'ENTER YOUR ACCESS CODE');
assert.strictEqual(target('SESSION_LIMIT'), 'DISCONNECT AN OLD SESSION');
assert.strictEqual(target('CREDENTIALS_GENERATED'), 'COPY API KEY');
assert.strictEqual(target('CREDENTIALS_GENERATED', { apiKey: true }), 'COPY API SECRET');
assert.strictEqual(target('CREDENTIALS_GENERATED', { apiKey: true, apiSecret: true }), 'CONTINUE');
assert.strictEqual(target('API_PRODUCTS'), 'ADD API PRODUCT');
assert.strictEqual(target('BUSINESS_SELECTION'), 'CLICK YOUR BUSINESS NAME');
assert.strictEqual(target('BUSINESS_MENU_REQUIRED'), 'CLICK YOUR BUSINESS NAME');
assert.strictEqual(english['setupAssistant.state.businessTargetResolving.title'], 'FINDING YOUR BUSINESS MENU…');
assert.strictEqual(target('API_PRODUCT_CATALOG'), 'GET ACCESS TO TRACKING 2.0');
assert.strictEqual(target('TRACKING_PRODUCT_CONFIRMATION'), 'CLICK ADD');
assert.strictEqual(target('CREATE_APP_SELECT_PRODUCTION'), 'SELECT PRODUCTION');
assert.strictEqual(target('CREATE_APP_TEST_SELECTED'), 'SELECT PRODUCTION');
assert.strictEqual(target('CREATE_APP_ENTER_NAME'), 'NAME YOUR APP');
assert.strictEqual(target('CREATE_APP_READY'), 'CREATE APP');
assert.strictEqual(target('WRONG_API_PRODUCT'), 'CLICK BACK');
assert.strictEqual(target('TRACKING_REQUIRED_AFTER_WRONG_PRODUCT'), 'ADD API PRODUCT');

assert.deepStrictEqual(setup.recognizeApiProductConfirmation(
  'Add API product API product Plan Tracking (2.0.0) Default plan Add Back'
), { productName: 'Tracking', version: '2.0.0', planName: 'Default plan', supportedTracking: true });
assert.deepStrictEqual(setup.recognizeApiProductConfirmation(
  'Add API product API product Plan Returns (3.1.0) Default plan Add Back'
), { productName: 'Returns', version: '3.1.0', planName: 'Default plan', supportedTracking: false }, 'any non-Tracking product is rejected semantically');
assert.deepStrictEqual(setup.recognizeAssignedApiProducts(
  'Rating (4.0.0) default-plan\nPickup (1.2.3) default-plan'
), [{ productName: 'Rating', version: '4.0.0' }, { productName: 'Pickup', version: '1.2.3' }]);
const ratingFingerprint1 = setup.classificationFingerprint({ pageState: 'WRONG_API_PRODUCT', selectedProductName: 'Rating', selectedProductVersion: '4.0.0', selectedPlanName: 'Default plan', overlayInstanceId: 'overlay-1', productAttemptId: 'product-attempt-1' });
const ratingFingerprint2 = setup.classificationFingerprint({ pageState: 'WRONG_API_PRODUCT', selectedProductName: 'Rating', selectedProductVersion: '4.0.0', selectedPlanName: 'Default plan', overlayInstanceId: 'overlay-2', productAttemptId: 'product-attempt-2' });
const returnsFingerprint = setup.classificationFingerprint({ pageState: 'WRONG_API_PRODUCT', selectedProductName: 'Returns', selectedProductVersion: '2.0.0', selectedPlanName: 'Default plan', overlayInstanceId: 'overlay-3', productAttemptId: 'product-attempt-3' });
assert.notStrictEqual(ratingFingerprint1, ratingFingerprint2, 'repeating the same wrong product creates a distinct classification identity');
assert.notStrictEqual(ratingFingerprint1, returnsFingerprint, 'product payload changes are part of snapshot equality');

const guideSource = setup.buildPageGuideScript({ apiKey: false, apiSecret: false, calloutLabels });
new vm.Script(guideSource);
assert.match(guideSource, /outline: 4px solid/);
assert.match(guideSource, /cpcrSetupPulse/);
assert.match(guideSource, /cpcrSetupBounce/);
assert.match(guideSource, /cpcr-setup-required/, 'Tracking product receives its own strong required emphasis');
assert.match(guideSource, /pointer-events:none/);
assert.match(guideSource, /prefers-reduced-motion: reduce/);
assert.match(guideSource, /Math\.abs\(rect\.left - lastRect\.left\)[\s\S]{0,320}\) <= 3\) return;/, 'minor one-to-three-pixel geometry churn does not move the overlay');
assert.match(guideSource, /window\.__cpcrSetupLastPrimary !== primary/, 'the same semantic target is not repeatedly smooth-scrolled');
assert.match(guideSource, /rect\.right > 0 && rect\.bottom > 0 && rect\.left < window\.innerWidth && rect\.top < window\.innerHeight/, 'viewport visibility does not exclude controls near the top edge');
assert.match(guideSource, /businesses\[0\][\s\S]{0,30}\? null/, 'detected customer evidence never highlights a giant ancestor as an action');
for (const accessibleName of ['User menu', 'Sign in', 'Username', 'Password', 'Continue', 'Access code', 'Disconnect session', 'Apps', 'Create new app', 'Production', 'App name', 'Create', 'Copy API Key', 'Copy API Secret', 'Add API product', 'Get access to Tracking']) {
  assert.ok(guideSource.toLowerCase().includes(accessibleName.toLowerCase()), `guide source must include recorded accessible name: ${accessibleName}`);
}
assert.doesNotMatch(guideSource, /innerHTML|outerHTML|cookie|authorization/i, 'classifier must not read page HTML, cookies or authorization data');
assert.strictEqual((guideSource.match(/appNameEntry\.element\.value/g) || []).length, 1, 'only the explicitly non-secret App name value may be inspected');
assert.doesNotMatch(guideSource, /(?:password|access.?code|api.?key|api.?secret)[^\n]{0,160}\.value/i, 'secret and challenge values are never read');
assert.doesNotMatch(guideSource, /querySelector\([^)]*(?:api.?secret|api.?key)[^)]*\)/i, 'API credential DOM values must never be selected for scraping');
assert.match(guideSource, /element\.checked/, 'non-secret Production radio state may guide the primary action');
assert.match(guideSource, /safeBusinessMenuToggle/);
assert.match(guideSource, /currentBusinessControls\.length === 1/, 'business guidance requires one unique clickable header control');
assert.match(guideSource, /section\[aria-label="Consumer organization Selection"\]/, 'the inspected live Canada Post component is the primary selector');
assert.match(guideSource, /\.consumerorgSelectBlock li\.dropit-trigger > a\[title\^="Current organization:"\]/, 'the exact clickable organization anchor is targeted');
assert.match(guideSource, /knownBusinessLink\.querySelector\('\.currentOrg'\)/, '.currentOrg is the primary business-name source');
assert.match(guideSource, /knownBusinessLink \? null : resolveAuthenticatedHeaderOrganizationControl/, 'generalized header inference is fallback-only when the live component is absent');
assert.match(guideSource, /knownBusinessDescription\?\.open === true \? \[\] : \[knownBusinessEntry\]/, 'an open live component is removed from target eligibility');
assert.match(guideSource, /primary-selector=' \+ Boolean\(knownBusinessLink\)[\s\S]{0,260}rect=/, 'a failed live target emits one bounded selector/geometry diagnostic without account text');
assert.match(guideSource, /resolveAuthenticatedHeaderOrganizationControl/, 'the live classifier uses authenticated header order around the profile control');
assert.match(guideSource, /targetRole: currentBusinessTarget \? 'currentBusinessControl'/, 'the business classification preserves the exact target identity');
assert.match(guideSource, /targetKey: currentBusinessTarget \? 'current-business-control'/, 'the business overlay uses its dedicated target key');
assert.match(guideSource, /targetElementTag: primary \? String\(primary\.tagName/, 'the overlay reports the actual clickable element rather than an ancestor container');
assert.match(guideSource, /overlayInstalled = install\(primary/, 'target success means the standard overlay actually installed');
assert.match(guideSource, /publishedState = \['DEV_PORTAL_AUTHENTICATED', 'BUSINESS_MENU_REQUIRED'\][\s\S]{0,180}'BUSINESS_TARGET_RESOLVING'/, 'ordinary Step 3 guidance cannot publish without the required overlay');
assert.match(setupControllerSource, /businessTargetRetryCount >= 6/, 'failed business-overlay installation retries are bounded');
assert.match(setupControllerSource, /const delay = targetResolved \? 50 : 180/, 'a resolved target retries overlay installation after settled geometry');
assert.match(guideSource, /#ffb000/, 'browser actions use the standard yellow guidance treatment');
assert.doesNotMatch(guideSource, /expandableBusinessSelectors\[0\]\.element\.click\(\)/, 'the current-business control is never auto-clicked');
assert.doesNotMatch(guideSource, /businessSelectors\[0\]\.element\.click\(\)/, 'generic business links and organization choices are never auto-clicked');
assert.match(guideSource, /view organization settings/i, 'the real organization-settings link anchors bounded menu discovery');
assert.match(guideSource, /organization-settings-customer-label/, 'the explicit organization-settings Customer number is authoritative');
assert.ok(guideSource.includes("element.getAttribute('aria-label') || labelledBy || associatedLabel"), 'accessible-name metadata outranks visible text');
assert.ok(guideSource.includes("element.getAttribute('title')"), 'title is only a late accessible-name fallback');
assert.ok(guideSource.includes('element.labels || []'), 'associated labels are supported without reading form values');
assert.doesNotMatch(guideSource, /Get access to Tracking[^]{0,200}\.click\(/, 'Tracking access is never clicked automatically');
assert.match(guideSource, /primaryEntry\.element\.scrollIntoView\(\{ block: 'center', inline: 'nearest' \}\)/, 'exact Tracking access link is safely centered in the dialog');
assert.match(guideSource, /activeDialog \? entries\.filter\(entry => entry\.inActiveDialog\) : entries/, 'an active dialog excludes every background target');
assert.match(guideSource, /structuralOverlays/, 'product overlays are recognized without requiring role=dialog');
assert.match(guideSource, /const dialogs = \(activeDialog \? \[activeDialog\] : \[\]\)/, 'product payload is parsed only from the current topmost overlay');
assert.match(guideSource, /window\.__cpcrSetupOverlayIds instanceof WeakMap/, 'each live confirmation overlay receives stable instance identity');
assert.match(guideSource, /activeDialog\?\.contains\(element\) \|\| viewportVisible\(element\)/, 'offscreen page controls are excluded while scrollable dialog controls remain classifiable');
assert.match(guideSource, /entry\.role === 'link' && \/\^get access to tracking\$\/i/, 'catalog targeting prefers the exact recorded accessible link');
assert.match(guideSource, /entry\.role === 'link' && \/\^add\$\/i/, 'confirmation targeting uses exact Add link inside the active dialog');
assert.match(guideSource, /insideOwnerViewport/, 'the exact Tracking target is verified inside its overlay after scrolling');
assert.match(setupControllerSource, /currentClassification = Object\.freeze/, 'one immutable classification snapshot is published');
assert.match(setupControllerSource, /version: \+\+classificationSequence/, 'classification snapshots are monotonically versioned');
assert.match(setupRendererSource, /\.\.\.state, \.\.\.classification/, 'one snapshot drives the visible step, guide, and target status');
assert.match(setupRendererSource, /knownStateNoTarget/, 'known states do not produce the global layout warning when an optional target is missing');
assert.match(setup.buildClearHighlightScript(), /__cpcrSetupCleanup/);
const observerSource = setup.buildDomObserverScript();
new vm.Script(observerSource);
assert.match(observerSource, /MutationObserver/);
assert.match(observerSource, /__CPCR_SETUP_DOM_CHANGED__/);
assert.match(observerSource, /__CPCR_SETUP_ACTION__:COPY_API_KEY/);
assert.match(observerSource, /__CPCR_SETUP_ACTION__:COPY_API_SECRET/);
assert.match(observerSource, /__CPCR_SETUP_ACTION__:PRODUCT_ACCESS/);
assert.match(observerSource, /__CPCR_SETUP_ACTION__:PRODUCT_BACK/);
assert.doesNotMatch(observerSource, /navigator\.clipboard|readText\(/, 'copy detection never reads the clipboard');
assert.doesNotMatch(observerSource, /\.value\b|innerHTML|outerHTML/, 'DOM observer sends only a fixed change signal');

const calloutPlacement = setup.calculateCalloutPlacement(
  { left: 160, top: 100, right: 280, bottom: 140 },
  { width: 90, height: 35 },
  { width: 600, height: 400 },
  [{ left: 292, top: 90, right: 400, bottom: 160 }]
);
assert.strictEqual(calloutPlacement.position, 'left', 'placement skips an interactive control on the right');
const topEdgePlacement = setup.calculateCalloutPlacement(
  screenshotHeader.targetRect,
  { width: 190, height: 58 },
  { width: 800, height: 500 },
  [],
  12
);
assert.strictEqual(topEdgePlacement.position, 'below', 'a header target near the top edge prioritizes a below callout');
const placedRect = { left: calloutPlacement.left, top: calloutPlacement.top, right: calloutPlacement.left + 90, bottom: calloutPlacement.top + 35 };
assert.strictEqual(setup.rectanglesIntersect(placedRect, { left: 160, top: 100, right: 280, bottom: 140 }), false, 'text callout never intersects its target');
assert.strictEqual(setup.calculateCalloutPlacement(
  { left: 45, top: 45, right: 155, bottom: 95 },
  { width: 120, height: 50 },
  { width: 200, height: 140 },
  [{ left: 0, top: 0, right: 200, bottom: 140 }]
), null, 'ring-only fallback is used when no safe callout position exists');
assert.match(guideSource, /if \(!placement\) \{[\s\S]{0,100}pointer\.style\.display = 'none'[\s\S]{0,180}return;/, 'callout-placement failure hides only the pointer');
assert.match(guideSource, /primary\.classList\.add\('cpcr-setup-primary'\)[\s\S]*return true;/, 'the yellow outline/glow remains installed even when no callout position fits');

const safeBounds = rendererSetup.nativeBrowserBounds(
  { left: 200, top: 100, right: 900, bottom: 700 },
  { width: 1200, height: 800 },
  [{ left: 900, top: 80, right: 1200, bottom: 760 }]
);
assert.deepStrictEqual(safeBounds, { x: 200, y: 100, width: 700, height: 600 });
assert.match(css, /grid-template-areas:\s*"steps browser guidance"/);
assert.match(css, /clamp\(340px,\s*32vw,\s*380px\)/, 'desktop guidance receives a practical width');
assert.match(css, /setup-assistant-candidate\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'business confirmation uses one full-width column');
assert.match(css, /setup-assistant-candidate > div strong[^}]*width:\s*100%/, 'customer number owns a full-width readable row');
assert.match(css, /setup-assistant-candidate button[^}]*width:\s*100%/, 'confirmation buttons stack below the number');
assert.match(css, /setup-assistant-local-target[^}]*border:\s*4px/, 'paste fields receive prominent local emphasis');
assert.match(css, /setup-assistant-local-target[^}]*#ffb000/, 'API paste actions use the same standard yellow as browser actions');
assert.match(css, /setup-assistant-local-callout[^}]*#ffb000/, 'local paste callouts use the same yellow pointer language');
assert.match(css, /setup-assistant-local-target[^}]*animation:\s*setupAssistantLocalPulse/, 'local paste targets use the same animated hierarchy as browser actions');
assert.match(css, /setup-assistant-local-callout[^}]*pointer-events:\s*none/, 'local callout is external and cannot obstruct the input');
assert.match(css, /@media \(max-width: 900px\)[\s\S]*"steps" "guidance" "browser"/);

const tones = [];
const visuals = [];
const feedback = rendererSetup.createFeedbackGate({
  play: (kind, plan) => tones.push({ kind, plan }),
  visual: (kind, eventId) => visuals.push({ kind, eventId })
});
assert.strictEqual(feedback.enabled(), true, 'Guidance sounds default on');
assert.strictEqual(feedback.emit('success', 'generation-1:api-key-captured'), true);
assert.strictEqual(feedback.emit('success', 'generation-1:api-key-captured'), false, 'one semantic event cannot replay after DOM reclassification');
assert.strictEqual(tones.length, 1);
assert.deepStrictEqual(tones[0].plan, rendererSetup.feedbackTonePlan('success'));
feedback.setEnabled(false);
assert.strictEqual(feedback.emit('error', 'generation-1:wrong-product:Rating'), true);
assert.strictEqual(tones.length, 1, 'sound toggle suppresses future tones immediately');
assert.deepStrictEqual(visuals.at(-1), { kind: 'error', eventId: 'generation-1:wrong-product:Rating' }, 'visual feedback remains when audio is off');
feedback.setEnabled(true);
assert.strictEqual(feedback.emit('error', 'generation-2:product-attempt-1:Rating'), true);
assert.strictEqual(feedback.emit('error', 'generation-2:product-attempt-1:Rating'), false, 'DOM churn within Rating attempt 1 is silent');
assert.strictEqual(feedback.emit('error', 'generation-2:product-attempt-2:Returns'), true);
assert.strictEqual(feedback.emit('success', 'generation-2:product-attempt-3:Tracking'), true);
assert.strictEqual(feedback.emit('error', 'generation-2:product-attempt-4:Rating'), true, 'Rating selected again in a new attempt can notify again');
assert.ok(rendererSetup.feedbackTonePlan('success').frequencies[1] > rendererSetup.feedbackTonePlan('success').frequencies[0], 'success tone ascends');
assert.ok(rendererSetup.feedbackTonePlan('error').frequencies[1] < rendererSetup.feedbackTonePlan('error').frequencies[0], 'error tone descends');
assert.ok(rendererSetup.feedbackTonePlan('success').volume >= 0.2, 'Guidance feedback is materially louder than the former 0.04 gain');
assert.ok(rendererSetup.feedbackTonePlan('error').volume <= 0.25, 'tone envelope remains conservatively bounded');
assert.ok(rendererSetup.feedbackTonePlan('error').masterGain <= 0.6, 'master gain limits overlapping oscillator peaks');
assert.match(setupRendererSource, /if \(!hasHydratedClassification \|\| lastFeedbackSemantic === semanticId\)/, 'initial classification hydration never produces a tone');
assert.match(setupRendererSource, /api\.saveConfig\?\.\(\{ guidanceSounds: enabled \}\)/, 'the non-sensitive sound preference uses existing config persistence');
assert.match(setupRendererSource, /api-key-captured', ''/, 'API Key capture uses the durable credential status without a duplicate transient card');
assert.match(setupRendererSource, /api-secret-captured', ''/, 'API Secret capture uses the durable credential status without a duplicate transient card');
assert.doesNotMatch(html, /id="guidanceSounds"/, 'normal Settings does not duplicate the Guided Setup sound preference');
assert.match(html, /id="setupAssistantGuidanceSounds"[^>]*role="switch"[^>]*aria-checked="true"/, 'Guided Setup exposes the same accessible default-on switch');
assert.match(setupRendererSource, /deps\.guidanceSounds\?\.\(\) !== false/, 'Guided Setup hydrates the persisted default-on preference without a Settings control');
assert.doesNotMatch(renderer, /guidanceSounds:\s*switchIsOn/, 'normal Settings save does not overwrite the Guided Setup-only preference');
assert.strictEqual(english['setupAssistant.state.productCatalog.title'], 'SELECT TRACKING 2.0');
assert.match(english['setupAssistant.state.productCatalog.guidance'], /Do not select Rating, Shipping, Returns/);
assert.match(english['setupAssistant.state.trackingConfirmation.guidance'], /CORRECT API PRODUCT/);
assert.match(setupRendererSource, /control\.setAttribute\('aria-checked', enabled \? 'true' : 'false'\)/, 'switch aria-checked follows the persisted boolean state');
assert.match(html, /id="setupAssistantBrowserBack"[^>]*disabled/, 'browser Back is disabled until safe history exists');
assert.match(html, /id="setupAssistantStartOverConfirm"[^>]*role="alertdialog"/, 'Start over requires explicit local confirmation');
assert.match(setupRendererSource, /setupAssistantStartOverCancel'[\s\S]{0,100}showStartOverConfirmation\(false\)/, 'Cancel closes the confirmation without restarting');
assert.match(setupRendererSource, /mirrorDraftToAssistant\(\);[\s\S]{0,100}mirrorDraftToSettings\(\);[\s\S]{0,180}startOverSetupAssistant/, 'Start over preserves and remirrors the in-memory setup draft');
assert.doesNotMatch(/async function startOver[\s\S]*?function bind/.exec(setupRendererSource)?.[0] || '', /initializeDraft\(/, 'Start over does not discard one-time API credentials by reinitializing the draft');

const redacted = setup.redactSensitiveText('password=synthetic-password api_secret=synthetic-secret Authorization: Bearer synthetic-token', [secrets.webPassword]);
for (const forbidden of ['synthetic-password', 'synthetic-secret', 'synthetic-token']) assert.ok(!redacted.includes(forbidden));
assert.doesNotMatch(main, /setupAssistant[^\n]*(?:password|clientSecret|apiSecret).*emit/i, 'setup events must not include secrets');
assert.doesNotMatch(setupRendererSource, /console\.|localStorage|sessionStorage/, 'setup renderer must not log or persist temporary fields');
assert.doesNotMatch(`${setupRendererSource}\n${setupControllerSource}`, /capturePage|captureScreenshot|\.screenshot\(/, 'setup never captures page images');
assert.doesNotMatch(setupControllerSource, /writeConfig|appendLog|writeFile|createWriteStream/, 'candidate discovery is never persisted or logged');
assert.match(setupRendererSource, /const result = await saveSettings\(\)/, 'Save & Finish uses secure settings storage');
const draft = rendererSetup.createSetupDraft({ webUsername: 'draft-user', estCustomerNumber: '123' });
const updatedDraft = rendererSetup.patchSetupDraft(draft, { estCustomerNumber: '0001234567', trackingApiClientSecret: 'temporary-secret' });
assert.strictEqual(draft.estCustomerNumber, '123', 'setup drafts are replaced rather than partially persisted');
assert.strictEqual(updatedDraft.estCustomerNumber, '0001234567');
assert.strictEqual(updatedDraft.trackingApiClientSecret, 'temporary-secret');
assert.strictEqual(rendererSetup.patchSetupDraft(updatedDraft, { customerNumberVerified: true }).customerNumberVerified, true);
assert.deepStrictEqual(rendererSetup.GUIDED_DRAFT_FIELDS, {
  setupAssistantWebUsername: 'webUsername',
  setupAssistantWebPassword: 'webPassword',
  setupAssistantCustomerNumber: 'estCustomerNumber',
  setupAssistantClientId: 'trackingApiClientId',
  setupAssistantClientSecret: 'trackingApiClientSecret',
  setupAssistantApiEnvironment: 'trackingApiEnvironment'
}, 'every Guided Setup field maps into the one setup draft');
assert.deepStrictEqual(rendererSetup.SETTINGS_DRAFT_FIELDS, {
  webUsername: 'webUsername',
  webPassword: 'webPassword',
  estCustomerNumber: 'estCustomerNumber',
  trackingClientId: 'trackingApiClientId',
  trackingClientSecret: 'trackingApiClientSecret',
  trackingApiEnvironment: 'trackingApiEnvironment'
}, 'the normal Settings form mirrors the same draft');
assert.deepStrictEqual(rendererSetup.draftPatchForField('setupAssistantClientSecret', 'pending-secret'), { trackingApiClientSecret: 'pending-secret' });
assert.strictEqual(rendererSetup.draftPatchForField('unknown', 'ignored'), null);
assert.deepStrictEqual(rendererSetup.assessCustomerCandidates('0001234567', [
  { number: '0001234567', source: 'create-app-customer-label' }
]), { matchingCreateApp: true, conflictingCreateApp: false, visibleCandidates: [] }, 'matching Create-app number verifies the selected business identity');
assert.deepStrictEqual(rendererSetup.assessCustomerCandidates('0001234567', [
  { number: '0007654321', source: 'create-app-customer-label' }
]), {
  matchingCreateApp: false,
  conflictingCreateApp: true,
  visibleCandidates: [{ number: '0007654321', source: 'create-app-customer-label' }]
}, 'a Create-app mismatch remains visible for confirmation and never silently overwrites the draft');
assert.match(setupRendererSource, /mirrorDraftToSettings/);
assert.match(setupRendererSource, /restoreSettingsBaseline/);
assert.strictEqual((/async function saveAndFinish[\s\S]*?function pageStateChanged/.exec(setupRendererSource)?.[0].match(/await saveSettings\(\)/g) || []).length, 1, 'Save & Finish invokes the existing settings save exactly once');
assert.match(html, /id="setupAssistantFinish"[\s\S]*id="setupAssistantChecklist"/, 'the full checklist is reserved for Finish');
assert.match(html, /id="setupAssistantCompletionSurface"[\s\S]*setupAssistant\.completionSurface\.title/, 'Finish replaces the native browser area with an explicit local completion surface');
assert.match(css, /setup-assistant-browser-slot\.finish\s*\{\s*display:\s*none/);
assert.match(css, /setup-assistant-progress li\.complete::after\s*\{\s*content:\s*" ✓"/, 'completed steps receive explicit checkmarks');
assert.match(setupRendererSource, /state\.pageState === 'TRACKING_ENABLED'[\s\S]*setHidden\('setupAssistantCantFind', true\)[\s\S]*setHidden\('setupAssistantPageStatus', true\)/, 'Finish suppresses target fallback and Can’t find controls');
assert.match(html, /setupAssistant\.whatToDoNow/);
assert.match(html, /setupAssistant\.autoContinue/);
assert.match(renderer, /saveSettings: \(\) => saveUserSettings\(true\)/);
const configSaveSource = /registerIpcHandler\('config:save'[\s\S]*?registerIpcHandler\('credentials:clearTrackingApi'/.exec(main)?.[0] || '';
assert.ok(configSaveSource.indexOf('credentialWriteFailed') < configSaveSource.indexOf('writeConfig(next)'), 'config is written only after required secure credential writes succeed');
assert.match(configSaveSource, /rollbackCredentials\(\)/, 'a failed secure/config write restores the previous credential set');

const setStepSource = /async function setStep[\s\S]*?\n  async function retryCurrentStep/.exec(setupControllerSource)?.[0] || '';
assert.doesNotMatch(setStepSource, /loadURL|ACCOUNT_HOME_URL/, 'normal progress must not replay approved same-tab navigation');
assert.match(setupControllerSource, /will-navigate[\s\S]*blockTopLevelNavigation/);
assert.match(setupControllerSource, /if \(!isCurrent\(generation, candidate\) \|\| isAllowedSetupUrl\(url, environment\)\) return false;/, 'approved top-level navigation must be allowed untouched');
assert.match(setupControllerSource, /if \(isMainFrame === false\) return;/, 'subframe redirects bypass top-level allowlist filtering');
assert.match(setupControllerSource, /setWindowOpenHandler/, 'real popup requests retain separate handling');

const setupKeys = Object.keys(english).filter(key => key.startsWith('setupAssistant.'));
assert.deepStrictEqual(setupKeys.sort(), Object.keys(french).filter(key => key.startsWith('setupAssistant.')).sort());
for (const key of setupKeys) {
  assert.ok(String(english[key]).trim(), `missing English text for ${key}`);
  assert.ok(String(french[key]).trim(), `missing French text for ${key}`);
  assert.notStrictEqual(english[key], french[key], `French setup text remained English for ${key}`);
}
assert.match(english['setupAssistant.state.sessionLimit.guidance'], /Disconnect session/);
assert.match(english['setupAssistant.step.credentials.guidance'], /API Key[\s\S]*API Secret[\s\S]*OK/);
assert.match(english['setupAssistant.state.apiProducts.fallback'], /Credentials come first; API-product assignment comes next/);
assert.doesNotMatch(setupKeys.map(key => english[key]).join('\n'), /SOAP|Basic[- ]auth/i);

assert.match(main, /setupAssistantController\.active\(\)[\s\S]{0,220}SETUP_ASSISTANT_ACTIVE/);
assert.match(main, /closeSetupAssistant\('renderer-window-close'\)/);
assert.match(main, /closeSetupAssistant\('app-shutdown'\)/);
assert.match(setupControllerSource, /partition:\s*SETUP_PARTITION/);

process.stdout.write('Recorded Guided Setup model, privacy, highlighting, localization and navigation contracts passed.\n');
