# Replit Deploy Notes

This web app now runs against a real backend only. Replit should build and run
the standalone `codex-app-server` binary, then point `web/server.mjs` at that
binary through `CODEX_BIN`. The full release bar lives in
[web/RELEASE_CHECKLIST.md](/Users/marmar/Desktop/codex/web/RELEASE_CHECKLIST.md).

## One-time build

```bash
cd /path/to/codex
./web/scripts/build-codex-bin.sh
```

This installs the backend at:

```bash
$HOME/codex-bin/codex-app-server
```

## Run workflow

The `.replit` workflow starts:

```bash
cd web && CODEX_BIN=${CODEX_BIN:-$HOME/codex-bin/codex-app-server} npm start
```

Replit Deployments use the same run command and build the standalone backend
with:

```bash
cd web && npm install && cd .. && ./web/scripts/build-codex-bin.sh
```

## Smoke path after boot

1. Open the Replit webview or public URL.
2. Confirm the status bar says `backend: real`.
3. Confirm the model pill populates from `model/list`.
4. Try an unauthenticated prompt and confirm you get one auth-required card,
   not repeated retry spam.
5. Start ChatGPT sign-in and confirm the modal shows the device code directly.
6. Finish the device-code flow in a browser tab and confirm the account pill
   updates without restarting the app.

## Deployment

Use the same command for Replit Deployments. The public deployment still needs
`CODEX_BIN` pointing at the built standalone backend path shown above, and it
should be validated against the release checklist before calling the app
publish-ready.
