'use strict';

const { app, dialog, ipcMain, BrowserWindow, shell } = require('electron');
const userDataBootstrap = require('./lib/user-data-bootstrap');

let bootstrapState = null;
try {
  bootstrapState = userDataBootstrap.initialize(app);
} catch (error) {
  const diagnostic = {
    type: 'isolated_profile_rejected',
    code: String(error?.code || 'ISOLATED_PROFILE_REJECTED').replace(/[^A-Z0-9_]/gi, '').slice(0, 80),
    message: String(error?.message || 'The isolated application-data override was rejected.').slice(0, 500)
  };
  if (process.env.CANADA_POST_CLAIM_RUNNER_HEADLESS_PROFILE_PROBE === 'PACKAGED_SYNTHETIC_ONLY') {
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    app.exit(2);
  } else {
    app.whenReady()
      .then(() => dialog.showMessageBox({
        type: 'error',
        title: 'Isolated application-data path rejected',
        message: 'Canada Post Claim Runner did not start.',
        detail: `${diagnostic.message}\n\nThe normal application profile was not used.`,
        buttons: ['Exit'],
        noLink: true
      }))
      .finally(() => app.exit(2));
  }
}

if (bootstrapState) {
  if (process.env.CANADA_POST_CLAIM_RUNNER_HEADLESS_PROFILE_PROBE === 'PACKAGED_SYNTHETIC_ONLY') {
    require('./lib/isolated-profile-probe').run(app).catch(error => {
      process.stderr.write(`${JSON.stringify({
        type: 'isolated_profile_startup_failed',
        code: String(error?.code || 'ISOLATED_PROFILE_STARTUP_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 80)
      })}\n`);
      app.exit(1);
    });
  } else {
    const mainRuntime = require('./main');
    const storage = require('./lib/app-storage');
    require('./lib/github-release-updater').registerGithubReleaseUpdater({
      app,
      ipcMain,
      dialog,
      BrowserWindow,
      shell,
      registerIpcHandler: mainRuntime.registerIpcHandler,
      isolated: Boolean(bootstrapState.active),
      operationCoordinator: require('./lib/operation-coordinator').coordinator,
      localeProvider: () => storage.publicConfig().locale || 'en-CA'
    });
  }
}
