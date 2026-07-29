# Supported platforms, updates and lifecycle draft

**Draft.** The beta build targets 64-bit Windows through NSIS and 64-bit Linux through AppImage. Node 24 is the CI validation runtime and Electron/Playwright versions are locked in `package-lock.json`. macOS is not currently supported.

Beta and stable are distinct channels. Stable clients must reject beta metadata; both channels reject downgrades. Updates remain manual and fail closed until a trusted public key, signed metadata host, signed binaries, privacy-approved release service and rollback plan exist. Unsigned builds identify themselves visibly.

Proposed support policy: security fixes for the current stable and immediately previous stable release, at least 90 days' notice before ordinary end of life, and accelerated retirement only for an actively exploitable security or policy defect. Actual dates and contractual commitments require commercial approval.
