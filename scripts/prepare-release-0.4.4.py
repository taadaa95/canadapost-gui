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
        raise SystemExit(f'{path}: expected release-version anchor not found')
    write(path, text.replace(old, new, 1))


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
readme = readme.replace('current 0.4.3', 'current 0.4.4').replace('version 0.4.3', 'version 0.4.4').replace('Version 0.4.3', 'Version 0.4.4')
readme_path.write_text(readme, encoding='utf-8')

print('Prepared source metadata for Canada Post Claim Runner 0.4.4')
