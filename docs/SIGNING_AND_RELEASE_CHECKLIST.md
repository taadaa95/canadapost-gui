# Signing and release checklist

- Start from a reviewed clean commit and protected release runner.
- Run all checks in `docs/RELEASE_PROCESS.md`; inspect source/package manifests, checksums, SBOM, licences and audit results.
- Set `RELEASE_CHANNEL` to exactly `beta` or `stable`; stable must never consume beta metadata.
- Supply `CSC_LINK`, `CSC_KEY_PASSWORD` and `WINDOWS_PUBLISHER_NAME` only through protected CI secrets. Never copy a private key into the repository or artifact.
- Run `npm run package:signed-windows`; the signing config fails if signing is unavailable.
- Verify Authenticode publisher/timestamp on a clean Windows system and perform SmartScreen/installer checks without claiming reputation in advance.
- Confirm `config/update-source.json` in the reviewed commit contains the authorized Ed25519 public key; an empty value deliberately disables updates.
- Keep each CI-produced `package-manifest-*.unsigned.json` candidate with its matching artifact. On the offline workstation, set `CPCR_UPDATE_PRIVATE_KEY_FILE` to an external key path and run `npm run release:sign-manifest -- <candidate> <package-manifest-platform.json>`.
- Run `npm run release:verify-signed-manifest -- <package-manifest-platform.json> <artifact>`. Verify the tag, publication timestamp, channel, platform, architecture, byte size and SHA-256 before upload. Never upload unsigned candidates.
- Sign Linux checksums with the approved organizational key and verify on a clean Linux system.
- Publish release notes, support status, known issues and rollback location only after the manual gates are signed off.
