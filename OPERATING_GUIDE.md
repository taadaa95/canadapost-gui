# Canada Post Claim Runner operating guide

This is the operator guide for application version **0.4.2** on branch `feature/dev11-beta-release-hardening`. Public stable 0.4.0 supports Linux x64 and Windows x64. Version 0.4.2 remains unpublished until Kris validates the exact canonical packages.

## Safety model

Only a completed and promoted Step 2 run can supply Step 3. A `LATE_CANDIDATE` requires an authoritative successful-delivery date after the selected original Delivery Standard date. Revised estimates do not replace the original standard, and Canada Post makes the final eligibility decision.

Step 3 uses only Electron's built-in browser. Its queue contains only actionable `LATE_CANDIDATE` records; previously submitted, duplicate, terminal, unresolved, reconciliation-required, and otherwise unsafe records are excluded automatically. The same state is revalidated at selection, snapshot creation, immediate pre-submission, and the worker boundary. Selecting candidates and pressing **Submit selected candidates** begins live sequential processing; an uncertain final action is never retried automatically.

## Current technical contract

| Item | Current value |
| --- | --- |
| Application | `0.4.2` |
| Database schema | `8` |
| EST parser/schema | `est-import-v5` |
| Tracking API contract | `1.0.0` |
| Tracking parser | `tracking-details-official-v4` |
| Tracking pacing | sequential, `3100 ms` minimum plus `0–100 ms` positive jitter |
| Tracking test gateway | `https://api-stg.canadapost-postescanada.ca` |
| Tracking production gateway | `https://api.canadapost-postescanada.ca` |
| Linux artifact | `Canada.Post.Claim.Runner-0.4.2-linux-x86_64.AppImage` |
| Windows artifact | `Canada.Post.Claim.Runner-0.4.2-win-x64.exe` |
| macOS artifact | `Canada.Post.Claim.Runner-0.4.2-mac-universal.dmg` (publish only if Developer ID signed and notarized) |

## Supported workflow

1. Complete first-run setup and review local-data and secure-storage status.
2. Sign in to Canada Post only in the built-in browser.
3. Save current Tracking API credentials without sharing or exporting them.
4. Run Steps 1 and 2. Step 2 automatically performs a fresh tracking run.
5. Review and select the actionable Step 3 queue.
6. Review retained status and evidence for any **Needs attention** record; unresolved records remain protected from automatic retry.
7. Select the intended candidates, submit them, and supervise CAPTCHA or manual verification in the built-in browser.

Never use a production account during automated testing. Automated browser suites use only the synthetic loopback mock portal.

## Updates

Starting with 0.4.0, **Check for Updates** uses the latest normal GitHub release from `taadaa95/canadapost-claim-runner-releases`. It accepts only the exact platform package name, approved HTTPS GitHub hosts, GitHub's SHA-256 release-asset digest, and matching downloaded size and digest. It never installs a downgrade, draft, prerelease, wrong-platform, incomplete, or hash-mismatched package.

The already-published 0.4.0-beta.1 binary contains the old updater configuration and cannot be changed remotely. Install 0.4.0 manually once when moving from that build. Existing application data remains in the same user profile. Do not create a bridge beta.

macOS opens the verified DMG and asks the operator to replace the application in Applications. The running `.app` is never self-replaced. Do not publish an unsigned macOS test DMG as a stable package.

Before publishing any stable package, run the automated checks and clean-source build in `docs/RELEASE_PROCESS.md`, then complete `MANUAL_RELEASE_GATES.md`.
