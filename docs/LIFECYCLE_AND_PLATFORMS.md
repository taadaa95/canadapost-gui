# Supported platforms, updates and lifecycle draft

**Draft.** Stable 0.4.1 supports 64-bit Windows through NSIS and 64-bit Linux through AppImage. The 0.4.3 candidate retains universal macOS packaging for Intel x64 and Apple Silicon arm64. Node 24 is the CI validation runtime and Electron/Playwright versions are locked in `package-lock.json`. A public macOS package requires Developer ID signing and Apple notarization; unsigned CI packages are technical test artifacts only.

There is one normal stable version stream. The updater uses GitHub Latest, accepts only a strictly newer stable release and exact platform artifact, and verifies GitHub's SHA-256 release-asset digest before installation. Protected operations, automatic database backup, interrupted-update recovery, and rollback remain in force.

Proposed support policy: security fixes for the current stable and immediately previous stable release, at least 90 days' notice before ordinary end of life, and accelerated retirement only for an actively exploitable security or policy defect. Actual dates and contractual commitments require commercial approval.
