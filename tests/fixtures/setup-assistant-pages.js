'use strict';

function fixture(pathname, html, controls, text = [], businesses = [], extra = {}) {
  return Object.freeze({ pathname, html, controls: Object.freeze(controls), text: Object.freeze(text), businesses: Object.freeze(businesses), ...extra });
}

module.exports = Object.freeze({
  'dev-portal-signed-out': fixture(
    '/devportal-portaildesdeveloppeurs/',
    '<h1>Canada Post Developer Portal</h1><button aria-label="User menu">User menu</button><nav aria-label="User menu"><a href="/sign-in">Sign in</a></nav>',
    [{ role: 'button', name: 'User menu' }, { role: 'link', name: 'Sign in' }],
    ['Canada Post Developer Portal']
  ),
  'canada-post-login': fixture(
    '/login',
    '<label for="username">Username</label><input id="username" type="text"><label for="password">Password</label><input id="password" type="password"><button>Sign in</button>',
    [{ role: 'textbox', name: 'Username' }, { role: 'textbox', name: 'Password', kind: 'password' }, { role: 'button', name: 'Sign in' }]
  ),
  'mfa-intro': fixture(
    '/verify',
    '<h1>Verify your identity</h1><button>Continue</button>',
    [{ role: 'button', name: 'Continue' }],
    ['Verify your identity']
  ),
  'identity-method-selection': fixture(
    '/verify',
    '<h1>Verify your identity</h1><label><input type="radio" name="method">Access code by email</label><label><input type="radio" name="method">Access code by text</label><label><input type="radio" name="method">Security question: answer one of your security questions</label><button>Continue</button>',
    [{ role: 'radio', name: 'Access code by email' }, { role: 'radio', name: 'Access code by text' }, { role: 'radio', name: 'Security question: answer one of your security questions' }, { role: 'button', name: 'Continue' }],
    ['Verify your identity']
  ),
  'mfa-code': fixture(
    '/verify/code',
    '<label for="access-code">Access code</label><input id="access-code" type="text"><button>Continue</button>',
    [{ role: 'textbox', name: 'Access code' }, { role: 'button', name: 'Continue' }],
    ['Access code']
  ),
  'security-question': fixture(
    '/verify/question',
    '<h1>Security question</h1><label for="answer">Answer</label><input id="answer" type="password"><button>Continue</button>',
    [{ role: 'textbox', name: 'Answer', kind: 'password' }, { role: 'button', name: 'Continue' }],
    ['Security question']
  ),
  'session-limit': fixture(
    '/devportal-portaildesdeveloppeurs/session-limit',
    '<h1>Session limit</h1><label><input type="radio" name="session">Older session</label><button>Disconnect session</button>',
    [{ role: 'radio', name: 'Older session' }, { role: 'button', name: 'Disconnect session' }],
    ['Session limit']
  ),
  'dev-portal-business-selector': fixture(
    '/devportal-portaildesdeveloppeurs/',
    '<h1>Developer Portal</h1><button aria-label="Business account">SYNTHETIC SHIPPING INC</button><div role="option" class="business-selector">SYNTHETIC SHIPPING INC (0001234567)</div><a href="/apps">Apps</a>',
    [{ role: 'button', name: 'SYNTHETIC SHIPPING INC' }, { role: 'option', name: 'SYNTHETIC SHIPPING INC (0001234567)' }, { role: 'link', name: 'Apps' }],
    ['Developer Portal'],
    [{ businessName: 'SYNTHETIC SHIPPING INC', number: '0001234567', source: 'developer-business-selector' }]
  ),
  'dev-portal-business-closed': fixture(
    '/devportal-portaildesdeveloppeurs/',
    '<header><a href="#">SYNTHETIC SHIPPING INC \uE908</a><a href="/apps">Apps</a></header>',
    [{ role: 'link', name: 'SYNTHETIC SHIPPING INC \uE908', semantic: 'business-selector' }, { role: 'link', name: 'Apps' }],
    ['Developer Portal']
  ),
  'dev-portal-screenshot-header': fixture(
    '/devportal-portaildesdeveloppeurs/',
    '<header><a href="/portal-settings">Portal settings</a><a href="/fr">FR</a><section id="block-consumerorganizationselection-2" aria-label="Consumer organization Selection"><div class="consumerorgSelectBlock"><ul class="dropitmenu orgmenu dropit"><li class="dropit-trigger" aria-haspopup="true" aria-expanded="false"><a href="#" title="Current organization: ACME INDUSTRIES"><div class="orgHeading"><div class="currentOrg">ACME INDUSTRIES</div></div><span class="dropit-icon"><svg aria-hidden="true"></svg></span></a><ul class="dropitmenu-submenu dropit-submenu" style="display:none"></ul></li></ul></div></section><a href="#"><svg data-icon="user"></svg>User Name<svg data-icon="caret-down"></svg></a></header><a href="/apps">Apps</a>',
    [{ role: 'link', name: 'Portal settings' }, { role: 'link', name: 'FR' }, { role: 'link', name: 'ACME INDUSTRIES' }, { role: 'link', name: 'User Name' }, { role: 'link', name: 'Apps' }],
    ['Developer Portal'],
    [],
    {
      headerControls: [
        { role: 'link', name: 'Portal settings', identity: 'portal-settings', inHeader: true, order: 0 },
        { role: 'link', name: 'FR', identity: 'language', inHeader: true, languageEvidence: true, order: 1 },
        { role: 'link', name: 'ACME INDUSTRIES', identity: 'consumerorgSelectBlock currentOrg dropit-trigger', inHeader: true, dropdown: true, organizationEvidence: true, order: 2 },
        { role: 'link', name: 'User Name', identity: 'user caret-down', inHeader: true, dropdown: true, profileEvidence: true, order: 3 }
      ],
      knownOrganization: {
        currentOrgText: 'ACME INDUSTRIES',
        title: 'Current organization: ACME INDUSTRIES',
        accessibleName: 'ACME INDUSTRIES',
        ariaExpanded: 'false',
        submenuVisible: false
      },
      targetRect: { left: 360, top: 8, right: 520, bottom: 42 }
    }
  ),
  'dev-portal-business-open': fixture(
    '/devportal-portaildesdeveloppeurs/',
    '<header><a href="#">SYNTHETIC SHIPPING INC \uE908</a><div><span>Viewing page as:</span><strong>SYNTHETIC SHIPPING INC</strong><small>(0001234567)</small><a href="/organization/settings">View organization settings</a></div><a href="/apps">Apps</a></header>',
    [{ role: 'link', name: 'SYNTHETIC SHIPPING INC \uE908', semantic: 'business-selector' }, { role: 'link', name: 'View organization settings' }, { role: 'link', name: 'Apps' }],
    ['Developer Portal'],
    [{ businessName: 'SYNTHETIC SHIPPING INC', number: '0001234567', source: 'viewing-business' }]
  ),
  'organization-settings': fixture(
    '/devportal-portaildesdeveloppeurs/organization/settings',
    '<header><a href="#">SYNTHETIC SHIPPING INC \uE908</a><a href="/apps">Apps</a></header><h1>SYNTHETIC SHIPPING INC</h1><section><span>Customer number</span><strong>0001234567</strong></section><h2>Users</h2>',
    [{ role: 'link', name: 'SYNTHETIC SHIPPING INC \uE908', semantic: 'business-selector' }, { role: 'link', name: 'Apps' }],
    ['SYNTHETIC SHIPPING INC', 'Customer number'],
    [{ businessName: 'SYNTHETIC SHIPPING INC', number: '0001234567', source: 'organization-settings-customer-label' }]
  ),
  'authenticated-hidden-sign-in': fixture(
    '/devportal-portaildesdeveloppeurs/',
    '<header><button aria-haspopup="menu">SYNTHETIC SHIPPING INC</button><a href="/sign-in" hidden>Sign in</a><a href="/apps">Apps</a></header>',
    [{ role: 'button', name: 'SYNTHETIC SHIPPING INC', semantic: 'business-selector' }, { role: 'link', name: 'Apps' }],
    ['Developer Portal']
  ),
  'apps-list': fixture(
    '/devportal-portaildesdeveloppeurs/apps',
    '<h1>Apps</h1><a href="/apps/existing">[Production] Existing Shipping App</a><a href="/apps/create">Create new app</a>',
    [{ role: 'link', name: '[Production] Existing Shipping App' }, { role: 'link', name: 'Create new app' }],
    ['Apps']
  ),
  'apps-list-empty': fixture(
    '/devportal-portaildesdeveloppeurs/apps',
    '<h1>Apps</h1><a href="/apps/create">Create new app</a>',
    [{ role: 'link', name: 'Create new app' }],
    ['Apps']
  ),
  'create-app': fixture(
    '/devportal-portaildesdeveloppeurs/apps/create',
    '<h1>Create new app</h1><div><span>Customer number</span><strong>0001234567</strong></div><label><input type="radio" name="app-type">Test</label><label id="edit-field-app-type-production-label"><input type="radio" name="app-type">Production</label><label for="app-name">App name</label><input id="app-name" type="text"><button>Create</button>',
    [{ role: 'radio', name: 'Test' }, { role: 'radio', name: 'Production' }, { role: 'textbox', name: 'App name' }, { role: 'button', name: 'Create' }],
    ['Create new app'],
    [],
    { createApp: { productionSelected: false, testSelected: false, appNamePresent: false } }
  ),
  'create-app-test-selected': fixture(
    '/devportal-portaildesdeveloppeurs/apps/create',
    '<h1>Create new app</h1><label><input type="radio" checked>Test</label><label><input type="radio">Production</label><label>App name<input type="text"></label><button>Create</button>',
    [{ role: 'radio', name: 'Test', checked: true }, { role: 'radio', name: 'Production' }, { role: 'textbox', name: 'App name' }, { role: 'button', name: 'Create' }],
    ['Create new app'], [], { createApp: { productionSelected: false, testSelected: true, appNamePresent: false } }
  ),
  'create-app-name-empty': fixture(
    '/devportal-portaildesdeveloppeurs/apps/create',
    '<h1>Create new app</h1><label><input type="radio" checked>Production</label><label>App name<input type="text"></label><button>Create</button>',
    [{ role: 'radio', name: 'Production', checked: true }, { role: 'textbox', name: 'App name' }, { role: 'button', name: 'Create' }],
    ['Create new app'], [], { createApp: { productionSelected: true, testSelected: false, appNamePresent: false } }
  ),
  'create-app-ready': fixture(
    '/devportal-portaildesdeveloppeurs/apps/create',
    '<h1>Create new app</h1><label><input type="radio" checked>Production</label><label>App name<input type="text"></label><label>Description<textarea></textarea></label><button>Create</button>',
    [{ role: 'radio', name: 'Production', checked: true }, { role: 'textbox', name: 'App name' }, { role: 'textbox', name: 'Description' }, { role: 'button', name: 'Create' }],
    ['Create new app'], [], { createApp: { productionSelected: true, testSelected: false, appNamePresent: true } }
  ),
  'credentials-generated': fixture(
    '/devportal-portaildesdeveloppeurs/apps/credentials',
    '<h1>App credentials generated</h1><button>Copy API Key</button><button>Copy API Secret</button><button>Show password</button><a href="/apps/new">OK</a>',
    [{ role: 'button', name: 'Copy API Key' }, { role: 'button', name: 'Copy API Secret' }, { role: 'button', name: 'Show password' }, { role: 'link', name: 'OK' }],
    ['App credentials generated']
  ),
  'app-dashboard-no-products': fixture(
    '/devportal-portaildesdeveloppeurs/apps/new',
    '<h1><span>Production</span> Claim Runner</h1><h2>API products</h2><p>This application currently has no API products.</p><a href="/products/add">Add API product</a>',
    [{ role: 'link', name: 'Add API product' }],
    ['Production Claim Runner', 'API products']
  ),
  'api-product-catalog': fixture(
    '/devportal-portaildesdeveloppeurs/apps/new',
    '<button>Add API product</button><div class="overlay"><h2>Add API product</h2><article>Rating 4.0.0<a href="#rating" aria-label="Get access to Rating">Get access</a></article><article>Customer Information Services 1.0.0<a href="#cis" aria-label="Get access to Customer Information Services">Get access</a></article><article>Shipping 8.0.0<a href="#shipping" aria-label="Get access to Shipping">Get access</a></article><article data-below-viewport="true">Tracking 2.0.0<a href="#tracking" aria-label="Get access to Tracking">Get access</a></article></div>',
    [{ role: 'button', name: 'Add API product' }, { role: 'link', name: 'Get access to Rating', inActiveDialog: true }, { role: 'link', name: 'Get access to Customer Information Services', inActiveDialog: true }, { role: 'link', name: 'Get access to Shipping', inActiveDialog: true }, { role: 'link', name: 'Get access to Tracking', inActiveDialog: true }],
    ['Developer Portal'],
    [],
    {
      dialogs: ['Add API product Rating 4.0.0 Customer Information Services 1.0.0 Shipping 8.0.0 Tracking 2.0.0'],
      dialogControls: [{ role: 'link', name: 'Get access to Rating' }, { role: 'link', name: 'Get access to Customer Information Services' }, { role: 'link', name: 'Get access to Shipping' }, { role: 'link', name: 'Get access to Tracking' }]
    }
  ),
  'tracking-product-confirmation': fixture(
    '/devportal-portaildesdeveloppeurs/apps/new',
    '<button>Add API product</button><a href="/sign-in" hidden>Sign in</a><div class="overlay"><h2>Add API product</h2><div>API product Plan</div><div>Tracking (2.0.0) Default plan</div><a href="#add">Add</a><a href="#back">Back</a></div>',
    [{ role: 'button', name: 'Add API product' }, { role: 'row', name: 'Tracking (2.0.0) Default plan', inActiveDialog: true }, { role: 'link', name: 'Add', inActiveDialog: true }, { role: 'link', name: 'Back', inActiveDialog: true }],
    ['Developer Portal'],
    [],
    {
      dialogs: ['Add API product API product Plan Tracking (2.0.0) Default plan Add Back'],
      dialogControls: [{ role: 'row', name: 'Tracking (2.0.0) Default plan' }, { role: 'link', name: 'Add' }, { role: 'link', name: 'Back' }]
    }
  ),
  'wrong-product-confirmation-rating': fixture(
    '/devportal-portaildesdeveloppeurs/apps/new',
    '<div class="overlay"><h2>Add API product</h2><div>API product Plan</div><div>Rating (4.0.0) Default plan</div><a href="#add">Add</a><a href="#back">Back</a></div>',
    [{ role: 'row', name: 'Rating (4.0.0) Default plan', inActiveDialog: true }, { role: 'link', name: 'Add', inActiveDialog: true }, { role: 'link', name: 'Back', inActiveDialog: true }],
    [], [], { dialogs: ['Add API product API product Plan Rating (4.0.0) Default plan Add Back'], dialogControls: [{ role: 'link', name: 'Add' }, { role: 'link', name: 'Back' }] }
  ),
  'wrong-product-confirmation-shipping': fixture(
    '/devportal-portaildesdeveloppeurs/apps/new',
    '<div class="overlay"><h2>Add API product</h2><div>Shipping (8.0.0) Default plan</div><a href="#add">Add</a><a href="#back">Back</a></div>',
    [{ role: 'row', name: 'Shipping (8.0.0) Default plan', inActiveDialog: true }, { role: 'link', name: 'Add', inActiveDialog: true }, { role: 'link', name: 'Back', inActiveDialog: true }],
    [], [], { dialogs: ['Add API product API product Plan Shipping (8.0.0) Default plan Add Back'], dialogControls: [{ role: 'link', name: 'Add' }, { role: 'link', name: 'Back' }] }
  ),
  'wrong-product-confirmation-returns': fixture(
    '/devportal-portaildesdeveloppeurs/apps/new',
    '<div class="overlay"><h2>Add API product</h2><div>Returns (2.0.0) Default plan</div><a href="#add">Add</a><a href="#back">Back</a></div>',
    [{ role: 'row', name: 'Returns (2.0.0) Default plan', inActiveDialog: true }, { role: 'link', name: 'Add', inActiveDialog: true }, { role: 'link', name: 'Back', inActiveDialog: true }],
    [], [], { dialogs: ['Add API product API product Plan Returns (2.0.0) Default plan Add Back'], dialogControls: [{ role: 'link', name: 'Add' }, { role: 'link', name: 'Back' }] }
  ),
  'dashboard-wrong-product-only': fixture(
    '/devportal-portaildesdeveloppeurs/apps/new',
    '<h2>API products</h2><table><tr><td>Rating (4.0.0)</td><td>default-plan</td></tr></table><button>Add API product</button>',
    [{ role: 'button', name: 'Add API product' }], ['API products'], [], { apiProductText: ['Rating (4.0.0) default-plan'] }
  ),
  'tracking-added-banner': fixture(
    '/devportal-portaildesdeveloppeurs/apps/new',
    '<div role="status">API product added. You now have access to Tracking (2.0.0) API product.</div><h2>API products</h2><button>Add API product</button>',
    [{ role: 'button', name: 'Add API product' }],
    ['API products'],
    [],
    { statusText: ['API product added. You now have access to Tracking (2.0.0) API product.'] }
  ),
  'tracking-existing-table': fixture(
    '/devportal-portaildesdeveloppeurs/apps/new',
    '<h2>API products</h2><table><tr><td>Tracking (2.0.0)</td><td>default-plan</td></tr></table><button>Add API product</button>',
    [{ role: 'button', name: 'Add API product' }],
    ['API products'],
    [],
    { apiProductText: ['Tracking (2.0.0) default-plan'] }
  ),
  'app-dashboard-tracking-enabled': fixture(
    '/devportal-portaildesdeveloppeurs/apps/new',
    '<h1><span>Production</span> Claim Runner</h1><h2>API products</h2><p>Tracking (2.0.0) access enabled</p>',
    [{ role: 'link', name: 'Tracking (2.0.0)' }],
    ['Production Claim Runner', 'API products'],
    [],
    { apiProductText: ['Tracking (2.0.0) access enabled'] }
  )
});
