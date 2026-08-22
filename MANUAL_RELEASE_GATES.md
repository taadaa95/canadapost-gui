# Manual stable-release gates

Kris performs physical, visual, and live release testing against the exact checksum-identified packages. Automated work must not use real Canada Post credentials or authenticated services.

## Recorded 0.4.0 Linux validation

1. Verify the filename is `Canada.Post.Claim.Runner-0.4.0-linux-x86_64.AppImage`.
2. Run `sha256sum Canada.Post.Claim.Runner-0.4.0-linux-x86_64.AppImage` and compare it exactly with `SHA256SUMS.txt` and `releases/v0.4.0.json`.
3. Confirm the file size exactly matches `releases/v0.4.0.json`.
4. On a supported physical Linux x86_64 system, mark the AppImage executable and launch that exact file.
5. Confirm the footer displays `VERSION 0.4.0` and there is no beta, release-channel, unsigned-build, signing-key, or manifest messaging.
6. Confirm Settings → Advanced contains Check for Updates, Create Backup, Restore Backup, Manage Stored Data, and Support Bundle.
7. Confirm History is a single Claim History interface with no search/status filters, separate Reconciliation Queue, manual shipment form, Step 2 classification viewer, or browser-session controls.
8. Confirm ordinary history rows have no reconciliation actions and an authorized synthetic/copied unresolved record shows **Needs attention** with only the valid inline actions.
9. Confirm Step 3 shows only actionable `LATE_CANDIDATE` rows and its visible count equals the rows shown. Confirm submitted, already-submitted, terminal, unresolved, and reconciliation-required records are absent.
10. With authorized test data, verify the built-in browser, visibility checks, CAPTCHA/manual-verification handling, silent preflight, and sequential selected-candidate flow. A real submission is performed only when Kris separately authorizes that live gate.
11. Create and restore a backup using non-production test data. Confirm schema version 8 and existing claim/classification/audit history remain intact.
12. Copy the existing application profile to a private isolated test directory. Start the AppImage with `CANADA_POST_CLAIM_RUNNER_USER_DATA_DIR` and `CANADA_POST_CLAIM_RUNNER_ISOLATED_TEST_CONFIRM=ISOLATED_MIGRATION_TEST`; confirm the isolated banner, retained data, and disabled live/update/export operations. Never point the override at the real profile.
13. Confirm **Check for Updates** reports 0.4.0 as current after the stable release exists. Before publication, a “no stable release yet” result is expected.
14. Test keyboard navigation, focus visibility, window resize/reflow, close/restart, interrupted-update recovery state, and uninstall/residue behaviour on the physical target.
15. Record the validation date, operator, exact source SHA, AppImage size, SHA-256, platform, results, and any exceptions. Change `manualValidation.status` in release-repository metadata only after every required gate passes.

## Additional external gates

- Obtain legal/privacy approval for notices, retention, licensing, support, and lifecycle commitments.
- Verify current Canada Post policy, customer contract, holiday, and guarantee notices immediately before release.
- Use only an authorized Canada Post account owner for real API diagnostics, CAPTCHA/text verification, supervised claims, or account reconciliation.
- Physical Windows validation remains distinct from the automated Windows package validation. Do not mark it passed unless Kris performs it.

## Exact 0.4.4 release-candidate validation

1. Compare the exact size and SHA-256 of every canonical 0.4.4 binary intended for publication with the combined `SHA256SUMS.txt` and release metadata.
2. Validate the AppImage on physical Linux x64 and the NSIS installer on physical Windows x64.
3. Validate the universal DMG on Intel x64 and Apple Silicon arm64 where hardware is available; record any architecture not physically tested.
4. On macOS, verify the public candidate is Developer ID signed and notarized, mounts normally, can replace the copy in Applications, preserves application data, and has the expected Gatekeeper experience. Do not treat an unsigned TEST DMG as equivalent.
5. On every platform, verify startup, schema-8 database access, backup/restore paths, browser-profile isolation, privacy deletion, update storage, and packaged Step 1/Step 2 workers.
6. Confirm the built-in `WebContentsView` and Playwright CDP connection behave normally without a separately bundled browser.
7. Repeat the Step 3 gates above: actionable-only queue, immutable snapshot, silent authoritative preflight, immediate selected submission, CAPTCHA/manual verification, duplicate/already-submitted prevention, and uncertain-final-action protection.
8. Exercise the updater with a newer synthetic/test release: exact asset selection, size/hash verification, protected-operation lock, pre-update database backup, and platform install behavior.
9. Record the source SHA, filename, size, SHA-256, signing/notarization status, physical platform/architecture, results, and exceptions.

Do not publish `v0.4.4` until these gates are complete and Kris explicitly approves the exact packages.
