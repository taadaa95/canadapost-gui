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
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(result)) throw fail('UPDATE_VERSION_INVALID', 'The update version is invalid.');
  return result;
}

function channelFor(currentVersion) {
  return version(currentVersion).includes('-') ? 'beta' : 'stable';
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
  const owner = String(source.owner || '');
  const repository = String(source.repository || '');
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repository)) throw fail('UPDATE_SOURCE_INVALID', 'The bundled update source is invalid.');
  return `https://api.github.com/repos/${owner}/${repository}/releases?per_page=20`;
}

function selectRelease(releases, currentVersion, channel = channelFor(currentVersion)) {
  const current = version(currentVersion);
  return (Array.isArray(releases) ? releases : [])
    .filter(item => item && !item.draft && (channel === 'beta' ? item.prerelease === true : !item.prerelease))
    .map(item => {
      try { return { release: item, version: version(item.tag_name || item.name) }; }
      catch (_) { return null; }
    })
    .filter(item => item && compareVersions(item.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0] || null;
}

function platformName(platform = process.platform) {
  if (platform === 'win32' || platform === 'windows') return 'windows';
  if (platform === 'linux') return 'linux';
  throw fail('UPDATE_PLATFORM_UNSUPPORTED', `Automatic updates are not supported on ${platform}.`);
}

function manifestName(source = UPDATE_SOURCE, platform = process.platform) {
  const name = source.manifestAssets?.[platformName(platform)];
  if (!name || path.basename(name) !== name) throw fail('UPDATE_SOURCE_INVALID', 'The platform update manifest is not configured safely.');
  return name;
}

function asset(release, name) {
  return (Array.isArray(release?.assets) ? release.assets : []).find(item => item?.name === name) || null;
}

async function json(url, fetchImpl = globalThis.fetch, userAgent = 'Canada-Post-Claim-Runner-Updater') {
  const requested = githubUrl(url);
  const response = await fetchImpl(requested, {
    redirect: 'follow',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': userAgent
    }
  });
  githubUrl(response.url || requested, 'Final update URL');
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

function validateManifest(input, expectedVersion, currentChannel, options = {}) {
  try {
    return updateSecurity.verifySignedManifest(input, {
      publicKey: options.publicKey,
      expectedVersion: version(expectedVersion),
      expectedPublishedAt: options.expectedPublishedAt,
      currentVersion: options.currentVersion,
      channel: currentChannel,
      platform: platformName(options.platform),
      architecture: options.arch || process.arch
    });
  } catch (error) {
    throw fail('UPDATE_MANIFEST_UNTRUSTED', error.message);
  }
}

function selectArtifact(manifest, platform = process.platform, arch = process.arch) {
  if (arch !== 'x64') throw fail('UPDATE_ARCH_UNSUPPORTED', `Automatic updates are not supported on ${arch}.`);
  const extension = platform === 'win32' || platform === 'windows' ? '.exe' : platform === 'linux' ? '.AppImage' : '';
  if (!extension) throw fail('UPDATE_PLATFORM_UNSUPPORTED', `Automatic updates are not supported on ${platform}.`);
  if (manifest.platform !== platformName(platform) || manifest.architecture !== arch) throw fail('UPDATE_ARTIFACT_PLATFORM_MISMATCH', 'The signed update package targets a different platform or architecture.');
  const result = manifest.artifact;
  const name = String(result?.file || '').toLowerCase();
  const platformToken = platform === 'win32' || platform === 'windows' ? 'win' : 'linux';
  const architectureToken = platformToken === 'linux' ? 'x86_64' : 'x64';
  const expectedName = `Canada.Post.Claim.Runner-${manifest.applicationVersion}-${platformToken}-${architectureToken}-${manifest.channel}${extension}`;
  if (result.file !== expectedName || !name.endsWith(extension.toLowerCase()) || path.basename(result.file) !== result.file) {
    throw fail('UPDATE_ARTIFACT_PLATFORM_MISMATCH', 'The signed update package filename does not match this platform or architecture.');
  }
  const bytes = Number(result.bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ARTIFACT_BYTES) throw fail('UPDATE_ARTIFACT_SIZE_INVALID', 'The update package size is invalid.');
  if (!/^[a-f0-9]{64}$/i.test(String(result.sha256 || ''))) throw fail('UPDATE_ARTIFACT_HASH_INVALID', 'The update package SHA-256 is invalid.');
  return { ...result, bytes, sha256: result.sha256.toLowerCase() };
}

async function resolveUpdate(options = {}) {
  const source = options.source || UPDATE_SOURCE;
  const publicKey = options.publicKey ?? source.trustedPublicKeyEd25519;
  try { updateSecurity.trustedEd25519Key(publicKey); }
  catch (error) { throw fail('UPDATE_TRUST_NOT_CONFIGURED', error.message); }
  const currentVersion = version(options.currentVersion);
  const currentChannel = options.channel || channelFor(currentVersion);
  const userAgent = options.userAgent || `Canada-Post-Claim-Runner/${currentVersion}`;
  const releases = await json(apiUrl(source), options.fetchImpl, userAgent);
  const selected = selectRelease(releases, currentVersion, currentChannel);
  if (!selected) return { available: false, currentVersion, channel: currentChannel };

  const manifestAsset = asset(selected.release, manifestName(source, options.platform));
  if (!manifestAsset) throw fail('UPDATE_MANIFEST_MISSING', 'The GitHub Release is missing its platform manifest.');
  const manifest = validateManifest(await json(manifestAsset.browser_download_url, options.fetchImpl, userAgent), selected.version, currentChannel, {
    publicKey,
    currentVersion,
    expectedPublishedAt: selected.release.published_at,
    platform: options.platform,
    arch: options.arch
  });
  const artifact = selectArtifact(manifest, options.platform, options.arch);
  const releaseAsset = asset(selected.release, artifact.file);
  if (!releaseAsset) throw fail('UPDATE_ASSET_MISSING', `The GitHub Release is missing ${artifact.file}.`);
  if (Number(releaseAsset.size) !== artifact.bytes) throw fail('UPDATE_ASSET_SIZE_MISMATCH', 'The GitHub asset size does not match the manifest.');
  if (releaseAsset.digest && String(releaseAsset.digest).toLowerCase() !== `sha256:${artifact.sha256}`) {
    throw fail('UPDATE_ASSET_DIGEST_MISMATCH', 'The GitHub asset digest does not match the manifest.');
  }
  githubUrl(releaseAsset.browser_download_url, 'Update package URL');
  return {
    available: true,
    version: selected.version,
    release: selected.release,
    artifact,
    manifest,
    releaseAsset,
    channel: currentChannel,
    notes: String(selected.release.body || '').replace(/\r/g, '').slice(0, 3500)
  };
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
    response = await (options.fetchImpl || globalThis.fetch)(requested, {
      redirect: 'follow',
      headers: { Accept: 'application/octet-stream', 'User-Agent': options.userAgent },
      signal: options.signal
    });
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError') throw fail('UPDATE_DOWNLOAD_CANCELLED', 'The update download was cancelled.');
    throw error;
  }
  githubUrl(response.url || requested, 'Final update package URL');
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
      } else if (/\.(?:AppImage|exe)$/i.test(entry.name) && !protectedPaths.has(path.resolve(target))) {
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

async function replaceAppImage(downloadedPath, expectedHash, env = process.env) {
  const current = String(env.APPIMAGE || '');
  if (!path.isAbsolute(current) || !fs.existsSync(current)) throw fail('UPDATE_APPIMAGE_PATH_UNAVAILABLE', 'The running AppImage path is unavailable. Replace it manually with the downloaded file.');
  fs.accessSync(path.dirname(current), fs.constants.W_OK);
  const staged = path.join(path.dirname(current), `.${path.basename(current)}.new-${process.pid}`);
  const backup = `${current}.previous`;
  fs.rmSync(staged, { force: true });
  fs.copyFileSync(downloadedPath, staged, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(staged, 0o755);
  if (await fileHash(staged) !== expectedHash) throw fail('UPDATE_STAGED_HASH_MISMATCH', 'The staged AppImage failed verification.');
  fs.rmSync(backup, { force: true });
  try {
    fs.renameSync(current, backup);
    fs.renameSync(staged, current);
  } catch (error) {
    if (!fs.existsSync(current) && fs.existsSync(backup)) fs.renameSync(backup, current);
    fs.rmSync(staged, { force: true });
    throw fail('UPDATE_APPIMAGE_REPLACE_FAILED', `The AppImage could not be replaced: ${error.message}`);
  }
  return current;
}

function detached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function installUpdate({ app, shell, downloadedPath, update, platform = process.platform, beforeExit = () => {} }) {
  if (platform === 'win32') {
    beforeExit();
    const escaped = downloadedPath.replace(/'/g, "''");
    const script = `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; Start-Process -FilePath '${escaped}'`;
    detached('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
    app.quit();
    return;
  }
  if (platform === 'linux') {
    try {
      beforeExit();
      const executable = await replaceAppImage(downloadedPath, update.artifact.sha256);
      beforeExit();
      detached('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2"', 'cpcr-update', String(process.pid), executable]);
      app.quit();
      return;
    } catch (error) {
      shell.showItemInFolder(downloadedPath);
      throw error;
    }
  }
  throw fail('UPDATE_PLATFORM_UNSUPPORTED', `Automatic updates are not supported on ${platform}.`);
}

function registerGithubReleaseUpdater({ app, ipcMain, dialog, BrowserWindow, shell, isolated = false, source = UPDATE_SOURCE, operationCoordinator = defaultCoordinator, localeProvider = () => 'en-CA' }) {
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
    if (busy) return { ok: false, error: 'An update operation is already running.', code: 'UPDATE_BUSY' };
    if (isolated) return { ok: false, error: 'Updates are disabled while isolated test data is active.' };
    if (!app.isPackaged && process.env.CPCR_ALLOW_DEV_UPDATE_TEST !== 'true') {
      await message({ type: 'info', title: 'Check for updates', message: 'Update checks are available only in a packaged build.', buttons: ['OK'] });
      return { ok: false, error: 'A packaged build is required.' };
    }
    busy = true;
    try {
      const current = app.getVersion();
      emit({ stage: 'checking', cancellable: false });
      progress(2, 'Canada Post Claim Runner — Checking for updates…');
      const update = await resolveUpdate({ source, currentVersion: current, platform: process.platform, arch: process.arch });
      progress(-1);
      emit({ stage: 'hidden' });
      if (!update.available) {
        await message({ type: 'info', title: 'No update available', message: `Version ${current} is up to date.`, buttons: ['OK'] });
        return { ok: true, available: false };
      }
      const choice = await message({
        type: 'info',
        title: 'Update available',
        message: `Version ${update.version} is available.`,
        detail: `${update.notes || 'No release notes were provided.'}\n\nSource: GitHub Releases (${source.owner}/${source.repository})`,
        buttons: ['Download update', 'Later', 'Open release page'], defaultId: 0, cancelId: 1, noLink: true
      });
      if (choice.response === 2) {
        await shell.openExternal(githubUrl(update.release.html_url, 'Release page').toString());
        return { ok: true, available: true, deferred: true };
      }
      if (choice.response !== 0) return { ok: true, available: true, deferred: true };

      activeDownload = new AbortController();
      emit({ stage: 'connecting', version: update.version, total: update.artifact.bytes, cancellable: true });
      progress(0, 'Canada Post Claim Runner — Connecting…');
      const downloadedPath = await downloadUpdate(update, {
        app,
        userAgent: `Canada-Post-Claim-Runner/${current}`,
        signal: activeDownload.signal,
        onStage: stage => {
          emit({ stage, version: update.version, cancellable: false });
          progress(2, stage === 'verifying' ? 'Canada Post Claim Runner — Verifying update…' : undefined);
        },
        onProgress: snapshot => {
          emit({ stage: 'downloading', version: update.version, cancellable: true, ...snapshot });
          progress(snapshot.ratio, `Canada Post Claim Runner — Downloading ${Math.floor(snapshot.ratio * 100)}%`);
        }
      });
      cleanupUpdateStorage(app.getPath('userData'), { keepRecent: 2, protectedPaths: [downloadedPath] });
      activeDownload = null;
      progress(-1);
      emit({ stage: 'ready', version: update.version, cancellable: false });
      const install = await message({
        type: 'warning',
        title: localized('update.ready.title', {}, 'Update ready'),
        message: localized('update.ready.message', { version: update.version }, 'Version {version} was downloaded and verified.'),
        detail: localized('update.ready.detail', {}, 'Save your work before installing. Active protected operations are checked automatically.'),
        buttons: [localized('update.ready.install', {}, 'Install update'), localized('update.ready.later', {}, 'Later'), localized('update.ready.show', {}, 'Show downloaded file')],
        defaultId: 1, cancelId: 1, noLink: true
      });
      if (install.response === 2) {
        shell.showItemInFolder(downloadedPath);
        emit({ stage: 'hidden' });
        return { ok: true, available: true, downloaded: true };
      }
      if (install.response !== 0) {
        emit({ stage: 'hidden' });
        return { ok: true, available: true, downloaded: true, deferred: true };
      }
      emit({ stage: 'preparing', version: update.version, cancellable: false });
      progress(2, 'Canada Post Claim Runner — Preparing installation…');
      const userDataRoot = app.getPath('userData');
      const databasePath = claimDb.databasePathFor(userDataRoot);
      const backupDirectory = path.join(userDataRoot, 'database-backups');
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
        install: () => installUpdate({
          app,
          shell,
          downloadedPath,
          update,
          beforeExit: () => operationCoordinator.assertInactive()
        })
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
      return { ok: true, available: true, installing: true };
    } catch (error) {
      activeDownload = null;
      progress(-1);
      emit({ stage: 'hidden' });
      if (error.code === 'UPDATE_DOWNLOAD_CANCELLED') {
        return { ok: false, cancelled: true, error: error.message, code: error.code };
      }
      const detail = error.code === 'UPDATE_REPOSITORY_NOT_READY'
        ? 'Create and publish the public repository taadaa95/canadapost-claim-runner-releases before using updates.'
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

  ipcMain.removeHandler('updates:open');
  ipcMain.removeHandler('updates:cancel');
  ipcMain.handle('updates:open', run);
  ipcMain.handle('updates:cancel', () => {
    if (!activeDownload || activeDownload.signal.aborted) return { ok: false, cancelled: false };
    activeDownload.abort();
    return { ok: true, cancelled: true };
  });
  return { run };
}

module.exports = {
  UPDATE_SOURCE,
  version,
  channelFor,
  githubUrl,
  apiUrl,
  selectRelease,
  platformName,
  manifestName,
  validateManifest,
  selectArtifact,
  resolveUpdate,
  progressSnapshot,
  downloadUpdate,
  cleanupUpdateStorage,
  fileHash,
  replaceAppImage,
  installUpdate,
  registerGithubReleaseUpdater
};
