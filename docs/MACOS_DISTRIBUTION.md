# macOS distribution

`npm run package:mac` runs only on macOS and creates one universal DMG for Intel x64 and Apple Silicon arm64:

```text
Canada.Post.Claim.Runner-0.4.3-mac-universal.dmg
```

The validation workflow reads signing material only from these GitHub Actions secrets:

- `MAC_CSC_LINK` — Developer ID Application certificate exported as a password-protected P12 value supported by electron-builder
- `MAC_CSC_KEY_PASSWORD` — P12 password
- `APPLE_ID` — Apple developer account used by `notarytool`
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password, never the normal Apple account password
- `APPLE_TEAM_ID` — Apple developer team identifier

The set is all-or-nothing. With all five values, CI enables hardened runtime, signs and notarizes the application, submits the DMG with `xcrun notarytool`, staples it, and verifies the application and disk image. With none, CI disables identity discovery, hardened runtime, and notarization and creates an explicitly unsigned TEST artifact. A partial credential set fails the job.

Never commit a certificate, P12 password, Apple credential, API key, provisioning profile, or keychain. Never publish an unsigned TEST DMG as the stable macOS package.

The updater opens a verified DMG with Electron's normal macOS shell integration and asks the user to replace the application in Applications. It does not recursively modify or replace the running `.app` bundle.
