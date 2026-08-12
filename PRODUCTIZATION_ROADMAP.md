# Productization roadmap

Status at 2026-08-01: issue [#4](https://github.com/taadaa95/canadapost-gui/issues/4) is the authoritative Dev 11 completion checklist. The work below records earlier completed foundations and must not be read as the current task list. Version 0.4.0-beta.1 remains subject to the external gates in `MANUAL_RELEASE_GATES.md`.

The v0.4.0 work is intentionally split into gated phases so changes to claim safety, runtime dependencies, packaging, and commercial features can be tested independently.

1. **Implemented:** operator control, silent preflight, reviewed cryptographic queue snapshots and conservative reconciliation.
2. **Implemented:** local mock portal scenarios, Electron/browser tests, explicit fault points, crash recovery and site-compatibility checks.
3. **Implemented:** Node Steps 1–2 with hardened XML, SOAP fixtures and compatibility tests; PHP is removed.
4. **Implemented/signing gated:** Windows NSIS/Linux AppImage configuration, clean staging, checksums, SBOM/licences, package audits, beta/stable metadata verification. Production signing/publishing is external.
5. **Materially advanced:** policy, normalization, release, backup, database, money, localization, crash and update modules extracted; narrow preload and checked IPC; lint/format/type/coverage gates. The legacy main/renderer presentation files remain large and are a follow-up maintainability risk.
6. **Implemented with manual accessibility gate:** first-run readiness, queue/deadline/manual-review UX, session control, integer-cent recovery reporting, Canadian French catalog and automated accessibility checks.
7. **Implemented:** encrypted backups, database integrity, secret scanning, source/package allowlists and threat model.
8. **Implemented as drafts/external gate:** stable/beta channels, local opt-in crash abstraction, privacy/support/lifecycle/pilot material. Legal approval and a real pilot remain external.

## Non-negotiable constraints

- Step 3 uses the built-in Electron browser.
- CAPTCHA and text verification remain manual.
- Fresh installs contain no prefilled credentials.
- Credentials and browser sessions remain local.
- Live submission remains conservative, transactional, and duplicate-resistant.
- The UI remains minimal, business-oriented, and square-cornered.
