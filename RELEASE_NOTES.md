# Canada Post Claim Runner 0.3.6

## Step 3 diagnostic-driven refinement

- Removes two expected negative field probes from every claim.
- Waits for the actual next-page marker before capturing diagnostics or filling fields.
- Prefers stable Canada Post control IDs before accessibility-label fallbacks.
- Produces useful non-empty reference and sender/contact page snapshots.
- Separates known Canada Post/Electron page defects from application automation errors.
- Adds `automationErrorCount` and `siteIssueCount` to Step 3 summaries.
- Treats expected optional-field misses as debug information instead of warnings.
- Keeps all v0.3.5 navigation, dry-run, duplicate-prevention, and browser hardening protections.

## Validation

- Full test suite passed.
- New regression coverage verifies deterministic setup transitions and diagnostic issue classification.
- Live submission was not performed in the isolated build environment.

# Canada Post Claim Runner 0.3.5

## Step 3 launcher navigation stability

- Uses the canonical Canada Post late-package support route first, with UI navigation fallback.
- Treats the late-package article as a terminal launcher page and only searches for Open a ticket there.
- Waits for actual forward navigation before activating another control.
- Prevents support/late breadcrumb loops.
- Classifies launcher failures with dedicated navigation codes instead of CAPTCHA_PENDING.
- Forces the Step 3 child process to exit after its final JSON event so the UI cannot remain stuck in running state.
- Downgrades aborted advertising/analytics requests to diagnostic debug noise.
