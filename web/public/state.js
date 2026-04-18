export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function load(key, fallback) {
  try {
    return { ...fallback, ...(JSON.parse(localStorage.getItem(key) ?? "{}")) };
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const state = {
  ws: null,
  reconnectAttempts: 0,
  whoami: null,
  threads: [],
  filterArchived: false,
  activeThreadId: null,
  activeTurnId: null,
  currentTurnRecordId: null,
  inFlight: false,
  initialized: false,
  authCard: null,
  pendingUploads: [],
  configSnapshot: null,
  configRequirements: null,
  experimentalFeatures: [],
  pending: new Map(),
  nextReqId: 1,
  itemsById: new Map(),
  itemOrder: [],
  itemTurnIndex: new Map(),
  turns: [],
  models: [],
  commandSessions: new Map(),
  previewUrlCache: new Map(),
  threadMenuOpenId: null,
  settings: load("settings", {
    model: "",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    networkAccessEnabled: false,
    modelReasoningEffort: "medium",
    webSearchMode: "disabled",
  }),
  slashCommands: [
    { name: "/new", desc: "Start a fresh conversation" },
    { name: "/resume", desc: "Resume a previous thread from the sidebar" },
    { name: "/fork", desc: "Fork the active thread" },
    { name: "/rename", desc: "Rename the active thread" },
    { name: "/archive", desc: "Archive the active thread" },
    { name: "/unarchive", desc: "Unarchive the active thread" },
    { name: "/rollback", desc: "Drop the most recent turns from the active thread" },
    { name: "/review", desc: "Run the reviewer on current changes" },
    { name: "/model", desc: "Choose the model for this session" },
    { name: "/approvals", desc: "Change approval policy" },
    { name: "/sandbox", desc: "Change sandbox policy" },
    { name: "/reasoning", desc: "Set reasoning effort" },
    { name: "/web-search", desc: "Toggle web search mode" },
    { name: "/network", desc: "Toggle network access in sandbox" },
    { name: "/settings", desc: "Open the settings panel" },
    { name: "/debug-config", desc: "Inspect the live config snapshot" },
    { name: "/experimental", desc: "List experimental features" },
    { name: "/skills", desc: "List live skills" },
    { name: "/apps", desc: "List live apps" },
    { name: "/plugins", desc: "List live plugins" },
    { name: "/feedback", desc: "Upload feedback" },
    { name: "/permissions", desc: "Show current permissions" },
    { name: "/status", desc: "Show current account, model, and policy" },
    { name: "/ps", desc: "Show tracked background or interactive sessions" },
    { name: "/stop", desc: "Stop tracked background or interactive sessions" },
    { name: "/login", desc: "Open the sign-in modal" },
    { name: "/logout", desc: "Sign out and clear credentials" },
    { name: "/clear", desc: "Clear the current transcript view" },
    { name: "/reset", desc: "Reset the current conversation context" },
    { name: "/compact", desc: "Compact the conversation history" },
    { name: "/mcp", desc: "Manage MCP servers" },
    { name: "/realtime", desc: "Realtime voice (CLI only in web build)" },
    { name: "/fast", desc: "Plan-usage toggle (CLI only in web build)" },
    { name: "/title", desc: "Terminal title (CLI only in web build)" },
    { name: "/statusline", desc: "Statusline control (CLI only in web build)" },
    { name: "/theme", desc: "Open appearance settings" },
    { name: "/help", desc: "Show available commands" },
  ],
};

if (typeof window !== "undefined") {
  window.state = state;
}

let autocompleteState = { kind: null, items: [], selected: 0, anchorStart: 0 };

export function getAutocompleteState() {
  return autocompleteState;
}

export function setAutocompleteState(nextState) {
  autocompleteState = nextState;
}
