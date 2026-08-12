# Canada Post Claim Runner 0.4.1

Version 0.4.1 adds official macOS support while retaining the complete stable platform set:

- Linux x64: `Canada.Post.Claim.Runner-0.4.1-linux-x86_64.AppImage`
- Windows x64: `Canada.Post.Claim.Runner-0.4.1-win-x64.exe`
- macOS universal: `Canada.Post.Claim.Runner-0.4.1-mac-universal.dmg` for Intel x64 and Apple Silicon arm64

The updater remains the simple GitHub Latest implementation. It requires a strictly newer stable version, the exact platform filename, GitHub's SHA-256 digest, a matching size, and a matching locally computed SHA-256. Protected-operation locking and the pre-update database backup remain mandatory.

On macOS, the updater opens the verified DMG and tells the user to replace Canada Post Claim Runner in Applications. It does not recursively replace the running `.app` bundle.

The public DMG requires Developer ID signing, hardened runtime, Apple notarization, stapling, and verification. CI may create an explicitly unsigned TEST DMG when credentials are unavailable, but that file is not ready for stable publication.

Do not publish `v0.4.1` until Kris manually validates and approves the exact Linux, Windows, and macOS packages.
