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
4. On the offline signing workstation, verify that the production Ed25519 public key embedded in `config/update-source.json` matches the offline private key. The deliberate empty placeholder disables updates and must never be bypassed.
5. Sign each `package-manifest-*.unsigned.json` candidate with `CPCR_UPDATE_PRIVATE_KEY_FILE=/external/offline/path npm run release:sign-manifest -- <unsigned-manifest> <package-manifest-platform.json>`. The script rejects private keys inside the repository, refuses overwrites, checks the embedded public key, signs canonical JSON, and self-verifies.
6. Run `npm run release:verify-signed-manifest -- <signed-manifest> <artifact>` on both platform outputs.
7. Create a GitHub Release in the public release repository with a tag matching the application version, prefixed with `v` if desired. Its publication timestamp must exactly match the signed manifest's `publishedAt` value.
8. Mark beta versions as prereleases. Stable builds must be published as non-prerelease releases.
9. Upload all of the following assets without renaming them:
   - the Windows NSIS `.exe`;
   - the Linux `.AppImage`;
   - `package-manifest-windows.json`;
   - `package-manifest-linux.json`;
   - `SHA256SUMS-windows.txt`;
   - `SHA256SUMS-linux.txt`;
10. Publish the release. Draft releases are ignored. Never upload the `.unsigned.json` candidates.

The versioned manifest signs canonical metadata containing application version, channel, publication time, optional minimum supported version, platform, architecture, file name, byte size, and SHA-256. The updater rejects an absent/malformed signature, wrong key, tampering, a missing configured production key, release/tag/time mismatch, downgrade, channel mismatch, unexpected host, wrong platform/architecture, asset size/digest mismatch, and downloaded size/hash mismatch.

## Installed application behaviour

The existing Update button performs an explicit check. It does not check or download automatically at startup.

- Stable application versions consider stable releases only.
- Prerelease application versions consider prerelease releases only; cross-channel updates fail closed.
- Downloads are stored under the application's private `userData/updates` directory. Cancelled partial files are removed, verified packages are bounded to the current package plus a small recent set, and healthy startup prunes obsolete staging files.
- The user must explicitly choose Download and Install. Main-process operation state—not a renderer checkbox—blocks installation during Step 1 import, Step 2 diagnostics/exports/bulk work, Step 3 dry/live work, backup/restore, migration/recovery, privacy deletion, or another authoritative-data mutation. The exact blocking operation is shown and the verified download is retained.
- Before installation, an authoritative SQLite database receives a verified owner-only backup and a minimal pending marker records old/target versions, timestamp and recovery paths. Credentials, browser profiles and device keys are excluded.
- Windows retains and launches the verified NSIS installer only after a last-moment idle recheck. Linux preserves the existing `.previous` AppImage rollback executable.
- Normal updated startup completes database initialization, integrity and relationship checks before archiving the marker as healthy. Interrupted startup preserves the marker, backup, installer and previous executable and exposes sanitized recovery state without overwriting current data.
- Isolated migration-test mode disables updates.

## Trust-chain status

The updater trusts only the fixed repository and GitHub host allowlist plus a manifest verified by the embedded Ed25519 public key. HTTPS and GitHub metadata are transport/discovery inputs, not signing authority. The application contains no GitHub credential. The production public-key placeholder is deliberately empty in this beta commit, so update checks fail closed until an authorized reviewed commit embeds the production public key. Production private-key custody and signing remain external manual gates.
