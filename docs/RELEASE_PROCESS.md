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

`release:package` creates a fresh temporary Git materialization, installs locked dependencies and the Playwright Chromium runtime there, reruns tests, and builds the Linux AppImage. CI builds the Windows NSIS target on Windows. Developer unpacked builds use `npm run package:dir` and are visibly unsigned development artifacts.

Generated metadata includes a CycloneDX 1.6 JSON SBOM, dependency licence inventory, package manifest, and SHA-256 checksums. Production signing and publishing are separate manual gates; private keys and publishing credentials must never be stored in the repository.
