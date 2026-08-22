'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const claimDb = require('./claim-database');
const i18n = require('./i18n');
const updateInstallGuard = require('./update-install-guard');
const { coordinator: defaultCoordinator } = require('./operation-coordinator');
const updateSecurity = require('./update-security');
const { compareVersions } = updateSecurity;
const UPDATE_SOURCE = require('../config/update-source.json');

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = updateSecurity.MAX_ARTIFACT_BYTES;
const PROGRESS_INTERVAL_MS = 125;
const MAX_REDIRECTS = 5;
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function version(value) {
  const result = String(value || '').trim().replace(/^v/i, '');
  try { updateSecurity.parseVersion(result); }
  catch (_) { throw fail('UPDATE_VERSION_INVALID', 'The update version is invalid.'); }
  return result;
}

function githubUrl(value, label = 'Update URL') {
  let url;
  try { url = new URL(String(value || '')); }
  catch (_) { throw fail('UPDATE_URL_INVALID', `${label} is invalid.`); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw fail('UPDATE_URL_BLOCKED', `${label} is outside the approved GitHub hosts.`);
  }
  return url;
}

function apiUrl(source = UPDATE_SOURCE) {
  if (source.provider !== 'github-releases') throw fail('UPDATE_SOURCE_INVALID', 'The bundled update source provider is invalid.');
  const owner = String(source.owner || '');
  const repository = String(source.repository || '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repository)) throw fail('UPDATE_SOURCE_INVALID', 'The bundled update source is invalid.');
  return `https://api.github.com/repos/${owner}/${repository}/releases/latest`;
}

async function fetchGithub(url, fetchImpl = globalThis.fetch, options = {}, label = 'Update URL') {
  let current = githubUrl(url, label);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(current, { ...options, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === MAX_REDIRECTS) throw fail('UPDATE_REDIRECT_LIMIT', 'The update request exceeded the redirect limit.');
      const location = response.headers.get('location');
      if (!location) throw fail('UPDATE_REDIRECT_INVALID', 'The update response contained an invalid redirect.');
      current = githubUrl(new URL(location, current), 'Update redirect URL');
      continue;
    }
    githubUrl(response.url || current, 'Final update URL');
    return response;
  }
  throw fail('UPDATE_REDIRECT_LIMIT', 'The update request exceeded the redirect limit.');
}

function platformName(platform = process.platform) {
  if (platform === 'win32' || platform === 'windows') return 'windows';
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin' || platform === 'macos') return 'macos';
  throw fail('UPDATE_PLATFORM_UNSUPPORTED', `Automatic updates are not supported on ${platform}.`);
}

function asset(release, name) {
  return (Array.isArray(release?.assets) ? release.assets : []).find(item => item?.name === name) || null;
}

function expectedArtifactName(releaseVersion, platform = process.platform, arch = process.arch) {
  const normalizedPlatform = platformName(platform);
  if (normalizedPlatform === 'macos') {
    if (!['x64', 'arm64'].includes(arch)) throw fail('UPDATE_ARCH_UNSUPPORTED', `Automatic updates are not supported on ${arch}.`);
    return `Canada.Post.Claim.Runner-${version(releaseVersion)}-mac-universal.dmg`;
  }
  if (arch !== 'x64') throw fail('UPDATE_ARCH_UNSUPPORTED', `Automatic updates are not supported on ${arch}.`);
  const platformToken = normalizedPlatform === 'windows' ? 'win' : 'linux';
  const architectureToken = normalizedPlatform === 'windows' ? 'x64' : 'x86_64';
  const extension = normalizedPlatform === 'windows' ? '.exe' : '.AppImage';
  return `Canada.Post.Claim.Runner-${version(releaseVersion)}-${platformToken}-${architectureToken}${extension}`;
}

function assetDigest(value) {
  const match = String(value || '').match(/^sha256:([a-f0-9]{64})$/i);
  if (!match) throw fail('UPDATE_ASSET_DIGEST_INVALID', 'The GitHub release asset is missing a valid SHA-256 digest.');
  return match[1].toLowerCase();
}

function validateLatestRelease(release, currentVersion, platform = process.platform, arch = process.arch) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw fail('UPDATE_METADATA_INVALID', 'GitHub returned invalid release metadata.');
  }
  if (release.draft || release.prerelease) {
    throw fail('UPDATE_RELEASE_NOT_STABLE', 'GitHub Latest did not return a normal stable release.');
  }
  const latestVersion = version(release.tag_name);
  if (latestVersion.includes('-')) throw fail('UPDATE_RELEASE_NOT_STABLE', 'GitHub Latest did not return a stable semantic version.');
  const current = version(currentVersion);
  if (compareVersions(latestVersion, current) <= 0) {
    return { available: false, currentVersion: current, latestVersion };
  }
  const file = expectedArtifactName(latestVersion, platform, arch);
  const releaseAsset = asset(release, file);
  if (!releaseAsset) throw fail('UPDATE_ASSET_MISSING', `The GitHub Release is missing ${file}.`);
  const bytes = Number(releaseAsset.size);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ARTIFACT_BYTES) {
    throw fail('UPDATE_ARTIFACT_SIZE_INVALID', 'The update package size is invalid.');
  }
  const sha256 = assetDigest(releaseAsset.digest);
  githubUrl(releaseAsset.browser_download_url, 'Update package URL');
  return {
    available: true,
    currentVersion: current,
    version: latestVersion,
    release,
    releaseAsset,
    artifact: { file, bytes, sha256 },
    notes: String(release.body || '').replace(/\r/g, '').slice(0, 3500)
  };
}

async function json(url, fetchImpl = globalThis.fetch, userAgent = 'Canada-Post-Claim-Runner-Updater') {
  const requested = githubUrl(url);
  const response = await fetchGithub(requested, fetchImpl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent
    }
  });
  if (!response.ok) {
    if (response.status === 404) throw fail('UPDATE_REPOSITORY_NOT_READY', 'The public GitHub release repository is not available yet.');
    throw fail('UPDATE_HTTP_ERROR', `GitHub update request failed with HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_METADATA_BYTES) throw fail('UPDATE_METADATA_TOO_LARGE', 'The update metadata is too large.');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_METADATA_BYTES) throw fail('UPDATE_METADATA_TOO_LARGE', 'The update metadata is too large.');
  try { return JSON.parse(data.toString('utf8')); }
  catch (_) { throw fail('UPDATE_METADATA_INVALID', 'GitHub returned invalid update metadata.'); }
}

async function resolveUpdate(options = {}) {
  const source = options.source || UPDATE_SOURCE;
  const currentVersion = version(options.currentVersion);
  const userAgent = options.userAgent || `Canada-Post-Claim-Runner/${currentVersion}`;
  const release = await json(apiUrl(source), options.fetchImpl, userAgent);
  return validateLatestRelease(release, currentVersion, options.platform, options.arch);
}

async function fileHash(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function progressSnapshot(received, total, startedAt, now = Date.now()) {
  const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
  const bytesPerSecond = received / elapsedSeconds;
  const remaining = Math.max(total - received, 0);
  return {
    received,
    total,
    ratio: total > 0 ? Math.min(received / total, 1) : 0,
    bytesPerSecond,
    etaSeconds: bytesPerSecond > 0 ? remaining / bytesPerSecond : null
  };
}

async function downloadUpdate(update, options) {
  const directory = path.join(options.app.getPath('userData'), 'updates', version(update.version));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, path.basename(update.artifact.file));
  const partial = `${destination}.partial-${process.pid}`;
  if (fs.existsSync(destination) && fs.statSync(destination).size === update.artifact.bytes && await fileHash(destination) === update.artifact.sha256) {
    options.onProgress?.({ ...progressSnapshot(update.artifact.bytes, update.artifact.bytes, Date.now()), cached: true });
    return destination;
  }
  fs.rmSync(destination, { force: true });
  fs.rmSync(partial, { force: true });

  const requested = githubUrl(update.releaseAsset.browser_download_url, 'Update package URL');
  let response;
  try {
    response = await fetchGithub(requested, options.fetchImpl || globalThis.fetch, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': options.userAgent },
      signal: options.signal
    }, 'Update package URL');
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') throw fail('UPDATE_DOWNLOAD_CANCELLED', 'The update download was cancelled.');
    throw error;
  }
  if (!response.ok || !response.body) throw fail('UPDATE_DOWNLOAD_FAILED', `Update download failed with HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length && length !== update.artifact.bytes) throw fail('UPDATE_DOWNLOAD_SIZE_MISMATCH', 'The update download size is incorrect.');

  let received = 0;
  let lastProgressAt = 0;
  const startedAt = Date.now();
  const hash = crypto.createHash('sha256');
  const stream = Readable.fromWeb(response.body);
  const abort = () => stream.destroy(fail('UPDATE_DOWNLOAD_CANCELLED', 'The update download was cancelled.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  stream.on('data', chunk => {
    received += chunk.length;
    hash.update(chunk);
    if (received > update.artifact.bytes) stream.destroy(fail('UPDATE_DOWNLOAD_TOO_LARGE', 'The update download exceeded its declared size.'));
    const now = Date.now();
    if (now - lastProgressAt >= PROGRESS_INTERVAL_MS || received === update.artifact.bytes) {
      lastProgressAt = now;
      options.onProgress?.(progressSnapshot(received, update.artifact.bytes, startedAt, now));
    }
  });
  try {
    await pipeline(stream, fs.createWriteStream(partial, { mode: 0o600, flags: 'wx' }));
    if (received !== update.artifact.bytes) throw fail('UPDATE_DOWNLOAD_INCOMPLETE', 'The update download is incomplete.');
    options.onStage?.('verifying');
    if (hash.digest('hex') !== update.artifact.sha256) throw fail('UPDATE_DOWNLOAD_HASH_MISMATCH', 'The update download failed SHA-256 verification.');
    fs.renameSync(partial, destination);
    fs.chmodSync(destination, process.platform === 'linux' ? 0o700 : 0o600);
    return destination;
  } catch (error) {
    fs.rmSync(partial, { force: true });
    if (options.signal?.aborted || error?.code === 'UPDATE_DOWNLOAD_CANCELLED' || error?.name === 'AbortError') {
      throw fail('UPDATE_DOWNLOAD_CANCELLED', 'The update download was cancelled.');
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

function cleanupUpdateStorage(userDataRoot, options = {}) {
  const updatesRoot = path.join(path.resolve(userDataRoot), 'updates');
  if (!fs.existsSync(updatesRoot)) return { removed: 0, retained: 0 };
  const protectedPaths = new Set((options.protectedPaths || []).filter(Boolean).map(value => path.resolve(value)));
  const candidates = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'history') walk(target);
      } else if (/\.partial-/i.test(entry.name)) {
        if (!protectedPaths.has(path.resolve(target))) fs.rmSync(target, { force: true });
      } else if (/\.(?:AppImage|exe|dmg)$/i.test(entry.name) && !protectedPaths.has(path.resolve(target))) {
        candidates.push({ path: target, mtimeMs: fs.statSync(target).mtimeMs });
      }
    }
  };
  walk(updatesRoot);
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const keep = Math.max(0, Math.min(5, Number(options.keepRecent ?? 2)));
  let removed = 0;
  for (const item of candidates.slice(keep)) {
    fs.rmSync(item.path, { force: true });
    removed += 1;
  }
  return { removed, retained: Math.min(candidates.length, keep) + protectedPaths.size };
}

function syncFile(target, fileSystem = fs) {
  const fd = fileSystem.openSync(target, 'r');
  try { fileSystem.fsyncSync(fd); } finally { fileSystem.closeSync(fd); }
}

function syncDirectory(directory, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'linux') return false;
  syncFile(directory, options.fileSystem || fs);
  return true;
}

async function replaceAppImage(downloadedPath, expectedHash, env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'linux') throw fail('UPDATE_PLATFORM_UNSUPPORTED', 'AppImage replacement is supported only on Linux.');
  const fileSystem = options.fileSystem || fs;
  const hashFile = options.fileHash || fileHash;
  const current = String(env.APPIMAGE || '');
  if (!path.isAbsolute(current) || !fileSystem.existsSync(current)) throw fail('UPDATE_APPIMAGE_PATH_UNAVAILABLE', 'The running AppImage path is unavailable. Replace it manually with the downloaded file.');
  fileSystem.accessSync(path.dirname(current), fs.constants.W_OK);
  const staged = path.join(path.dirname(current), `.${path.basename(current)}.new-${process.pid}`);
  const backup = `${current}.previous`;
  const backupStaged = `${backup}.new-${process.pid}`;
  fileSystem.rmSync(staged, { force: true });
  fileSystem.rmSync(backupStaged, { force: true });
  try {
    fileSystem.copyFileSync(downloadedPath, staged, fs.constants.COPYFILE_EXCL);
    fileSystem.chmodSync(staged, 0o755);
    if (await hashFile(staged) !== expectedHash) throw fail('UPDATE_STAGED_HASH_MISMATCH', 'The staged AppImage failed verification.');
    syncFile(staged, fileSystem);

    const currentHash = await hashFile(current);
    fileSystem.copyFileSync(current, backupStaged, fs.constants.COPYFILE_EXCL);
    fileSystem.chmodSync(backupStaged, 0o755);
    if (!currentHash || await hashFile(backupStaged) !== currentHash) {
      throw fail('UPDATE_BACKUP_HASH_MISMATCH', 'The previous AppImage backup failed verification.');
    }
    syncFile(backupStaged, fileSystem);
    fileSystem.renameSync(backupStaged, backup);
    syncDirectory(path.dirname(current), { platform, fileSystem });

    // Re-hash after all backup work and immediately before the atomic
    // replacement so a changed staged artifact can never be installed.
    if (await hashFile(staged) !== expectedHash) throw fail('UPDATE_STAGED_HASH_MISMATCH', 'The staged AppImage changed before replacement.');
    // POSIX rename atomically replaces the old AppImage, so a crash leaves
    // either the old executable or the verified new executable at `current`.
    fileSystem.renameSync(staged, current);
    syncDirectory(path.dirname(current), { platform, fileSystem });
  } catch (error) {
    fileSystem.rmSync(staged, { force: true });
    fileSystem.rmSync(backupStaged, { force: true });
    if (String(error?.code || '').startsWith('UPDATE_')) throw error;
    throw fail('UPDATE_APPIMAGE_REPLACE_FAILED', `The AppImage could not be replaced: ${error.message}`);
  }
  return current;
}

function detached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function installUpdate({
  app,
  shell,
  downloadedPath,
  update,
  currentVersion,
  platform = process.platform,
  beforeExit = () => {},
  launchDetached = detached,
  replaceAppImageImpl = replaceAppImage,
  confirmMacInstall = async () => false
}) {
  if (currentVersion && compareVersions(version(update.version), version(currentVersion)) <= 0) {
    throw fail('UPDATE_DOWNGRADE_BLOCKED', 'The normal update flow only installs a newer version.');
  }
  updateSecurity.verifyArtifact(downloadedPath, update.artifact);
  if (platform === 'win32') {
  beforeExit();
  const openError = await shell.openPath(downloadedPath);
  if (openError) {
    shell.showItemInFolder?.(downloadedPath);
    throw fail('UPDATE_WINDOWS_INSTALLER_OPEN_FAILED', `The verified Windows installer could not be opened: ${openError}`);
  }
  app.quit();
  return { installerOpened: true };
}
  if (platform === 'linux') {
    try {
      beforeExit();
      const executable = await replaceAppImageImpl(downloadedPath, update.artifact.sha256);
      beforeExit();
      launchDetached('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"', 'cpcr-update', String(process.pid), executable]);
      app.quit();
      return;
    } catch (error) {
      shell.showItemInFolder(downloadedPath);
      throw error;
    }
  }
  if (platform === 'darwin') {
    const openError = await shell.openPath(downloadedPath);
    if (openError) throw fail('UPDATE_DMG_OPEN_FAILED', `The verified disk image could not be opened: ${openError}`);
    const quitRequested = Boolean(await confirmMacInstall());
    if (quitRequested) {
      beforeExit();
      app.quit();
    }
    return { manualInstall: true, opened: true, quitRequested };
  }
  throw fail('UPDATE_PLATFORM_UNSUPPORTED', `Automatic updates are not supported on ${platform}.`);
}

function registerGithubReleaseUpdater({ app, ipcMain, registerIpcHandler, dialog, BrowserWindow, shell, isolated = false, source = UPDATE_SOURCE, operationCoordinator = defaultCoordinator, localeProvider = () => 'en-CA' }) {
  let busy = false;
  let activeDownload = null;
  const window = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const message = options => window() ? dialog.showMessageBox(window(), options) : dialog.showMessageBox(options);
  const emit = payload => {
    const target = window();
    if (!target || target.isDestroyed()) return;
    target.webContents.send('updates:progress', payload);
  };
  const progress = (value, title) => {
    const target = window();
    if (!target || target.isDestroyed()) return;
    target.setProgressBar(value);
    if (title) {
      target.__updateTitle ||= target.getTitle();
      target.setTitle(title);
    } else if (target.__updateTitle) {
      target.setTitle(target.__updateTitle);
      delete target.__updateTitle;
    }
  };
  const localized = (key, values = {}, fallback = '') => {
    const bundle = i18n.loadLocale(localeProvider());
    return i18n.interpolate(i18n.translate(bundle, key, fallback), values);
  };

  async function run() {
    if (busy) return { ok: false, error: localized('update.busy', {}, 'An update operation is already running.'), code: 'UPDATE_BUSY' };
    if (isolated) return { ok: false, error: localized('update.isolated', {}, 'Updates are disabled while isolated test data is active.') };
    if (!app.isPackaged && process.env.CPCR_ALLOW_DEV_UPDATE_TEST !== 'true') {
      await message({ type: 'info', title: localized('update.check', {}, 'Check for updates'), message: localized('update.packagedOnly', {}, 'Update checks are available only in a packaged build.'), buttons: [localized('action.ok', {}, 'OK')] });
      return { ok: false, error: localized('update.packagedRequired', {}, 'A packaged build is required.') };
    }
    busy = true;
    let current = '';
    try {
      current = app.getVersion();
      emit({ stage: 'checking', cancellable: false });
      progress(2, localized('update.window.checking', {}, 'Canada Post Claim Runner — Checking for updates…'));
      const update = await resolveUpdate({ source, currentVersion: current, platform: process.platform, arch: process.arch });
      progress(-1);
      emit({ stage: 'hidden' });
      if (!update.available) {
        await message({ type: 'info', title: localized('update.none.title', {}, "You're up to date"), message: localized('update.none.message', { version: current }, "You're up to date. Version {version} is the latest version."), buttons: [localized('action.ok', {}, 'OK')] });
        return { ok: true, available: false };
      }
      const choice = await message({
        type: 'info',
        title: localized('update.available.title', {}, 'Update available'),
        message: localized('update.available.message', { current, version: update.version }, 'Current version: {current}\nNew version: {version}'),
        detail: update.notes || localized('update.available.noNotes', {}, 'No release notes were provided.'),
        buttons: [localized('update.available.downloadInstall', {}, 'Download / Install Update'), localized('action.cancel', {}, 'Cancel')], defaultId: 0, cancelId: 1, noLink: true
      });
      if (choice.response !== 0) return { ok: true, available: true, deferred: true };

      activeDownload = new AbortController();
      emit({ stage: 'connecting', version: update.version, total: update.artifact.bytes, cancellable: true });
      progress(0, localized('update.window.connecting', {}, 'Canada Post Claim Runner — Connecting…'));
      const downloadedPath = await downloadUpdate(update, {
        app,
        userAgent: `Canada-Post-Claim-Runner/${current}`,
        signal: activeDownload.signal,
        onStage: stage => {
          emit({ stage, version: update.version, cancellable: false });
          progress(2, stage === 'verifying' ? localized('update.window.verifying', {}, 'Canada Post Claim Runner — Verifying update…') : undefined);
        },
        onProgress: snapshot => {
          emit({ stage: 'downloading', version: update.version, cancellable: true, ...snapshot });
          progress(snapshot.ratio, localized('update.window.downloading', { percent: Math.floor(snapshot.ratio * 100) }, 'Canada Post Claim Runner — Downloading {percent}%'));
        }
      });
      cleanupUpdateStorage(app.getPath('userData'), { keepRecent: 2, protectedPaths: [downloadedPath] });
      activeDownload = null;
      emit({ stage: 'preparing', version: update.version, cancellable: false });
      progress(2, localized('update.window.preparing', {}, 'Canada Post Claim Runner — Preparing installation…'));
      const userDataRoot = app.getPath('userData');
      const databasePath = claimDb.databasePathFor(userDataRoot);
      const backupDirectory = path.join(userDataRoot, 'database-backups');
      let installOutcome = null;
      const prepared = await updateInstallGuard.prepareInstall({
        coordinator: operationCoordinator,
        createBackup: async () => {
          if (!fs.statSync(databasePath, { throwIfNoEntry: false })?.isFile()) return '';
          fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const destination = path.join(backupDirectory, `app-pre-update-${current}-to-${update.version}-${stamp}.sqlite`);
          await claimDb.createDatabaseBackup(databasePath, destination);
          return destination;
        },
        createMarker: backupPath => updateInstallGuard.createPendingMarker({
          userDataRoot,
          oldVersion: current,
          targetVersion: update.version,
          backupPath,
          downloadedPath,
          previousExecutable: process.platform === 'linux' && process.env.APPIMAGE ? `${process.env.APPIMAGE}.previous` : ''
        }),
        install: async () => {
          installOutcome = await installUpdate({
            app,
            shell,
            downloadedPath,
            update,
            currentVersion: current,
            beforeExit: () => operationCoordinator.assertInactive(),
            confirmMacInstall: async () => {
              const choice = await message({
                type: 'info',
                title: localized('update.mac.title', {}, 'Verified macOS update opened'),
                message: localized('update.mac.message', {}, 'Replace Canada Post Claim Runner in Applications.'),
                detail: localized('update.mac.detail', {}, 'The verified disk image is open. Drag Canada Post Claim Runner to Applications and approve replacing the existing copy. The running application will not replace its own .app bundle.'),
                buttons: [localized('update.mac.quit', {}, 'Quit for installation'), localized('update.mac.keepOpen', {}, 'Keep app open')],
                defaultId: 0,
                cancelId: 1,
                noLink: true
              });
              return choice.response === 0;
            }
          });
        }
      });
      if (!prepared.ok) {
        const operationCode = prepared.error?.operation || 'unknown';
        const operation = localized(`operation.${operationCode}`, {}, operationCode);
        await message({
          type: 'warning',
          title: localized('update.blocked.title', {}, 'Update installation blocked'),
          message: localized('update.blocked.message', { operation }, 'Installation cannot continue while {operation} is active.'),
          detail: localized('update.blocked.recovery', {}, 'The verified download was kept and can be installed after the operation finishes.'),
          buttons: [localized('action.continue', {}, 'Continue')],
          noLink: true
        });
        emit({ stage: 'hidden' });
        return { ok: false, available: true, downloaded: true, blocked: true, operation: operationCode, code: 'PROTECTED_OPERATION_ACTIVE' };
      }
      if (installOutcome?.manualInstall) {
        return { ok: true, available: true, installing: installOutcome.quitRequested, manualInstall: true, dmgOpened: true };
      }
      return { ok: true, available: true, installing: true };
    } catch (error) {
      activeDownload = null;
      progress(-1);
      emit({ stage: 'hidden' });
      if (error.code === 'UPDATE_DOWNLOAD_CANCELLED') {
        return { ok: false, cancelled: true, error: error.message, code: error.code };
      }
      const detail = error.code === 'UPDATE_REPOSITORY_NOT_READY'
        ? localized('update.failed.repositoryNotReady', {}, 'No stable release is available yet.')
        : error.message;
      await message({
        type: 'error',
        title: localized('update.failed.title', {}, 'Update failed'),
        message: localized('update.failed.message', {}, 'The update could not be completed.'),
        detail: `${detail}\n\n${localized('update.failed.code', { code: error.code || 'UPDATE_FAILED' }, 'Error code: {code}')}`,
        buttons: [localized('action.continue', {}, 'Continue')],
        noLink: true
      });
      return { ok: false, error: detail, code: error.code || 'UPDATE_FAILED' };
    } finally {
      activeDownload = null;
      progress(-1);
      busy = false;
    }
  }

  const register = typeof registerIpcHandler === 'function'
    ? registerIpcHandler
    : (channel, handler) => ipcMain.handle(channel, handler);
  register('updates:open', () => run());
  register('updates:cancel', () => {
    if (!activeDownload || activeDownload.signal.aborted) return { ok: false, cancelled: false };
    activeDownload.abort();
    return { ok: true, cancelled: true };
  });
  return { run };
}

module.exports = {
  UPDATE_SOURCE,
  version,
  githubUrl,
  fetchGithub,
  apiUrl,
  platformName,
  expectedArtifactName,
  assetDigest,
  validateLatestRelease,
  resolveUpdate,
  progressSnapshot,
  downloadUpdate,
  cleanupUpdateStorage,
  fileHash,
  syncFile,
  syncDirectory,
  replaceAppImage,
  installUpdate,
  registerGithubReleaseUpdater
};
