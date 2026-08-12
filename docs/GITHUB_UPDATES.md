# GitHub Releases updates

Canada Post Claim Runner uses one stable release stream in the public repository:

```text
taadaa95/canadapost-claim-runner-releases
```

The installed application contains no GitHub token and accepts no renderer-configurable update URL. **Check for Updates** calls:

```text
GET /repos/taadaa95/canadapost-claim-runner-releases/releases/latest
```

GitHub Latest excludes drafts and prereleases. The updater also rejects either flag if returned unexpectedly. It compares the release tag with the runtime version using semantic, prerelease-aware ordering, so an internal runtime such as `0.4.0-beta.1` or `0.4.0-dev.10` is older than stable `0.4.0`.

## Trust model

The updater requires all of the following:

- release metadata from the configured repository's GitHub API endpoint;
- approved HTTPS GitHub API, release, redirect, and asset hosts;
- a version strictly newer than the running version;
- supported platform architecture (Linux x64, Windows x64, or macOS x64/arm64 using the universal package);
- the exact stable filename for that version and platform;
- a positive bounded size from GitHub release-asset metadata;
- a GitHub asset `digest` matching `sha256:<64 hex characters>`;
- an exact downloaded byte count and computed SHA-256 match;
- a final size/SHA-256 check before executable replacement.

No custom manifest, release channel, Ed25519 key, or application-specific signature is used.

## Publishing a stable update

1. Set `package.json` to the next normal semantic version, such as `0.4.1`.
2. Run the complete automated suite and build from the reviewed clean source commit.
3. Verify `dist/release-metadata/SHA256SUMS.txt`, internal provenance, and `releases/v<version>.json`.
4. Complete manual validation on every exact AppImage, Windows installer, and DMG that will be uploaded.
5. Create a non-draft, non-prerelease GitHub Release named `Canada Post Claim Runner <version>` with tag `v<version>`.
6. Upload only the platform binaries being published and one `SHA256SUMS.txt` covering them.
7. Confirm GitHub reports a SHA-256 digest for every binary asset before declaring the release ready.

Stable 0.4.0 publishes Linux x64 and Windows x64 binaries, their legacy Dev 10 compatibility manifests, and one checksum file:

- `Canada.Post.Claim.Runner-0.4.0-linux-x86_64.AppImage`
- `Canada.Post.Claim.Runner-0.4.0-win-x64.exe`
- `package-manifest-linux.json`
- `package-manifest-windows.json`
- `SHA256SUMS.txt`

Version 0.4.1 must not be published until Kris approves the exact three-platform set:

- `Canada.Post.Claim.Runner-0.4.1-linux-x86_64.AppImage`
- `Canada.Post.Claim.Runner-0.4.1-win-x64.exe`
- `Canada.Post.Claim.Runner-0.4.1-mac-universal.dmg`

SBOM, licence inventory, provenance, and package-audit reports remain internal metadata rather than public download clutter.

## Installed behaviour

The user makes one choice: **Download / Install Update** or **Cancel**. Downloads use the private application update directory. Partial and stale downloads are cleaned up. A protected Step 1, Step 2, Step 3, backup, restore, migration, recovery, privacy deletion, or authoritative-data operation blocks executable replacement. An automatic pre-update database backup and pending marker preserve interrupted-update recovery. Linux retains the previous AppImage; Windows launches the verified installer after shutdown. macOS opens the verified DMG, clearly directs the user to replace the copy in Applications, and quits only after the user chooses to do so. It never recursively self-replaces a running `.app` bundle.

The macOS CI build uses Developer ID signing, hardened runtime, Apple notarization, stapling, and signature/notarization verification only when the complete secret set is present. With no credentials it produces an explicitly unsigned TEST DMG for technical validation and never publishes it as stable.

## Upgrade from the old beta

The already-published 0.4.0-beta.1 binary contains the old updater configuration and cannot be changed retroactively. Users of that build must manually install 0.4.0 once. Existing application data remains in the same user profile. Starting with 0.4.0, later stable releases use GitHub Latest. No bridge beta is required.
