# Manual stable-release gates

These gates are intentionally pending. Kris must run them against the exact clean-source AppImage recorded in `dist/release-metadata/releases/v0.4.0.json`. Automated work must not use real Canada Post credentials or authenticated services.

## Exact 0.4.0 Linux validation

1. Verify the filename is `Canada.Post.Claim.Runner-0.4.0-linux-x86_64.AppImage`.
2. Run `sha256sum Canada.Post.Claim.Runner-0.4.0-linux-x86_64.AppImage` and compare it exactly with `SHA256SUMS.txt` and `releases/v0.4.0.json`.
3. Confirm the file size exactly matches `releases/v0.4.0.json`.
4. On a supported physical Linux x86_64 system, mark the AppImage executable and launch that exact file.
5. Confirm the footer displays `VERSION 0.4.0` and there is no beta, release-channel, unsigned-build, signing-key, or manifest messaging.
6. Confirm Settings → Advanced contains Check for Updates, Create Backup, Restore Backup, Manage Stored Data, and Support Bundle.
7. Confirm History is a single Claim History interface with no search/status filters, separate Reconciliation Queue, manual shipment form, Step 2 classification viewer, or browser-session controls.
8. Confirm ordinary history rows have no reconciliation actions and an authorized synthetic/copied unresolved record shows **Needs attention** with only the valid inline actions.
9. Confirm Step 3 shows only actionable `LATE_CANDIDATE` rows and its visible count equals the rows shown. Confirm submitted, already-submitted, terminal, unresolved, and reconciliation-required records are absent.
10. In dry-run mode with an authorized account, verify the built-in browser, visibility checks, CAPTCHA/manual-verification handling, and final-action barrier. Do not submit a live claim during this gate unless separately authorized.
11. Create and restore a backup using non-production test data. Confirm schema version 8 and existing claim/classification/audit history remain intact.
12. Copy the existing application profile to a private isolated test directory. Start the AppImage with `CANADA_POST_CLAIM_RUNNER_USER_DATA_DIR` and `CANADA_POST_CLAIM_RUNNER_ISOLATED_TEST_CONFIRM=ISOLATED_MIGRATION_TEST`; confirm the isolated banner, retained data, and disabled live/update/export operations. Never point the override at the real profile.
13. Confirm **Check for Updates** reports 0.4.0 as current after the stable release exists. Before publication, a “no stable release yet” result is expected.
14. Test keyboard navigation, focus visibility, window resize/reflow, close/restart, interrupted-update recovery state, and uninstall/residue behaviour on the physical target.
15. Record the validation date, operator, exact source SHA, AppImage size, SHA-256, platform, results, and any exceptions. Change `manualValidation.status` in release-repository metadata only after every required gate passes.

## Additional external gates

- Obtain legal/privacy approval for notices, retention, licensing, support, and lifecycle commitments.
- Verify current Canada Post policy, customer contract, holiday, and guarantee notices immediately before release.
- Use only an authorized Canada Post account owner for real API diagnostics, CAPTCHA/text verification, supervised claims, canary submission, or account reconciliation.
- Validate Windows separately before adding the `.exe` asset to a future public release.

Until these steps pass, 0.4.0 is a stable release candidate and must not be published.
