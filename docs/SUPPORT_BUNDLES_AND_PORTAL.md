# Support bundles and portal compatibility

## Customer-safe support bundle

Use **History → Support bundle** to preview an archive before creating it. Every preview shows a random, non-identifying support reference, application/platform/architecture versions, database schema version, Tracking parser version, selected components, permanent exclusions, and a review warning.

System integrity and sanitized configuration status are selected by default. Masked recent attempt summaries, sanitized logs, and sanitized Step 3 diagnostics require separate opt in. Credentials, tokens, cookies, browser profiles, private keys, raw Tracking API response bodies, screenshots, full tracking numbers, addresses, and contact details are never included. Tracking structure-response files are excluded from log selection. The operator must explicitly acknowledge the preview and inspect the resulting ZIP before using an approved support channel; automated redaction cannot guarantee removal of every business-sensitive phrase.

Support bundles are ordinary local exports and are not uploaded by the application. Store and delete them according to the approved privacy and retention process.

## Portal compatibility fingerprint

The workflow health check records a versioned, SHA-256 portal fingerprint only after the built-in browser confirms the allowlisted Canada Post domain, authenticated state, recognized claim navigation, expected support/category/late/ticket stages, and the critical late-package control. It records structural booleans and stage names, not credentials, cookies, form values, or page bodies.

A live Step 3 batch fails closed unless the latest health-check run:

- completed with a healthy result;
- matches the current fingerprint version;
- contains only expected stages and reaches a late or ticket stage; and
- is no older than seven days.

An unknown stage, changed or missing selector, incomplete authentication, redirect to an unapproved host, manual verification, CAPTCHA, or stale/missing fingerprint blocks live submission. Dry runs and operator-directed diagnostics remain available because they cannot perform the final action. Combined live runs are disabled; live work must start from the reviewed Step 3 queue with its separate acknowledgment and canary control.

The synthetic loopback portal covers success, changed selectors, missing stages, redirects, CAPTCHA/text verification, duplicates, rejection, timeout, uncertain confirmation, delayed confirmation, validation failure, origin violations, and crash/network failures. It never contacts Canada Post.
