---
title: Manage MCP servers from the web UI
---
# Manage MCP servers from the web UI

  ## What & Why
  The TUI lets users list, add, enable/disable, and remove MCP (Model Context Protocol) servers; the web app currently does none of that — users must edit `~/.codex/config.toml` by hand. Surfacing this in the browser brings the web app closer to TUI parity.

  ## Done looks like
  - A new "MCP Servers" section in the Settings modal (or its own panel) lists configured servers, their status, and tools.
  - Users can add a new server, toggle it on/off, and remove it from the browser. Changes persist to `~/.codex/config.toml` (or an equivalent per-session config the gateway controls).
  - MCP tool calls already render correctly in the transcript via the existing `mcp_tool_call` card; this task is purely about config management.

  ## Relevant files
  - `codex-rs/mcp-server/`, `codex-rs/mcp-client/`, `codex-rs/mcp-types/` — protocol & client used by the TUI.
  - `web/server.mjs` — add HTTP endpoints for list/add/remove/enable.
  - `web/public/app.js`, `web/public/styles.css` — the new UI surface.