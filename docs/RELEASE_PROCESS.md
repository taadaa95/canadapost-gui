# Safe release process

Release builds never recursively archive the repository. Source archives use the explicit `config/release-allowlist.json` allowlist, require a clean Git worktree, materialize a temporary staging directory, scan for prohibited content and likely secrets, create a content manifest and SHA-256 checksum, extract the result, and repeat the audit.

For a reviewed clean commit:

```bash
npm ci
npm test
npm run secret-scan
npm run release:audit
npm run release:safe
RELEASE_CHANNEL=beta npm run release:package
```

`release:package` creates a fresh temporary Git materialization, installs locked dependencies, reruns tests, and builds the Linux AppImage. CI builds the Windows NSIS target on Windows. Production packages use Electron's built-in browser and must not contain Playwright browser binaries. Developer unpacked builds use `npm run package:dir` and are visibly unsigned development artifacts.

Generated metadata includes a CycloneDX 1.6 JSON SBOM, dependency licence inventory, an explicitly `.unsigned.json` canonical update-manifest candidate, and SHA-256 checksums. Windows code signing, offline Ed25519 manifest signing, signed-manifest verification, and publishing are separate manual gates; private keys and publishing credentials must never be stored in the repository or CI artifacts. See `docs/GITHUB_UPDATES.md` for the exact signing handoff.
