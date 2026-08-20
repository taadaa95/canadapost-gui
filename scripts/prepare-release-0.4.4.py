from pathlib import Path
import json

OLD = '0.4.3'
NEW = '0.4.4'


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def replace_exact(path, old, new):
    text = read(path)
    if old not in text:
        if new in text:
            return
        raise SystemExit(f'{path}: expected anchor not found')
    write(path, text.replace(old, new, 1))


def replace_span(path, start, end, replacement):
    text = read(path)
    if replacement in text:
        return
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f'{path}: start anchor not found')
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f'{path}: end anchor not found')
    end_index += len(end)
    write(path, text[:start_index] + replacement + text[end_index:])


pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
if pkg.get('version') not in (OLD, NEW):
    raise SystemExit(f'package.json: unexpected version {pkg.get("version")!r}')
pkg['version'] = NEW
appimage_script = pkg.get('scripts', {}).get('test:packaged-isolated-appimage', '')
pkg['scripts']['test:packaged-isolated-appimage'] = appimage_script.replace(
    f'Canada.Post.Claim.Runner-{OLD}-linux-x86_64.AppImage',
    f'Canada.Post.Claim.Runner-{NEW}-linux-x86_64.AppImage'
)
pkg_path.write_text(json.dumps(pkg, indent=2) + '\n', encoding='utf-8')

lock_path = Path('package-lock.json')
lock = json.loads(lock_path.read_text(encoding='utf-8'))
if lock.get('version') not in (OLD, NEW):
    raise SystemExit(f'package-lock.json: unexpected version {lock.get("version")!r}')
lock['version'] = NEW
root_pkg = lock.get('packages', {}).get('')
if not isinstance(root_pkg, dict):
    raise SystemExit('package-lock.json: root package entry missing')
if root_pkg.get('version') not in (OLD, NEW):
    raise SystemExit(f'package-lock.json: unexpected root package version {root_pkg.get("version")!r}')
root_pkg['version'] = NEW
lock_path.write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')

replace_exact(
    'tests/github-release-updater-test.js',
    "assert.strictEqual(require('../package.json').version, '0.4.3');",
    "assert.strictEqual(require('../package.json').version, '0.4.4');"
)
replace_exact(
    'tests/release-metadata-contract-test.js',
    "const VERSION = '0.4.3';",
    "const VERSION = '0.4.4';"
)
replace_exact(
    'tests/ui-contract-test.js',
    "assert.strictEqual(pkg.version, '0.4.3');",
    "assert.strictEqual(pkg.version, '0.4.4');"
)

# The old Electron E2E still treated tracking as a standalone UI tab. Keep the
# test coverage, but point it at the combined Step 1 surface and the claim step.
e2e_path = 'tests/electron-e2e-test.js'
replace_exact(
    e2e_path,
    "  const frenchMessages = loadLocale('fr-CA', root).messages;",
    "  const englishMessages = loadLocale('en-CA', root).messages;\n  const frenchMessages = loadLocale('fr-CA', root).messages;"
)
replace_exact(
    e2e_path,
    """    const primaryTabs = [
      ['tabSettings', 'settingsTab'], ['tabStep1', 'step1'], ['tabStep2', 'step2'],
      ['tabStep3', 'step3'], ['tabHistory', 'historyTab'], ['tabResults', 'resultsTab']
    ];""",
    """    const primaryTabs = [
      ['tabSettings', 'settingsTab'], ['tabStep1', 'step1'],
      ['tabStep3', 'step3'], ['tabHistory', 'historyTab'], ['tabResults', 'resultsTab']
    ];"""
)

french_start = """    await assertFrenchKeys([
      'step1.title', 'step1.createsTrackingCsv'"""
french_end = """    assert.match(await window.locator('#step2CurrentAction').textContent(), /défaillance systémique de l’intégration/);"""
french_replacement = """    await assertFrenchKeys([
      'step1.title', 'step1.simpleDescription', 'step1.start', 'step1.stop',
      'step1.statusTitle', 'runStatus.idle', 'step1.shipmentsImported', 'step1.checkedImported',
      'step2.lateClaims', 'step1.warningsInspect', 'step1.importProgress', 'step1.identifyProgress',
      'status.waiting', 'step1.liveLog'
    ]);
    assert.strictEqual(await window.locator('#step1WarningsCard').getAttribute('aria-label'), frenchMessages['step1.warningsAria']);
    assert.strictEqual(await window.locator('#importEstHistory').textContent(), frenchMessages['step1.start']);
    assert.strictEqual(await window.locator('#forceStopStep1').textContent(), frenchMessages['step1.stop']);
    assert.strictEqual(await window.locator('#tabStep2').count(), 0, 'standalone tracking tab must remain removed');
    assert.strictEqual(await window.locator('#runTrackingOnly').count(), 0, 'standalone tracking run control must remain removed');
    assert.strictEqual(await window.locator('#forceStopStep2').count(), 0, 'standalone tracking stop control must remain removed');
    assert.strictEqual(await window.locator('#runSiteHealth').count(), 0, 'manual workflow health-check button must be removed');
    assert.strictEqual(await window.locator('#siteHealthResult').count(), 0, 'standalone workflow health-check result must be removed');
    const emptyHistoryToolbars = await window.evaluate(() => [...document.querySelectorAll('#historyTab .history-toolbar')]
      .filter(element => !element.querySelector('button, input, select, textarea, [role=\"status\"]')).length);
    assert.strictEqual(emptyHistoryToolbars, 0, 'health-check removal must not leave an empty History toolbar');
    assert.strictEqual(await window.locator('#resultsList .ops-head').textContent(), 'HeureLigneSuiviRésultatDétailsPreuve');
    await window.evaluate(() => window.renderClaimQueue([{
      recordId: 8001, evidenceHash: '8'.repeat(64), trackingNumber: 'FRENCH0000000001', referenceNumber: 'REF-FR',
      serviceCode: 'DOM.EP', firstAttemptDate: '2026-07-20', deliveryDate: '2026-07-21', deadline: '2026-09-01',
      deadlineState: 'known_active', businessDaysRemaining: 24, eligibilityReason: 'Synthetic localized candidate'
    }]));
    assert((await window.locator('#claimQueueList .claim-queue-row.header').textContent()).includes('Suivi'));
    assert((await window.locator('#claimQueueList .claim-queue-row.header').textContent()).includes('livraison réussie'));
    await window.evaluate(() => window.renderHistory([{ trackingNumber: 'FRENCH0000000001', attemptedAt: '2026-07-21T12:00:00Z', status: 'submitted', confirmationNumber: 'CONFIRMATION', message: '' }]));
    assert((await window.locator('#historyList .history-row.head').textContent()).includes('Heure de la tentative'));
    assert((await window.locator('#historyList .history-row:not(.head)').textContent()).includes('Soumise'));
    const dynamicFrench = await window.evaluate(() => {
      const tracking = window.describeEvent('tracking', { type: 'tracking_start', total: 1, requestIntervalMs: 3100, jitterMaxMs: 100 });
      window.setStatus('Running', 'warn', 'step1');
      window.setActionLocalized('step1.exportStarting', {}, '', 'step1');
      window.UpdateProgress.render(document, { stage: 'checking' }, key => window.tr(key), () => {});
      const result = {
        tracking,
        step1: {
          status: document.getElementById('step1RunStatus').textContent,
          action: document.getElementById('step1CurrentAction').textContent
        },
        updater: document.getElementById('updateProgressTitle').textContent,
        updaterStage: document.getElementById('updateProgressStage').textContent
      };
      window.UpdateProgress.render(document, { stage: 'hidden' }, key => window.tr(key), () => {});
      return result;
    });
    assert(dynamicFrench.tracking.startsWith('Étape de suivi démarrée.'));
    assert.strictEqual(dynamicFrench.step1.status, frenchMessages['runStatus.running']);
    assert.strictEqual(dynamicFrench.step1.action, frenchMessages['step1.exportStarting']);
    assert.strictEqual(dynamicFrench.updater, 'Mise à jour de l’application');
    assert.strictEqual(dynamicFrench.updaterStage, 'Vérification des versions GitHub…');
    const localizedStates = await window.evaluate(() => {
      const result = {};
      for (const [label, key] of [
        ['Running', 'running'], ['Complete', 'complete'], ['Failed', 'failed'], ['Blocked', 'blocked'], ['Stopped', 'stopped']
      ]) {
        window.setStatus(label, '', 'step1');
        result[key] = document.getElementById('step1RunStatus').textContent;
      }
      return result;
    });
    for (const [state, key] of [
      ['running', 'runStatus.running'], ['complete', 'runStatus.complete'], ['failed', 'runStatus.failed'],
      ['blocked', 'runStatus.blocked'], ['stopped', 'runStatus.stopped']
    ]) assert.strictEqual(localizedStates[state], frenchMessages[key]);"""
replace_span(e2e_path, french_start, french_end, french_replacement)

english_start = """    assert.strictEqual(await window.locator('#importEstHistory').textContent(), 'Run Step 1 — Import Shipment History');"""
english_end = """    assert.match(await window.locator('#step2CurrentAction').textContent(), /systemic integration failure/,
      'visible dynamic status text must be regenerated immediately after a language switch');"""
english_replacement = """    assert.strictEqual(await window.locator('#importEstHistory').textContent(), englishMessages['step1.start']);
    assert.strictEqual(await window.locator('#forceStopStep1').textContent(), englishMessages['step1.stop']);
    assert.strictEqual(await window.locator('#step1CurrentAction').textContent(), englishMessages['step1.exportStarting'],
      'visible Step 1 dynamic status text must be regenerated immediately after a language switch');
    assert.strictEqual(await window.locator('#tabStep2').count(), 0);
    assert.strictEqual(await window.locator('#runTrackingOnly').count(), 0);
    assert.strictEqual(await window.locator('#forceStopStep2').count(), 0);"""
replace_span(e2e_path, english_start, english_end, english_replacement)

notes_path = Path('RELEASE_NOTES.md')
notes = notes_path.read_text(encoding='utf-8')
heading = '## Canada Post Claim Runner 0.4.4 — workflow simplification and Windows shutdown fix'
if heading not in notes:
    prefix = """# Release notes\n\n## Canada Post Claim Runner 0.4.4 — workflow simplification and Windows shutdown fix\n\n- Prevents the Windows `Object has been destroyed` JavaScript error when closing Claim Runner after a successful claim submission by making built-in browser shutdown idempotent and safe after Electron has already destroyed the native browser object.\n- Adds a Windows browser-lifecycle regression contract for the close-after-submission path.\n- Simplifies the customer workflow to two visible steps: shipment-history import automatically continues into Tracking API classification, followed by claim submission.\n- Simplifies Settings and saved-credential presentation while preserving encrypted credential storage and existing security boundaries.\n- Keeps saved credentials masked in the UI and retains the guided Canada Post Setup persistence fixes from 0.4.3.\n- Makes Windows update installation launch the downloaded installer visibly instead of appearing to do nothing.\n- Retains database schema version 8.\n\n"""
    if not notes.startswith('# Release notes\n\n'):
        raise SystemExit('RELEASE_NOTES.md: unexpected heading')
    notes = prefix + notes[len('# Release notes\n\n'):]
notes = notes.replace('See `OPERATING_GUIDE.md` for the current 0.4.3 candidate.', 'See `OPERATING_GUIDE.md` for the current 0.4.4 candidate.')
notes_path.write_text(notes, encoding='utf-8')

release_doc = Path('docs/RELEASE_V0.4.4.md')
if not release_doc.exists():
    release_doc.write_text("""# Canada Post Claim Runner 0.4.4\n\nVersion 0.4.4 is the workflow-simplification and Windows shutdown-reliability release.\n\n- The customer-facing workflow is reduced to two steps, with tracking classification automatically following shipment-history import.\n- Saved credentials remain masked and Settings is simplified without weakening encrypted storage.\n- Windows update installation launches the downloaded installer visibly.\n- Closing the app after a successful claim no longer queries or destroys an already-destroyed Electron browser object.\n- Windows lifecycle regression coverage protects the shutdown fix.\n- Database schema remains version 8.\n\nCanonical release candidates:\n\n- Linux x64: `Canada.Post.Claim.Runner-0.4.4-linux-x86_64.AppImage`\n- Windows x64: `Canada.Post.Claim.Runner-0.4.4-win-x64.exe`\n\nThe exact public binaries must come from the reviewed 0.4.4 canonical release source commit and pass the existing automated release checks.\n""", encoding='utf-8')

for path in [
    'OPERATING_GUIDE.md',
    'MANUAL_RELEASE_GATES.md',
    'docs/GITHUB_UPDATES.md',
    'docs/LIFECYCLE_AND_PLATFORMS.md',
    'docs/MACOS_DISTRIBUTION.md',
]:
    p = Path(path)
    if p.exists():
        text = p.read_text(encoding='utf-8')
        if OLD in text:
            p.write_text(text.replace(OLD, NEW), encoding='utf-8')

readme_path = Path('README.md')
readme = readme_path.read_text(encoding='utf-8')
old_intro = 'Current public stable version: **0.4.2** for Linux x64 and Windows x64. Version **0.4.3** is the next release candidate and remains unpublished until the exact canonical packages are validated.'
new_intro = 'Current public stable version: **0.4.3** for Linux x64 and Windows x64. Version **0.4.4** is the next release candidate and remains unpublished until the exact canonical packages are validated.'
if old_intro in readme:
    readme = readme.replace(old_intro, new_intro, 1)
elif new_intro not in readme:
    raise SystemExit('README.md: current-version introduction anchor not found')
readme_path.write_text(readme, encoding='utf-8')

print('Prepared source metadata and two-step E2E contracts for Canada Post Claim Runner 0.4.4')
