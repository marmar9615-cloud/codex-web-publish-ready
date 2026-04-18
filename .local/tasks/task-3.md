---
title: Sign in with a ChatGPT account, not just an API key
---
# Sign in with a ChatGPT account, not just an API key

  ## What & Why
  The TUI supports two login methods: paste an OpenAI API key, or do an OAuth/device-code login with a ChatGPT account (which uses the user's existing subscription). The web app currently only supports the API-key flow. Adding ChatGPT login removes friction for users who don't have a raw API key.

  ## Done looks like
  - A "Sign in with ChatGPT" button on the login modal kicks off the OAuth/device-code flow.
  - Tokens are stored only on the server, tied to the existing `codexsid` cookie session.
  - The status bar shows whether the session is authenticated via API key vs. ChatGPT.

  ## Relevant files
  - `codex-rs/chatgpt/`, `codex-rs/login/` — reference implementation of the device-code flow used by the TUI/CLI.
  - `web/server.mjs` — `/api/login` endpoint and the in-memory session map; add an OAuth callback route.
  - `web/public/app.js` — `openLogin()` modal in `web/public/app.js`.