# v0.3.6 QA report

## Diagnostic source reviewed

The successful two-claim v0.3.5 dry run completed in 33.984 seconds with no failed claims and no dropped diagnostic events.

Measured operations:
- Authentication: 13.320 s
- Ticket launcher navigation: 2.066 s
- Claim 1: 8.921 s
- Claim 2: 7.470 s
- Launcher reset between claims: 1.050 s

## Improvements

- Removed the expected 500 ms reference-field miss before each first Continue.
- Removed the expected 500 ms street-field miss before each second Continue.
- Reuses the field locator found during stage readiness rather than finding the same control again.
- Prefers stable Canada Post field IDs before accessibility-label fallback.
- Captures page-state diagnostics after the next page marker is visible, preventing empty transient snapshots.
- Separates known Canada Post and Electron page defects from actual automation errors.
- Marks expected optional locator misses as debug events.

## Validation

- Full npm test suite passed.
- Step 3 dry-run safety regression passed.
- Step 3 navigation stability regression passed.
- Step 3 diagnostics privacy and classification tests passed.
- UI contract tests passed.
- Live Canada Post submission was not performed in the isolated build environment.
