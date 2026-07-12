# 0.2.0 hardening QA report

Validated in the review environment:

- JavaScript syntax for main, preload, renderer, claim runner, storage module, and tests
- PHP syntax for history import, EST import, tracking, and eligibility module
- Eligibility regression suite
- Encrypted credential-store regression suite using an isolated Electron API mock
- Claim selection, idempotency, interrupted-run, domain allowlist, and retry-limit regression suite
- Git whitespace validation
- Release allowlist and secret/path scan

Not executed in the review environment:

- A live Canada Post claim submission
- A complete Electron GUI launch, because the uploaded ZIP's `node_modules` symlinks/binary payload were damaged and the Electron binary could not be downloaded in the isolated container
- Live SOAP calls, because the review container lacks the PHP SOAP extension and no production account was used

Run `npm install`, `npm test`, and a small supervised end-to-end validation on the target machine before production use.
