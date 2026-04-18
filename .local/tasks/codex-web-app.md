# Codex Web App

## What & Why
Build a browser-based front-end for Codex CLI that delivers functional parity with `codex-tui`, deployed as a hosted web app. The Rust `app-server` runs on our hosted backend and performs all native work (shell exec, file edits, sandboxing, MCP, OAuth/keychain). The browser provides the UI: chat, streaming, tool calls, approvals, diffs, slash commands, MCP management, and login. End users only need a browser.

## Done looks like
- A user opens the deployed URL in any modern browser and can sign in with ChatGPT (OAuth) or paste an API key, with credentials stored per-user on the server.
- After login, the user lands on a chat session that streams assistant responses token-by-token, identical in content to what `codex-tui` shows.
- Tool calls (shell, apply_patch, file reads, MCP tools) render as structured cards with live status, output, and exit codes; long output is collapsible.
- Approval prompts (command exec, file write, network) appear as inline modal prompts with Allow / Allow once / Deny choices, matching the TUI's policy semantics.
- Patch/diff tool calls render a syntax-highlighted unified diff view per file.
- All TUI slash commands work in the web composer: `/reset`, `/status`, `/model`, `/resume`, `/compact`, `/approvals`, `/mcp`, `/login`, `/logout`, etc.
- A sessions list lets the user resume prior threads (`/resume` equivalent), with persistent storage across reconnects.
- Settings pages cover: model selection, approval policy, sandbox policy, MCP server configuration (add/remove/inspect tools), and account/login management.
- File-search (`@`-mention) works against the working directory the server is configured with, returning suggestions in the composer.
- Reconnect after a dropped WebSocket transparently resumes the active turn without losing streamed content.
- The deployed app passes an end-to-end browser test that signs in (mocked auth in test), runs a turn that triggers a tool call requiring approval, approves it, and verifies the streamed result.

## Out of scope
- Native iOS/Android apps.
- Editing files on the **user's** machine — all execution and FS access is server-side, by design of the chosen deployment model.
- Multi-tenant collaboration on a single thread (one user per session).
- Re-implementing Codex's agent logic in JS — we wrap the existing Rust `app-server` only.
- Changes to the TUI itself.

## Steps
1. **Backend gateway** — Stand up a hosted service that runs `codex app-server` (WebSocket JSON-RPC) per authenticated user session, fronted by an HTTP/WebSocket gateway that handles auth cookies, per-user working directories, and connection lifecycle. Each user gets an isolated working directory and credentials store.
2. **Auth layer** — Implement ChatGPT OAuth and API-key login flows in the browser, brokered through the server (since the server holds the Codex credentials). Browser receives only a session cookie; secrets never leave the server.
3. **Web client transport** — Build a TypeScript client that wraps `sdk/typescript` (or the JSON-RPC protocol directly) over a browser WebSocket, with reconnect/resume semantics tied to the active thread.
4. **Chat UI shell** — Implement the chat surface: composer with slash-command + `@`-file-search autocomplete, message list with streaming token deltas, role-based bubbles, and a sessions sidebar driven by the thread store.
5. **Tool-call & approval rendering** — Render every tool-call kind the TUI supports (shell, apply_patch, file read, MCP) as a structured card with status, stdout/stderr, exit codes, and collapsible long output. Implement the approval prompt UI matching `ask`/`allow`/`deny` semantics, including "allow once" vs "allow always for this session".
6. **Diff viewer** — Render `apply_patch` tool calls as per-file unified diffs with syntax highlighting and a summary header (files changed, +/- counts).
7. **Slash commands & settings** — Wire every TUI slash command to the corresponding `app-server` request, and add settings pages for model, approval policy, sandbox policy, MCP server add/remove/inspect, and account management.
8. **Deployment** — Containerize the gateway + `app-server` runtime, configure the hosting workflow on port 5000 with WebSocket upgrade, and document required env vars (OpenAI client id, session secret, etc.).
9. **End-to-end test** — Add a browser test (Playwright) that exercises the full path: load app, sign in (with mocked auth), send a message that triggers a tool call, approve it, and verify streamed output and final assistant message.

## Critical constraints
- Do not re-implement agent logic in JavaScript. The browser is a thin client; `app-server` remains the source of truth for sessions, tools, and policy.
- Never expose Codex credentials (API keys, OAuth tokens) to the browser. Only short-lived session cookies cross the wire.
- The WebSocket protocol and event names must follow `app-server-protocol` exactly — do not invent a parallel protocol.
- Each user session must run in an isolated working directory on the server; users must never be able to read or write another user's files via the agent.

## Relevant files
- `codex-rs/app-server`
- `codex-rs/app-server-protocol/src`
- `codex-rs/app-server-client/src/lib.rs`
- `codex-rs/tui/src/app.rs`
- `codex-rs/tui/src/app_server_session.rs`
- `codex-rs/tui/src/onboarding`
- `codex-rs/login/src`
- `codex-rs/exec`
- `codex-rs/mcp-server`
- `codex-rs/sandboxing`
- `codex-rs/file-search`
- `codex-rs/apply-patch`
- `codex-rs/keyring-store`
- `sdk/typescript/src`
- `sdk/typescript/package.json`
- `codex-cli/bin/codex.js`
