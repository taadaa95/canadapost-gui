# Apply Canada Post Claim Runner 0.2.0 hardening update

The ZIP is intentionally packaged with the update files at its root.

## CachyOS / Linux

1. Close the app completely.
2. Back up the project. Do not share the backup; it may contain credentials, shipment data, browser state, and claim evidence.
3. Extract the ZIP directly into the existing project directory, replacing matching files:

   ```bash
   cp -a ~/Documents/canadapost-gui ~/Documents/canadapost-gui-backup-before-v0.2.0
   unzip -o ~/Downloads/canadapost-gui-v0.2.0-hardening-patch-fixed.zip \
     -d ~/Documents/canadapost-gui
   ```

4. Verify that the patch actually replaced `package.json`:

   ```bash
   cd ~/Documents/canadapost-gui
   node -p "require('./package.json').version"
   ```

   It must print `0.2.0`.

5. Recreate dependencies. This is required because the previous archived `node_modules/.bin/electron` launcher may be a damaged regular file instead of a valid executable symlink:

   ```bash
   rm -rf node_modules
   npm ci
   npm test
   npm start
   ```

   Under Hyprland, if the normal launch has a graphics/windowing issue, use:

   ```bash
   npm start -- --ozone-platform=x11 --disable-gpu
   ```

6. Launch once. The app migrates mutable runtime files into Electron's per-user application-data directory. When secure OS encryption is available, it imports the web password and Developer API credentials and removes plaintext credential fields from migrated configuration files.
7. Open User Settings and confirm that the web password and API credentials show as ready. Test Step 1 and Step 2 on a small controlled date range before using Step 3.
8. After confirming migration, remove legacy `config.local.json`, `user.ini`, `data/`, and `logs/` copies from the application directory.
