# GitHub Releases update workflow

Canada Post Claim Runner checks a fixed public release-only repository:

```text
taadaa95/canadapost-claim-runner-releases
```

The private source repository remains private. The installed application does not contain a GitHub token and does not accept a renderer-configurable update URL.

## One-time setup

1. Create the public repository `taadaa95/canadapost-claim-runner-releases` with no source code.
2. Add a short README explaining that it contains only official application binaries and metadata.
3. Enable GitHub immutable releases when available for the repository.
4. Do not store signing keys, source archives, credentials, customer data, browser profiles or diagnostics in the release repository.

## Publishing an update

1. Update `package.json` to a newer semantic version, such as `0.4.1-beta.1` or `0.4.1`.
2. Build and validate Windows and Linux artifacts through the source repository CI.
3. Download the `linux-beta-unsigned` and `windows-beta-unsigned` workflow artifacts.
4. Create a GitHub Release in the public release repository with a tag matching the application version, prefixed with `v` if desired.
5. Mark beta versions as prereleases. Stable builds must be published as non-prerelease releases.
6. Upload all of the following assets without renaming them:
   - the Windows NSIS `.exe`;
   - the Linux `.AppImage`;
   - `package-manifest-windows.json`;
   - `package-manifest-linux.json`;
   - `SHA256SUMS-windows.txt`;
   - `SHA256SUMS-linux.txt`;
   - optional `.blockmap` and builder metadata files.
7. Publish the release. Draft releases are ignored.

The manifest version and GitHub tag must match. The updater rejects missing files, unexpected hosts, wrong platform/architecture, size mismatches, GitHub digest mismatches when GitHub supplies a digest, and SHA-256 mismatches after download.

## Installed application behaviour

The existing Update button performs an explicit check. It does not check or download automatically at startup.

- Stable application versions consider stable releases only.
- Prerelease application versions consider both prerelease and stable releases.
- Downloads are stored under the application's private `userData/updates` directory.
- The user must explicitly choose Download and then confirm that no workflow is running before installation.
- Windows launches the verified NSIS installer and exits.
- Linux replaces the currently running AppImage only when its location is writable; otherwise the downloaded AppImage is revealed for manual replacement.
- Isolated migration-test mode disables updates.

## Security limitations and next hardening step

The initial updater trusts the fixed GitHub account/repository, HTTPS, GitHub release metadata, the platform-specific artifact manifest, and the downloaded artifact SHA-256. It does not embed a GitHub credential.

The release manifest is not yet cryptographically signed by an offline product signing key. Before declaring stable commercial update delivery, connect the existing Ed25519 update-verification module to a separately signed release manifest and keep the private signing key outside GitHub and outside the build repository.
