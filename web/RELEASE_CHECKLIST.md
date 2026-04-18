# Codex Web Release Checklist

This release bar is real-backend only. Do not mark the web app publish-ready
until every automated suite below is green and every manual check passes.

## Automated local smoke

Run the unauthenticated live suite:

```bash
cd web
CODEX_BIN="$HOME/.local/bin/codex" npm run test:e2e
```

Pass criteria:

- The app boots with `backend: real`
- The model pill populates from `model/list`
- Settings and MCP open
- Image attachments carry into the next turn
- Thread resume, rename, archive, and unarchive work
- Unauthenticated turns show one auth-required card instead of retry spam

## Automated auth-gated smoke

Run the auth lane:

```bash
cd web
CODEX_BIN="$HOME/.local/bin/codex" PLAYWRIGHT_AUTH=1 PLAYWRIGHT_API_KEY="$OPENAI_API_KEY" npm run test:e2e:auth
```

Pass criteria:

- The ChatGPT auth UI uses browser callback on localhost and device code on non-local hosts
- API-key-backed authenticated smoke covers command approval, file-change approval, reload persistence, fork/archive/rollback, and logout
- Any auth-only tests that depend on `PLAYWRIGHT_API_KEY` or `OPENAI_API_KEY` must skip cleanly when the key is absent

## Manual authenticated smoke

Complete these in a real signed-in browser session before release:

1. Log in with ChatGPT on localhost and confirm the new tab callback completes without a device-code prompt.
2. Trigger a real command approval and approve it.
3. Trigger a real file-change approval and approve it.
4. Trigger `item/permissions/requestApproval` and verify the permission modal can allow once, allow for session, and decline.
5. Trigger `item/tool/requestUserInput` and verify the questions modal submits a response.
6. Trigger `mcpServer/elicitation/request` and verify both accept and cancel flows.
7. Reload while signed in and confirm the account pill stays valid and the next turn succeeds.

Pass criteria:

- Every modal renders without hanging the turn
- Approvals and form replies unblock the backend and complete the turn
- Reload does not silently sign the session out

## Manual auth refresh soak

Keep a ChatGPT-authenticated localhost session open long enough for the backend
to request `account/chatgptAuthTokens/refresh`.

Pass criteria:

- No re-login prompt appears
- The account pill remains valid after refresh
- The next turn succeeds immediately after refresh

## Manual Replit smoke

Build once on Replit:

```bash
cd /path/to/codex
./web/scripts/build-codex-bin.sh
```

Start the workspace app and then create a Deployment. Validate both the webview
and the public URLs.

Pass criteria:

- `.replit` Run and Deployment both start `web/server.mjs` against `$HOME/codex-bin/codex-app-server`
- The public URL shows `backend: real`
- Unauthenticated prompts show one auth-required card
- Public auth uses the device-code flow
- A signed-in session can send a turn successfully on the public URL
