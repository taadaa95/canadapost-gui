# Dev 11 beta release readiness

## Candidate identity

- Starting commit: `3431bdbdfbba63310277eee1ed020da9ea4c2cb7`
- Canonical source branch: `feature/dev11-beta-release-hardening`
- Target version/channel: `0.4.0-beta.1` / `beta`
- Pull-request base: `feature/dev10-step3-executable-queue`
- Final candidate commit: read from the clean-build `release-provenance-<platform>.json` and the PR head; both must match.

## Implementation commits by phase

1. Metadata/document integrity: `ec8bb08`
2. Stale-policy safety: `d9517cd`
3. Signed updater trust chain: `2361435`
4. Built-in-browser runtime/package reduction: `701362c`, package measurement `edf06fe`
5. Architecture decomposition: `fd04aa7`
6. IPC/worker boundaries: `96454b6`
7. Resumable onboarding and supported themes: `a9219f8`
8. Support bundle and portal compatibility: `283dd12`
9. Release guard, CI canonicalization, provenance, and this report: final PR-head commit

## Architecture and security summary

Main-process IPC ownership is split into feature registries with shared bounded payload contracts. Renderer shared state, onboarding, stylesheet ownership, and Step 3 navigation/form/outcome/browser/safety/diagnostic helpers have explicit module boundaries. The production runtime uses Electron’s built-in browser with `playwright-core`; an independent production Chromium/profile path is rejected.

Stale policy is advisory and cannot expire or block an otherwise valid late candidate. Step 3 still requires the latest complete promoted Step 2 run, revalidates evidence hashes before an immutable private snapshot, blocks duplicate/terminal/unresolved/reconciliation-required records, preserves dry-run and canary barriers, persists attempts before final actions, never automatically retries uncertain actions, and requires a visible built-in browser for CAPTCHA/text verification.

The GitHub Releases updater accepts only a fixed repository/allowlisted hosts and fails closed without a configured Ed25519 public key, canonical signed manifest, exact release/tag/channel/platform/architecture/version/size/hash agreement, user confirmation, operation lock, and pre-update database backup. No private signing key is present.

Live batches additionally require a healthy portal-controls-v1 fingerprint no older than seven days. Unknown stages or missing controls block live work while dry diagnostics remain available. Support exports require preview/acknowledgment; logs, masked history, and Step 3 diagnostics are opt-in, while credentials, tokens, cookies, browser profiles, raw API bodies, screenshots, full tracking numbers, and contact/address data are excluded.

## Data and migration impact

There is no new Dev 11 database schema migration. Schema version remains `8`. Existing startup backup, structural reconciliation, transactional migration, rollback, privacy deletion, and isolated-profile protections remain in force. Portal compatibility reuses the existing `runs` table metadata and support bundles are user-selected local ZIP exports.

## Package result

The unsigned Linux package measured from implementation commit `701362c` is `131,090,651` bytes versus the Dev 10 baseline `387,230,260` bytes: `256,139,609` bytes / `66.14%` smaller. Its unpacked resources measured 14 MiB and its audited ASAR contained 353 entries and all six workers. The enforced budgets are 200 MiB for Linux AppImage and 220 MiB for Windows NSIS. Exact final-commit Linux and Windows sizes must come from their `package-size-*.json` reports; no local Windows size is claimed.

Package audits reject bundled Playwright browsers, obsolete external profiles, fixtures/tests, runtime/customer data, logs, diagnostics, source maps, credentials, secrets, and unexpected ASAR content. CI beta packages and provenance reports are explicitly unsigned.

## Automated validation

Required commands are listed in `README.md` and CI runs unit/integration, Dev 10 regression, mock portal, Step 3 visibility, accessibility, Electron isolated-profile E2E, lint, format, typecheck, coverage, secret scanning, release audit, production dependency audit, SBOM, package content/size, release metadata, and provenance gates. Linux GUI-dependent automation runs under Xvfb. Windows results are claimed only from Windows CI.

The final PR description and handoff report must record each command’s actual result, the clean package provenance commit, CI status, any failure, and any environment limitation.

## Rollback

Do not publish or merge when a required check fails. Stop live operations, preserve immutable audit/reconciliation state, withdraw affected unsigned artifacts or draft release, retain the previous executable/installer and pre-update database backup, and use the documented rollback/reconciliation path. Never retry an uncertain final claim action automatically.

## External/manual gates — pending

- Acquire and protect a Windows code-signing certificate; Authenticode-sign and independently verify the final Windows binary.
- Supply and protect the offline production Ed25519 private key; configure its reviewed public key in source; sign/verify exact post-signing manifests outside the repository.
- Obtain legal, privacy, EULA, trademark, policy, holiday-calendar, and support/lifecycle approval.
- Perform human physical clean-install, launch, visual/keyboard, upgrade/migration, backup/restore, rollback, uninstall, and residue checks on supported Windows and Linux machines.
- With authorized real credentials only, perform the website/API diagnostic, CAPTCHA/text verification, supervised Step 1/Step 2 procedure, portal health check, dry run, one-claim canary, and reconciliation. No automated session may do this.
- Execute and review the customer pilot with staffed support and deletion/incident rehearsals.

Until every gate is signed off, this is an unsigned public-beta candidate, not a production-signed or stable release.
