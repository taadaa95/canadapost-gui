# Stable 0.4.0 release readiness

## Candidate identity

- Canonical source branch: `feature/dev11-beta-release-hardening`
- Target application version: `0.4.0`
- Linux artifact: `Canada.Post.Claim.Runner-0.4.0-linux-x86_64.AppImage`
- Windows artifact: `Canada.Post.Claim.Runner-0.4.0-win-x64.exe`
- Final source SHA: recorded by the clean build and final handoff

The branch name remains for PR continuity and is not a release channel.

## Preserved safety

Step 3 still requires the latest complete promoted Step 2 run, immutable evidence and snapshots, duplicate/terminal/unresolved blocking, worker revalidation, the visible isolated built-in browser, and no automatic retry after an uncertain final action. Selecting **Submit selected candidates** starts silent preflight and the live sequential workflow without a second confirmation. Database schema remains 8 with migration, backup, recovery, reconciliation, and audit protections unchanged.

## Stable updater

The updater uses the configured repository's GitHub Latest endpoint. It rejects drafts, prereleases, non-newer versions, unsupported platforms/architectures, noncanonical filenames, missing or malformed GitHub SHA-256 asset digests, size mismatches, hash mismatches, incomplete downloads, disallowed hosts, and downgrades. It does not use channels, custom manifests, or Ed25519 keys.

## Publication gate

Automated validation, clean-source packaging, package audit, size report, checksum, provenance, and stable release-metadata validation must pass before manual testing. The release remains unpublished until Kris validates the exact AppImage using `MANUAL_RELEASE_GATES.md`.
