# Apply Canada Post Claim Runner v0.4.0-dev.1

This is a development/test build for the v0.4.0 productization branch.

```bash
cd ~/Documents/canadapost-gui
unzip -o ~/Downloads/canadapost-gui-v0.4.0-dev.1-operator-control.zip -d .
npm install
npm test
npm start
```

## Step 3 changes

- Review and select the exact claims to process.
- Run the readiness preflight before starting.
- Dry runs remain non-submitting.
- Live runs require an explicit acknowledgement dialog.
- Canary mode processes only the first selected claim, then stops.
- Step 3 is restricted to the built-in browser.

Do not merge or tag this development build until a supervised dry run and canary live run are reviewed.
