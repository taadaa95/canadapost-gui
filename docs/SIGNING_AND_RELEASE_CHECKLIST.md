# Signing and release checklist

- Start from a reviewed clean commit and protected release runner.
- Run all checks in `docs/RELEASE_PROCESS.md`; inspect source/package manifests, checksums, SBOM, licences and audit results.
- Set `RELEASE_CHANNEL` to exactly `beta` or `stable`; stable must never consume beta metadata.
- Supply `CSC_LINK`, `CSC_KEY_PASSWORD` and `WINDOWS_PUBLISHER_NAME` only through protected CI secrets. Never copy a private key into the repository or artifact.
- Run `npm run package:signed-windows`; the signing config fails if signing is unavailable.
- Verify Authenticode publisher/timestamp on a clean Windows system and perform SmartScreen/installer checks without claiming reputation in advance.
- Sign update metadata with the offline Ed25519 release key; publish only its trusted public key through the reviewed application configuration.
- Verify the metadata signature, artifact SHA-256, channel and downgrade behavior before upload.
- Sign Linux checksums with the approved organizational key and verify on a clean Linux system.
- Publish release notes, support status, known issues and rollback location only after the manual gates are signed off.
