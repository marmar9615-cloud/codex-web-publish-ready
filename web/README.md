# Codex Web

`web/` is a real-browser front-end for the Rust `codex app-server`. There is
no mock backend path anymore: local development, Playwright smoke tests, and
Replit deployment all require a real `codex` or `codex-app-server` binary.

Release criteria live in [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md).

## Render

Render is the recommended public host for this app. The repo includes:

- [`../render.yaml`](../render.yaml) for Blueprint-based setup
- [`Dockerfile.render`](./Dockerfile.render) for the production image build
- `GET /healthz` for Render health checks

Why Render fits this app:

- the gateway is a long-lived Node service, not a static or serverless app
- browser sessions depend on a real WebSocket connection to `/ws`
- the app benefits from persistent disk storage for session workdirs and uploads

Launch flow:

1. Push the repo to GitHub.
2. In Render, create a new Blueprint from the repo.
3. Accept the checked-in `render.yaml`.
4. Wait for the Docker build to finish.
5. Open the generated public `onrender.com` URL.

The checked-in Blueprint uses:

- `starter` plan
- a 5 GB persistent disk mounted at `/var/data`
- `CODEX_WEB_WORKDIR_ROOT=/var/data/workdirs`
- a generated `CODEX_WEB_FILE_SIGNING_SECRET`

Public Render deployments use the ChatGPT device-code auth path. Localhost keeps
the browser callback flow.

## Quickstart

Local with the installed multitool binary:

```bash
cd web
npm install
CODEX_BIN="$HOME/.local/bin/codex" npm start
```

Local with a standalone app-server build:

```bash
cd /path/to/codex-web-publish-ready
./web/scripts/build-codex-bin.sh
cd web
CODEX_BIN="$HOME/codex-bin/codex-app-server" npm start
```

The app serves HTTP + WebSocket traffic on port `5000` by default.

## Runtime model

- `web/server.mjs` is a transparent JSON-RPC proxy for app-server v2.
- Each browser session gets its own workdir under `web/.workdirs/<sessionId>/`.
- Each session owns one backend child process; reconnecting the browser does not
  recycle the child unless the session logs out or idles out.
- The gateway owns API keys, non-local ChatGPT device-code state, refresh
  tokens, uploads, and workdir file serving.

## Auth

Two auth modes are supported:

- API key: `POST /api/login`
- ChatGPT browser callback on localhost via `account/login/start { type: "chatgpt" }`
- ChatGPT device code on non-local/public deployments via `POST /api/oauth/chatgpt/start`

ChatGPT auth is split by host:

- Localhost: the browser asks app-server for `type: "chatgpt"` and opens the
  returned callback URL in a new tab.
- Non-local/public deployments: the gateway starts the device-code flow, stores
  the refresh token in memory, and logs the backend in through
  `account/login/start { type: "chatgptAuthTokens", ... }`.

When the backend later requests `account/chatgptAuthTokens/refresh`, the
browser calls the gateway’s `POST /api/oauth/chatgpt/refresh` endpoint and
replies with fresh external auth tokens.

High-level flow:

```text
Browser -> /api/oauth/chatgpt/start -> Gateway
Gateway -> auth.openai.com device-code endpoints
User enters device code in browser on the public deployment
Gateway exchanges code for tokens and stores refresh token
Gateway -> app-server account/login/start(chatgptAuthTokens)
Browser answers future account/chatgptAuthTokens/refresh requests via /api/oauth/chatgpt/refresh
```

## Attachments and files

- Image uploads go through `POST /api/upload`
- Images and other workdir-scoped files render through `GET /api/workdir-file?path=...`
- The composer currently supports paste-image and file-picker uploads for local
  image inputs

## Non-goals in the web build

These intentionally show a friendly “use the CLI” message instead of failing:

- realtime voice
- `/fast`
- native editor handoff
- terminal-title and statusline escape handling
- full TTY UI programs inside the browser

## Playwright

Install Playwright once:

```bash
cd web
npm install --no-save @playwright/test
npx playwright install chromium
```

Run the live unauthenticated smoke suite:

```bash
cd web
CODEX_BIN="$HOME/.local/bin/codex" npm run test:e2e
```

Run auth-gated tests only when you intentionally want an authenticated browser
session:

```bash
cd web
CODEX_BIN="$HOME/.local/bin/codex" PLAYWRIGHT_AUTH=1 npm run test:e2e:auth
```

To run the deterministic authenticated workflow smoke, also provide a real API
key:

```bash
cd web
CODEX_BIN="$HOME/.local/bin/codex" PLAYWRIGHT_AUTH=1 PLAYWRIGHT_API_KEY="$OPENAI_API_KEY" npm run test:e2e:auth
```

See [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) for the manual ChatGPT auth,
refresh, and Replit release gates.

## Replit

Build the standalone backend once on Replit:

```bash
cd /path/to/codex-web-publish-ready
./web/scripts/build-codex-bin.sh
```

Then start the app with:

```bash
cd web
CODEX_BIN="$HOME/codex-bin/codex-app-server" npm start
```

Public Replit deployments use the device-code auth flow. Localhost keeps the
browser callback flow.

## Public-hosting notes

- This app is stateful and compute-backed. It is not a good fit for static
  hosts like GitHub Pages, Netlify static hosting, or Vercel static/serverless.
- Every active browser session owns a backend child process, so anonymous
  public access can create real usage and cost.
- If you want a quick temporary demo instead of a hosted service, a Cloudflare
  Tunnel is the fastest option, but Render is the better always-on choice.
