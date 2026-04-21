import {
  $,
  $$,
  state,
  save,
  getAutocompleteState,
  setAutocompleteState,
} from "./state.js";
import { escapeHtml } from "./utils.js";
import { showToast } from "./toast.js";
import { createUploads, hydrateWorkdirMedia } from "./uploads.js";
import { createRenderers, togglePinnedThread } from "./renderers.js";
import { createModals } from "./modals.js";
import { createFileTree } from "./filetree.js";
import { createLivePreview } from "./preview.js";
import { createMobilePreview } from "./mobile.js";
import { createSubagentPane } from "./subagents.js";
import { createTerminal } from "./terminal.js";
import { createTestRunner } from "./tests.js";
import { createTodoPane } from "./todos.js";
import { isSubagentThread } from "./subagent-meta.js";
import {
  createNotificationHandlers,
  isAuthErrorMessage,
} from "./notifications.js";
import { createRpc } from "./rpc.js";
import { createCommandHandler } from "./commands.js";

let transcriptAutoScroll = true;
let lastSubmittedTurn = null;

function isTranscriptNearBottom() {
  const transcript = $("#transcript");
  if (!transcript) return true;
  const threshold = 80;
  const distance =
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
  return distance <= threshold;
}

function scrollToBottom(options = {}) {
  const transcript = $("#transcript");
  if (!transcript) return;
  if (options.force || transcriptAutoScroll) {
    transcript.scrollTop = transcript.scrollHeight;
    transcriptAutoScroll = true;
    const jumpBtn = $("#transcript-jump-btn");
    if (jumpBtn) jumpBtn.hidden = true;
  }
}

function bindTranscriptScrollAffordance() {
  const transcript = $("#transcript");
  const jumpBtn = $("#transcript-jump-btn");
  if (!transcript || !jumpBtn) return;
  transcript.addEventListener("scroll", () => {
    transcriptAutoScroll = isTranscriptNearBottom();
    jumpBtn.hidden = transcriptAutoScroll;
  });
  jumpBtn.addEventListener("click", () => {
    scrollToBottom({ force: true });
    const input = $("#input");
    input?.focus();
  });
}

function setInFlight(value) {
  state.inFlight = value;
  $("#cancel-btn").hidden = !value;
  $("#send-btn").disabled = value;
  if (value) showThinkingIndicator();
  else hideThinkingIndicator();
}

function showThinkingIndicator() {
  const transcript = $("#transcript");
  if (!transcript) return;
  // Don't add duplicates — just keep the existing one pinned to the bottom.
  let existing = transcript.querySelector(".turn-thinking");
  if (!existing) {
    existing = document.createElement("div");
    existing.className = "turn-thinking";
    existing.setAttribute("role", "status");
    existing.setAttribute("aria-live", "polite");
    existing.innerHTML =
      '<span class="turn-thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>' +
      '<span class="turn-thinking-label">Codex is working…</span>';
  }
  transcript.appendChild(existing);
  scrollToBottom();
}

function hideThinkingIndicator() {
  const transcript = $("#transcript");
  const existing = transcript?.querySelector(".turn-thinking");
  if (existing) existing.remove();
}

const DOC_TITLE_BASE = "Codex Web";
const THREAD_TITLE_MAX = 60;

function truncateTitle(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length > THREAD_TITLE_MAX
    ? `${trimmed.slice(0, THREAD_TITLE_MAX - 1)}…`
    : trimmed;
}

function deriveThreadTitle(thread) {
  if (!thread) return "";
  if (typeof thread.name === "string" && thread.name.trim()) {
    return truncateTitle(thread.name);
  }
  if (typeof thread.preview === "string" && thread.preview.trim()) {
    return truncateTitle(thread.preview);
  }
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item?.type !== "userMessage") continue;
      const text = (item.content ?? [])
        .filter((part) => part?.type === "text")
        .map((part) => part.text ?? "")
        .join(" ")
        .trim();
      if (text) return truncateTitle(text);
    }
  }
  return "";
}

function setThreadTitle(title) {
  const label = title && title.trim() ? title.trim() : "New conversation";
  const node = $("#thread-title");
  if (node) node.textContent = label;
  document.title =
    label === "New conversation"
      ? DOC_TITLE_BASE
      : `${label} — ${DOC_TITLE_BASE}`;
}

function autoGrow(textarea) {
  const update = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  };
  textarea.addEventListener("input", update);
  update();
}

function autoGrowReset(textarea) {
  textarea.style.height = "auto";
}

function updateStatusBar() {
  const whoami = state.whoami ?? {};
  const backendPill = $("#backend-pill");
  backendPill.textContent = `backend: ${whoami.backend ?? "?"}`;
  backendPill.className = `pill ${whoami.backend === "real" ? "ok" : "warn"}`;
  $("#model-pill").textContent = `model: ${state.settings.model || "…"}`;
  $("#approval-pill").textContent =
    `approvals: ${state.settings.approvalPolicy}`;
  $("#sandbox-pill").textContent = `sandbox: ${state.settings.sandboxMode}`;
}

function persistComposerFlags() {
  save("composerFlags", state.composerFlags);
}

function renderComposerMode() {
  const enabled = Boolean(state.composerFlags.planMode);
  const button = $("#plan-mode-toggle");
  if (button) {
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.classList.toggle("primary", enabled);
    button.classList.toggle("ghost", !enabled);
  }
  const banner = $("#composer-plan-banner");
  if (banner) {
    banner.hidden = !enabled;
  }
}

function setPlanMode(enabled) {
  state.composerFlags.planMode = Boolean(enabled);
  persistComposerFlags();
  renderComposerMode();
}

const renderers = createRenderers({
  openThread: (threadId) => void openThread(threadId),
  onThreadAction: (action, thread) => handleThreadAction(action, thread),
  onProjectAction: (action, project) => handleProjectAction(action, project),
  onRollbackToItem: (itemId) => rollbackToItem(itemId),
  onEditItem: (itemId) => void editAndResendItem(itemId),
  onForkFromItem: (itemId) => void forkFromItem(itemId),
  onRetryFromItem: (itemId) => void retryFromItem(itemId),
  openLogin: () => modals.openLogin(),
  scrollToBottom,
  hydrateWorkdirMedia,
  afterUpsertItem: (item, isStart, isComplete) =>
    trackAfterUpsertItem(item, isStart, isComplete),
});

const uploads = createUploads({
  appendSystem: renderers.appendSystem,
});

let notificationHandlers = {
  onNotification: () => {},
  onServerRequest: () => {},
};

const rpc = createRpc({
  onNotification: (...args) => notificationHandlers.onNotification(...args),
  onServerRequest: (...args) => notificationHandlers.onServerRequest(...args),
  refreshWhoAmI,
  refreshThreads,
  refreshModels,
  refreshAccount,
  refreshRateLimits,
  refreshConfigState,
  refreshExperimentalFeatures,
  pushSettingsToBackend,
  appendSystem: renderers.appendSystem,
  setInFlight,
});

const modals = createModals({
  rpcCall: rpc.rpcCall,
  rpcRaw: rpc.rpcRaw,
  rpcReply: rpc.rpcReply,
  refreshModels,
  refreshWhoAmI,
  refreshAccount,
  refreshConfigState,
  refreshExperimentalFeatures,
  pushSettingsToBackend,
  updateStatusBar,
  appendSystem: renderers.appendSystem,
  clearAuthRequiredCard: renderers.clearAuthRequiredCard,
});

const fileTree = createFileTree({
  rpcCall: rpc.rpcCall,
  appendSystem: renderers.appendSystem,
});

const testRunner = createTestRunner({
  rpcCall: rpc.rpcCall,
  appendSystem: renderers.appendSystem,
});

const livePreview = createLivePreview({
  appendSystem: renderers.appendSystem,
});

const mobilePreview = createMobilePreview({
  appendSystem: renderers.appendSystem,
});

const terminal = createTerminal({
  appendSystem: renderers.appendSystem,
});

const todoPane = createTodoPane();
const subagentPane = createSubagentPane({
  rpcCall: rpc.rpcCall,
  openThread,
  appendSystem: renderers.appendSystem,
});

notificationHandlers = createNotificationHandlers({
  rpcReply: rpc.rpcReply,
  rpcRaw: rpc.rpcRaw,
  refreshModels,
  refreshWhoAmI,
  refreshAccount,
  renderAccount: renderers.renderAccount,
  renderAccountPill: renderers.renderAccountPill,
  renderApproval: renderers.renderApproval,
  renderRatePill: renderers.renderRatePill,
  renderThreads: renderers.renderThreads,
  renderTokenPill: renderers.renderTokenPill,
  upsertItem: renderers.upsertItem,
  appendStreamDelta: renderers.appendStreamDelta,
  appendMcpProgress: renderers.appendMcpProgress,
  appendSystem: renderers.appendSystem,
  clearAuthRequiredCard: renderers.clearAuthRequiredCard,
  showAuthRequiredCard: renderers.showAuthRequiredCard,
  setInFlight,
  updateStatusBar,
  openUserInputModal: modals.openUserInputModal,
  openElicitationModal: modals.openElicitationModal,
  openPermissionsModal: modals.openPermissionsModal,
  onThreadStarted,
  onTurnStarted,
  onTurnFinished,
  onPlanUpdated: (params) => todoPane.update(params),
  onFsChanged: (params) => void fileTree.handleFsChanged(params),
  onStandaloneCommandDelta,
  retryLastTurn,
  canRetryLastTurn,
  setThreadTitle,
});

const handleSlash = createCommandHandler({
  newThread,
  clearTranscript: renderers.clearTranscript,
  openSettings: modals.openSettings,
  openLogin: modals.openLogin,
  doLogout,
  openMcpModal: modals.openMcpModal,
  openSkillsModal: modals.openSkillsModal,
  openPluginsModal: modals.openPluginsModal,
  openAppsModal: modals.openAppsModal,
  openJsonModal: modals.openJsonModal,
  openListModal: modals.openListModal,
  appendSystem: renderers.appendSystem,
  updateStatusBar,
  refreshConfigState,
  rpcCall: rpc.rpcCall,
  showCliOnlyBanner,
  interruptTurn,
  handleThreadAction,
  rollbackTurns,
});

async function bootstrap() {
  applyPersistedSidebarState();
  // Wire the Files/Todos toggle handlers and set their initial visibility
  // BEFORE the network fetches below — otherwise a user clicking during the
  // first few hundred ms lands on an unbound button and the first click is
  // silently dropped (next click works, producing the "two clicks to open"
  // bug reported in audit #8).
  fileTree.init();
  todoPane.init();
  await refreshWhoAmI();
  await refreshProjects();
  await refreshThreads();
  bindUi();
  renderComposerMode();
  livePreview.init();
  mobilePreview.init();
  terminal.init();
  testRunner.init();
  subagentPane.init();
  window.addEventListener("codex:planUpdated", (event) => {
    todoPane.update(event.detail ?? {});
  });
  window.addEventListener("codex:refreshSubagents", () => {
    void subagentPane.refresh();
  });
  rpc.connectWs();
  updateStatusBar();
  uploads.renderPendingUploads();
}

async function refreshWhoAmI() {
  const response = await fetch("/api/whoami");
  state.whoami = await response.json();
  renderers.renderAccount();
  renderers.renderAccountPill();
  updateStatusBar();
  if (state.initialized) {
    await fileTree.refresh().catch((error) => {
      console.warn("workspace refresh failed", error.message);
    });
    await livePreview.refresh().catch((error) => {
      console.warn("preview refresh failed", error.message);
    });
    await mobilePreview.refresh().catch((error) => {
      console.warn("mobile preview refresh failed", error.message);
    });
    await terminal.refresh().catch((error) => {
      console.warn("terminal refresh failed", error.message);
    });
    await testRunner.refresh().catch((error) => {
      console.warn("test runner refresh failed", error.message);
    });
  }
}

async function refreshProjects() {
  try {
    const response = await fetch("/api/projects");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? `project list failed (${response.status})`);
    }
    state.projects = data.projects ?? [];
  } catch (error) {
    console.warn("project list failed", error.message);
    state.projects = [];
  }
  renderers.renderProjects();
}

async function refreshThreads() {
  try {
    if (state.initialized) {
      const response = await rpc.rpcCall("thread/list", { limit: 100 });
      state.threads = (response?.data ?? []).map((thread) => ({
        id: thread.id,
        name: thread.name ?? thread.preview ?? thread.id,
        preview: thread.preview ?? "",
        source: thread.source ?? null,
        agentNickname: thread.agentNickname ?? null,
        agentRole: thread.agentRole ?? null,
        turns: thread.turns ?? [],
        lastActive:
          (thread.updatedAt ??
            thread.createdAt ??
            Math.floor(Date.now() / 1000)) * 1000,
        status: thread.status ?? "active",
        archived: thread.status === "archived",
      }));
    } else {
      const response = await fetch("/api/threads");
      const data = await response.json();
      state.threads = data.threads ?? [];
    }
  } catch (error) {
    console.warn("thread list failed", error.message);
  }
  renderers.renderThreads();
  await subagentPane.refresh().catch((error) => {
    console.warn("sub-agent pane refresh failed", error.message);
  });
}

function modelSlug(model) {
  if (!model || typeof model !== "object") return "";
  return model.id ?? model.slug ?? model.model ?? "";
}

async function refreshModels() {
  if (!state.initialized) return;
  try {
    const response = await rpc.rpcCall("model/list", {
      limit: 100,
      includeHidden: false,
    });
    const models = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.models)
        ? response.models
        : [];
    state.models = models;
    if (models.length) {
      const slugs = new Set(models.map(modelSlug).filter(Boolean));
      const current = state.settings.model;
      if (!current || !slugs.has(current)) {
        const pick = models.find((model) => model.isDefault) ?? models[0];
        const slug = modelSlug(pick);
        if (slug) {
          state.settings.model = slug;
          save("settings", state.settings);
        }
      }
    }
    updateStatusBar();
  } catch (error) {
    console.warn("model/list failed", error.message);
  }
}

async function refreshAccount() {
  if (!state.initialized) return;
  try {
    const result = await rpc.rpcCall("account/read", { refreshToken: false });
    const account = result?.account ?? null;
    if (account?.type === "chatgpt") {
      state.whoami = {
        ...(state.whoami ?? {}),
        hasOauth: true,
        hasApiKey: false,
        authMethod: "chatgptAuthTokens",
        account: {
          email: account.email ?? state.whoami?.account?.email ?? null,
          planType: account.planType ?? state.whoami?.account?.planType ?? null,
          chatgptAccountId: state.whoami?.account?.chatgptAccountId ?? null,
        },
      };
      renderers.renderAccount();
      renderers.renderAccountPill();
    }
  } catch (error) {
    console.warn("account/read failed", error.message);
  }
}

async function refreshRateLimits() {
  if (!state.initialized) return;
  try {
    const result = await rpc.rpcCall("account/rateLimits/read", {});
    renderers.renderRatePill(result?.rateLimits ?? null);
  } catch (error) {
    console.warn("account/rateLimits/read failed", error.message);
  }
}

async function refreshConfigState() {
  if (!state.initialized) return;
  try {
    state.configSnapshot = await rpc.rpcCall("config/read", {
      includeLayers: true,
      cwd: state.whoami?.workdir ?? null,
    });
    state.configRequirements = await rpc
      .rpcCall("configRequirements/read", {})
      .catch(() => ({ requirements: null }));
  } catch (error) {
    console.warn("config/read failed", error.message);
  }
}

async function refreshExperimentalFeatures() {
  if (!state.initialized) return;
  try {
    const response = await rpc.rpcCall("experimentalFeature/list", {
      limit: 100,
    });
    state.experimentalFeatures = response?.data ?? [];
  } catch (error) {
    console.warn("experimentalFeature/list failed", error.message);
  }
}

async function pushSettingsToBackend() {
  if (!state.initialized) return;
  const settings = state.settings;
  const edits = [
    ...(settings.model
      ? [{ keyPath: "model", value: settings.model, mergeStrategy: "replace" }]
      : []),
    {
      keyPath: "model_reasoning_effort",
      value: settings.modelReasoningEffort,
      mergeStrategy: "replace",
    },
    {
      keyPath: "approval_policy",
      value: settings.approvalPolicy,
      mergeStrategy: "replace",
    },
    {
      keyPath: "sandbox_mode",
      value: settings.sandboxMode,
      mergeStrategy: "replace",
    },
    {
      keyPath: "tools.web_search",
      value: settings.webSearchMode !== "disabled",
      mergeStrategy: "replace",
    },
  ];
  await rpc
    .rpcCall("config/batchWrite", {
      edits,
      expectedVersion: state.configSnapshot?.layers?.[0]?.version ?? null,
      reloadUserConfig: true,
    })
    .catch(() => {});
}

function clearConversationState() {
  state.activeTurnId = null;
  state.currentTurnRecordId = null;
  todoPane.clear();
  renderers.clearTranscript();
  // Switching threads or starting fresh: snap back to bottom.
  transcriptAutoScroll = true;
  const jumpBtn = $("#transcript-jump-btn");
  if (jumpBtn) jumpBtn.hidden = true;
}

function hydrateThread(thread) {
  clearConversationState();
  if (!thread) return;
  setThreadTitle(deriveThreadTitle(thread));
  state.activeThreadId = thread.id;
  for (const turn of thread.turns ?? []) {
    const turnIndex = state.turns.length;
    const record = {
      id: turn.id ?? `turn-${turnIndex}`,
      status: turn.status ?? "completed",
      items: [...(turn.items ?? [])],
    };
    state.turns.push(record);
    for (const item of record.items) {
      state.itemTurnIndex.set(item.id, turnIndex);
      renderers.upsertItem(item, true, true);
    }
  }
  renderers.renderThreads();
}

async function openThread(threadId) {
  state.activeThreadId = threadId;
  state.activeTurnId = null;
  // Prefer any title we already have from the sidebar list; otherwise keep a
  // friendly placeholder until thread/read hydrates the real data.
  const existingThread = state.threads.find((entry) => entry.id === threadId);
  setThreadTitle(
    deriveThreadTitle(existingThread) || "Loading conversation…",
  );
  clearConversationState();
  renderers.renderThreads();
  void subagentPane.refresh();
  try {
    try {
      const response = await rpc.rpcCall("thread/read", {
        threadId,
        includeTurns: true,
      });
      if (response?.thread) hydrateThread(response.thread);
    } catch (error) {
      console.warn(
        "thread/read failed, resuming without hydration",
        error.message,
      );
    }
    await rpc.rpcCall("thread/resume", {
      threadId,
      persistExtendedHistory: true,
    });
    renderers.appendSystem(`Resumed thread ${threadId}.`);
  } catch (error) {
    renderers.appendSystem(
      `Could not resume ${threadId}: ${error.message}`,
      "error",
    );
  }
}

function newThread() {
  if (state.activeThreadId && state.activeTurnId) {
    void rpc
      .rpcCall("turn/interrupt", {
        threadId: state.activeThreadId,
        turnId: state.activeTurnId,
      })
      .catch(() => {});
  }
  state.activeThreadId = null;
  state.activeTurnId = null;
  setThreadTitle("");
  clearConversationState();
  renderers.renderThreads();
  void subagentPane.refresh();
}

function onThreadStarted(thread) {
  if (!thread?.id) return;
  const existing = state.threads.find((entry) => entry.id === thread.id);
  const snapshot = {
    id: thread.id,
    name: thread.name ?? thread.preview ?? thread.id,
    preview: thread.preview ?? "",
    source: thread.source ?? null,
    agentNickname: thread.agentNickname ?? null,
    agentRole: thread.agentRole ?? null,
    turns: thread.turns ?? [],
    lastActive:
      (thread.updatedAt ?? thread.createdAt ?? Math.floor(Date.now() / 1000)) *
      1000,
    status: thread.status ?? "active",
    archived: thread.status === "archived",
  };
  if (existing) Object.assign(existing, snapshot);
  else state.threads.unshift(snapshot);
  if (!isSubagentThread(thread)) {
    state.activeThreadId = thread.id;
    setThreadTitle(deriveThreadTitle(thread));
  }
  void subagentPane.refresh();
}

function onTurnStarted(turn) {
  const turnId = turn?.id ?? state.activeTurnId;
  if (!turnId) return;
  state.currentTurnRecordId = turnId;
  if (!state.turns.some((record) => record.id === turnId)) {
    state.turns.push({
      id: turnId,
      status: turn?.status ?? "inProgress",
      items: [],
    });
  }
  collapseOlderReasoning();
}

function collapseOlderReasoning() {
  const transcript = document.getElementById("transcript");
  if (!transcript) return;
  transcript.querySelectorAll("details.reasoning[open]").forEach((node) => {
    node.removeAttribute("open");
  });
}

function onTurnFinished(turn) {
  const turnId = turn?.id ?? state.currentTurnRecordId;
  if (!turnId) return;
  const record = state.turns.find((entry) => entry.id === turnId);
  if (record) record.status = turn?.status ?? record.status;
  state.currentTurnRecordId = null;
  if ((turn?.status ?? "completed") === "completed") {
    void maybeAutoNameThread();
  }
}

// Threads we've already tried to auto-name in this tab, so we don't spam
// `thread/name/set` after every subsequent turn.
const autoNamedThreadIds = new Set();

async function maybeAutoNameThread() {
  const threadId = state.activeThreadId;
  if (!threadId || autoNamedThreadIds.has(threadId)) return;
  const snapshot = state.threads.find((entry) => entry.id === threadId);
  if (snapshot && isSubagentThread(snapshot)) return;
  const existingName =
    typeof snapshot?.name === "string" ? snapshot.name.trim() : "";
  // Don't rename user-labelled threads, and don't rename if the current name is
  // already a non-UUID string (server may have set it upstream).
  if (existingName && existingName !== threadId) {
    autoNamedThreadIds.add(threadId);
    return;
  }
  // Find the first user message across the transcript.
  let firstUserText = "";
  for (const record of state.turns) {
    for (const item of record.items ?? []) {
      if (item?.type !== "userMessage") continue;
      const text = (item.content ?? [])
        .filter((part) => part?.type === "text")
        .map((part) => part.text ?? "")
        .join(" ")
        .trim();
      if (text) {
        firstUserText = text;
        break;
      }
    }
    if (firstUserText) break;
  }
  if (!firstUserText) return;
  const name = truncateTitle(firstUserText);
  if (!name) return;
  autoNamedThreadIds.add(threadId);
  try {
    await rpc.rpcCall("thread/name/set", { threadId, name });
    // Optimistically update local state; the server broadcasts
    // `thread/name/updated` which will also refresh the sidebar via
    // the notification handler.
    if (snapshot) snapshot.name = name;
    if (state.activeThreadId === threadId) setThreadTitle(name);
  } catch (error) {
    // Auto-naming is best-effort; log and move on so a failure here doesn't
    // surface as a user-facing error.
    console.warn("auto thread/name/set failed", error?.message ?? error);
    autoNamedThreadIds.delete(threadId);
  }
}

function syncCommandSessionFromItem(item) {
  if (item.type !== "commandExecution" || !item.processId) return;
  if (item.status === "inProgress") {
    state.commandSessions.set(item.processId, {
      processId: item.processId,
      source: "thread",
      threadId: state.activeThreadId,
      itemId: item.id,
      command: item.command,
      cwd: item.cwd,
      status: item.status,
      output: item.aggregatedOutput ?? "",
    });
    return;
  }
  state.commandSessions.delete(item.processId);
}

function trackAfterUpsertItem(item) {
  if (state.activeTurnId) {
    let turnIndex = state.turns.findIndex(
      (record) => record.id === state.activeTurnId,
    );
    if (turnIndex === -1) {
      state.turns.push({
        id: state.activeTurnId,
        status: "inProgress",
        items: [],
      });
      turnIndex = state.turns.length - 1;
    }
    const record = state.turns[turnIndex];
    const itemIndex = record.items.findIndex((entry) => entry.id === item.id);
    if (itemIndex >= 0) record.items[itemIndex] = item;
    else record.items.push(item);
    state.itemTurnIndex.set(item.id, turnIndex);
  }
  syncCommandSessionFromItem(item);
}

function decodeBase64Utf8(value) {
  try {
    return atob(value ?? "");
  } catch {
    return "";
  }
}

function onStandaloneCommandDelta(params) {
  const processId = params.processId;
  if (!processId) return;
  const existing = state.commandSessions.get(processId) ?? {
    processId,
    source: "standalone",
    status: "inProgress",
    output: "",
  };
  const delta = decodeBase64Utf8(params.deltaBase64 ?? "");
  existing.output = `${existing.output ?? ""}${delta}`;
  existing.stream = params.stream ?? "stdout";
  existing.capReached = params.capReached ?? false;
  state.commandSessions.set(processId, existing);
  testRunner.handleOutputDelta(params);
}

async function rollbackTurns(numTurns) {
  if (!state.activeThreadId) return;
  try {
    const result = await rpc.rpcCall("thread/rollback", {
      threadId: state.activeThreadId,
      numTurns,
    });
    if (result?.thread) {
      hydrateThread(result.thread);
      renderers.appendSystem(
        `Rolled back ${numTurns} turn${numTurns === 1 ? "" : "s"}.`,
      );
    }
  } catch (error) {
    renderers.appendSystem(`rollback failed: ${error.message}`, "error");
  }
}

async function rollbackToItem(itemId) {
  const turnIndex = state.itemTurnIndex.get(itemId);
  if (turnIndex == null) {
    renderers.appendSystem(
      "Could not determine the turn for that rollback point.",
      "error",
    );
    return;
  }
  const numTurns = state.turns.length - turnIndex;
  if (numTurns < 1) {
    renderers.appendSystem("There are no later turns to roll back.", "error");
    return;
  }
  await rollbackTurns(numTurns);
}

function getUserMessageText(itemId) {
  const entry = state.itemsById.get(itemId);
  const item = entry?.item;
  if (!item || item.type !== "userMessage") return "";
  return (item.content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

async function editAndResendItem(itemId) {
  const text = getUserMessageText(itemId);
  await rollbackToItem(itemId);
  const input = $("#input");
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  try {
    input.setSelectionRange(input.value.length, input.value.length);
  } catch {}
}

async function retryFromItem(itemId) {
  const text = getUserMessageText(itemId);
  if (!text) return;
  await rollbackToItem(itemId);
  void startTurn(text, { uploads: [], isRetry: true });
}

async function forkFromItem(itemId) {
  if (!state.activeThreadId) return;
  const turnIndex = state.itemTurnIndex.get(itemId);
  if (turnIndex == null) {
    renderers.appendSystem(
      "Could not determine the turn to fork from.",
      "error",
    );
    return;
  }
  const turnsToDrop = Math.max(0, state.turns.length - turnIndex - 1);
  try {
    const result = await rpc.rpcCall("thread/fork", {
      threadId: state.activeThreadId,
      persistExtendedHistory: true,
    });
    const nextThread = result?.thread ?? result;
    if (!nextThread?.id) {
      renderers.appendSystem("fork failed: no thread returned", "error");
      return;
    }
    await openThread(nextThread.id);
    if (turnsToDrop > 0) {
      await rpc
        .rpcCall("thread/rollback", {
          threadId: nextThread.id,
          numTurns: turnsToDrop,
        })
        .catch((error) =>
          renderers.appendSystem(
            `fork rollback failed: ${error.message}`,
            "error",
          ),
        );
    }
    renderers.appendSystem("Forked thread from this point.");
  } catch (error) {
    renderers.appendSystem(`fork failed: ${error.message}`, "error");
  }
}

async function shareThread(threadId) {
  const response = await rpc.rpcCall("thread/read", {
    threadId,
    includeTurns: true,
  });
  const thread = response?.thread;
  if (!thread?.id) {
    throw new Error("thread snapshot unavailable");
  }
  const shareResponse = await fetch(
    `/api/threads/${encodeURIComponent(threadId)}/share`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "readonly",
        ttl: 7 * 24 * 60 * 60,
        thread,
      }),
    },
  );
  const data = await shareResponse.json().catch(() => ({}));
  if (!shareResponse.ok) {
    throw new Error(data.error ?? `share failed (${shareResponse.status})`);
  }
  const shareUrl = data.shareUrl
    ? String(data.shareUrl)
    : new URL(String(data.sharePath ?? ""), window.location.origin).toString();
  try {
    await navigator.clipboard.writeText(shareUrl);
    renderers.appendSystem(`Copied share link: ${shareUrl}`);
  } catch {
    renderers.appendSystem(`Share link: ${shareUrl}`);
    window.prompt("Copy share link", shareUrl);
  }
  window.open(shareUrl, "_blank", "noopener");
}

async function handleThreadAction(action, thread) {
  const threadId = thread?.id ?? state.activeThreadId;
  if (!threadId) return;
  switch (action) {
    case "fork": {
      const result = await rpc
        .rpcCall("thread/fork", {
          threadId,
          persistExtendedHistory: true,
        })
        .catch((error) => {
          renderers.appendSystem(`fork failed: ${error.message}`, "error");
          return null;
        });
      const nextThread = result?.thread ?? result;
      if (nextThread?.id) await openThread(nextThread.id);
      return;
    }
    case "duplicate": {
      const forkResult = await rpc
        .rpcCall("thread/fork", {
          threadId,
          persistExtendedHistory: true,
        })
        .catch((error) => {
          renderers.appendSystem(`duplicate failed: ${error.message}`, "error");
          return null;
        });
      const newThread = forkResult?.thread ?? forkResult;
      if (!newThread?.id) return;
      const baseName = thread?.name ?? thread?.preview ?? thread?.id ?? "thread";
      const copyName = `${baseName} (copy)`;
      await rpc
        .rpcCall("thread/name/set", {
          threadId: newThread.id,
          name: copyName,
        })
        .catch(() => {});
      await refreshThreads().catch(() => {});
      await openThread(newThread.id);
      renderers.appendSystem(`Duplicated as "${copyName}".`);
      return;
    }
    case "export": {
      try {
        const response = await rpc.rpcCall("thread/read", {
          threadId,
          includeTurns: true,
        });
        const payload = {
          exportedAt: new Date().toISOString(),
          thread: response?.thread ?? response ?? { id: threadId },
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        const safeName = String(thread?.name ?? thread?.id ?? "thread")
          .replace(/[^a-z0-9-_]+/gi, "_")
          .slice(0, 64);
        anchor.download = `${safeName || "thread"}-${threadId.slice(0, 8)}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        renderers.appendSystem(`Exported thread as ${anchor.download}.`);
      } catch (error) {
        renderers.appendSystem(`export failed: ${error.message}`, "error");
      }
      return;
    }
    case "share":
      await shareThread(threadId).catch((error) =>
        renderers.appendSystem(`share failed: ${error.message}`, "error"),
      );
      return;
    case "rename": {
      const proposed = thread?.promptDefault ?? thread?.name ?? "";
      const name = prompt("New thread name:", proposed);
      if (!name) return;
      await rpc
        .rpcCall("thread/name/set", { threadId, name })
        .then(async () => {
          const active = state.threads.find((entry) => entry.id === threadId);
          if (active) active.name = name;
          if (state.activeThreadId === threadId) setThreadTitle(name);
          await refreshThreads();
        })
        .catch((error) =>
          renderers.appendSystem(`rename failed: ${error.message}`, "error"),
        );
      return;
    }
    case "archive":
      await rpc
        .rpcCall("thread/archive", { threadId })
        .then(refreshThreads)
        .catch((error) =>
          renderers.appendSystem(`archive failed: ${error.message}`, "error"),
        );
      return;
    case "unarchive":
      await rpc
        .rpcCall("thread/unarchive", { threadId })
        .then(refreshThreads)
        .catch((error) =>
          renderers.appendSystem(`unarchive failed: ${error.message}`, "error"),
        );
      return;
    case "copyId":
      try {
        await navigator.clipboard.writeText(threadId);
        renderers.appendSystem(`Copied thread id ${threadId}.`);
      } catch {
        renderers.appendSystem(`Thread id: ${threadId}`);
      }
      return;
    case "pin":
    case "unpin": {
      const nowPinned = togglePinnedThread(threadId);
      renderers.renderThreads();
      renderers.appendSystem(
        nowPinned ? "Pinned thread to top." : "Unpinned thread.",
      );
      return;
    }
    default:
      return;
  }
}

function bindUi() {
  $("#composer").addEventListener("submit", onSubmit);
  $("#cancel-btn").addEventListener("click", () => void interruptTurn());
  $("#new-thread").addEventListener("click", newThread);
  $("#sidebar-toggle-btn")?.addEventListener("click", toggleSidebar);
  bindWorkspaceTabs();
  bindTranscriptScrollAffordance();
  $("#workspace-run-tests-btn")?.addEventListener("click", () => {
    activateWorkspaceTab("runner");
    void testRunner.runDetectedTests();
  });
  $("#account-btn").addEventListener("click", onAccountClick);
  $("#settings-btn").addEventListener("click", () => modals.openSettings());
  $("#workspace-github-btn")?.addEventListener("click", () => {
    void modals.openProjectToolsModal("git");
  });
  $("#workspace-deploy-btn")?.addEventListener("click", () => {
    void modals.openProjectToolsModal("deploy");
  });
  $("#workspace-ship-btn")?.addEventListener("click", () => {
    void modals.openProjectToolsModal("ship");
  });
  $("#plan-mode-toggle")?.addEventListener("click", () => {
    setPlanMode(!state.composerFlags.planMode);
  });
  $("#new-project-btn")?.addEventListener("click", () => {
    void createProject();
  });
  $("#attach-btn")?.addEventListener("click", () =>
    $("#attach-input")?.click(),
  );
  $("#attach-input")?.addEventListener("change", uploads.onAttachChange);
  $("#thread-filter-active")?.addEventListener("click", () => {
    state.filterArchived = false;
    renderers.renderThreads();
  });
  $("#thread-filter-archived")?.addEventListener("click", () => {
    state.filterArchived = true;
    renderers.renderThreads();
  });
  $("#thread-search")?.addEventListener("input", (event) => {
    state.threadSearchQuery = event.target.value ?? "";
    renderers.renderThreads();
  });
  $("#model-pill")?.addEventListener("click", () => {
    modals.openModelPickerModal();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".thread-actions") && state.threadMenuOpenId) {
      state.threadMenuOpenId = null;
      renderers.renderThreads();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.threadMenuOpenId) {
      state.threadMenuOpenId = null;
      renderers.renderThreads();
    }
  });

  const input = $("#input");
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("paste", uploads.onComposerPaste);
  uploads.bindDragAndDrop?.($("#composer"));
  autoGrow(input);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }
    if (document.querySelector("#modal-root .modal-backdrop")) return;
    event.preventDefault();
    modals.openShortcutsModal();
  });

  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const modalOpen = Boolean(document.querySelector("#modal-root .modal-backdrop"));
    const key = event.key.toLowerCase();
    if (key === "b" && !event.shiftKey && !modalOpen) {
      event.preventDefault();
      toggleSidebar();
      return;
    }
    if (key === "n" && !event.shiftKey && !modalOpen) {
      event.preventDefault();
      newThread();
      return;
    }
    if (key === "," && !event.shiftKey && !modalOpen) {
      event.preventDefault();
      modals.openSettings();
      return;
    }
    if (key === "k" && !event.shiftKey && !modalOpen) {
      event.preventDefault();
      openCommandPalette();
      return;
    }
  });
}

function toggleSidebar() {
  const next = !document.body.classList.contains("sidebar-collapsed");
  document.body.classList.toggle("sidebar-collapsed", next);
  try {
    localStorage.setItem("sidebarCollapsed", next ? "1" : "0");
  } catch {}
}

function applyPersistedSidebarState() {
  try {
    const stored = localStorage.getItem("sidebarCollapsed");
    if (stored === "1") {
      document.body.classList.add("sidebar-collapsed");
    }
  } catch {}
}

function activateWorkspaceTab(name) {
  const valid = new Set(["terminal", "preview", "mobile", "runner"]);
  const target = valid.has(name) ? name : "terminal";
  for (const tab of document.querySelectorAll(".workspace-tab")) {
    const active = tab.dataset.workspaceTab === target;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const pane of document.querySelectorAll(".workspace-tab-pane")) {
    const active = pane.dataset.workspacePane === target;
    pane.hidden = !active;
    pane.classList.toggle("active", active);
  }
  try {
    localStorage.setItem("workspaceTab", target);
  } catch {}
}

function bindWorkspaceTabs() {
  for (const tab of document.querySelectorAll(".workspace-tab")) {
    tab.addEventListener("click", () => {
      activateWorkspaceTab(tab.dataset.workspaceTab ?? "terminal");
    });
  }
  let initial = "terminal";
  try {
    initial = localStorage.getItem("workspaceTab") ?? "terminal";
  } catch {}
  activateWorkspaceTab(initial);
}

function focusComposerAndOpenSlash() {
  const input = $("#input");
  if (!input) return;
  input.focus();
  if (input.value.trim().length === 0) {
    input.value = "/";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function buildPaletteActions() {
  const actions = [];
  for (const entry of state.slashCommands ?? []) {
    if (entry.disabled || entry.cliOnly) continue;
    actions.push({
      id: `slash:${entry.name}`,
      label: entry.name,
      hint: entry.desc ?? "",
      group: "Slash",
      run: () => {
        handleSlash(entry.name);
      },
    });
  }
  actions.push(
    {
      id: "ui:new-thread",
      label: "New thread",
      hint: "Start a fresh conversation",
      group: "Navigate",
      run: () => newThread(),
    },
    {
      id: "ui:toggle-sidebar",
      label: "Toggle sidebar",
      hint: "Show or hide the thread sidebar (⌘B)",
      group: "View",
      run: () => toggleSidebar(),
    },
    {
      id: "ui:toggle-workspace",
      label: "Toggle workspace panel",
      hint: "Show or hide the file tree and tools pane",
      group: "View",
      run: () => {
        $("#workspace-toggle-btn")?.click();
      },
    },
    {
      id: "ui:settings",
      label: "Open settings",
      hint: "Manage hooks, models, policies (⌘,)",
      group: "Open",
      run: () => modals.openSettings(),
    },
    {
      id: "ui:shortcuts",
      label: "Keyboard shortcuts",
      hint: "See every shortcut",
      group: "Open",
      run: () => modals.openShortcutsModal?.(),
    },
    {
      id: "ui:mcp",
      label: "MCP servers",
      hint: "Connect and manage MCP servers",
      group: "Open",
      run: () => modals.openMcpModal(),
    },
    {
      id: "ui:skills",
      label: "Skills",
      hint: "Enable or disable skills",
      group: "Open",
      run: () => modals.openSkillsModal(),
    },
    {
      id: "ui:plugins",
      label: "Plugins",
      hint: "Manage installed plugins",
      group: "Open",
      run: () => modals.openPluginsModal(),
    },
    {
      id: "ui:apps",
      label: "Apps",
      hint: "Browse installed apps",
      group: "Open",
      run: () => modals.openAppsModal(),
    },
    {
      id: "ui:deploy",
      label: "Deploy…",
      hint: "Manage connected deploy providers",
      group: "Open",
      run: () => void modals.openProjectToolsModal?.("deploy"),
    },
    {
      id: "ui:github",
      label: "GitHub…",
      hint: "Connect GitHub, clone, commit, push, or open a PR",
      group: "Open",
      run: () => void modals.openProjectToolsModal?.("git"),
    },
    {
      id: "ui:export-thread",
      label: "Export current thread",
      hint: "Download this thread as JSON",
      group: "Thread",
      run: () => {
        if (!state.activeThreadId) {
          renderers.appendSystem("No active thread to export.", "error");
          return;
        }
        void handleThreadAction("export", {
          id: state.activeThreadId,
          name: $("#thread-title")?.textContent ?? state.activeThreadId,
        });
      },
    },
  );
  return actions.filter((action) => typeof action.run === "function");
}

function fuzzyScore(query, text) {
  if (!query) return 1;
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  if (haystack.includes(needle)) return 3 - haystack.indexOf(needle) / 100;
  let index = 0;
  for (const char of needle) {
    const next = haystack.indexOf(char, index);
    if (next === -1) return 0;
    index = next + 1;
  }
  return 1;
}

function renderPaletteList(mount, actions, query, selectedIndex, recentIds = []) {
  const list = mount.querySelector("#palette-list");
  if (!list) return;
  const trimmed = (query ?? "").trim();
  const actionsById = new Map(actions.map((action) => [action.id, action]));
  let entries;
  let recentStart = -1;
  let recentEnd = -1;
  if (!trimmed) {
    const recentActions = recentIds
      .map((id) => actionsById.get(id))
      .filter(Boolean);
    const recentSet = new Set(recentActions.map((action) => action.id));
    const others = actions.filter((action) => !recentSet.has(action.id));
    entries = [...recentActions, ...others].slice(0, 40);
    if (recentActions.length) {
      recentStart = 0;
      recentEnd = recentActions.length - 1;
    }
  } else {
    entries = actions
      .map((action) => ({
        action,
        score: Math.max(
          fuzzyScore(trimmed, action.label),
          fuzzyScore(trimmed, action.hint ?? ""),
          fuzzyScore(trimmed, action.group ?? ""),
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 40)
      .map((entry) => entry.action);
  }
  if (entries.length === 0) {
    list.innerHTML = `
      <div class="palette-empty">
        <div class="palette-empty-title">No matches</div>
        <div class="palette-empty-hint">Try a shorter query or a different word. <kbd>Esc</kbd> to close.</div>
      </div>
    `;
    list.dataset.matchCount = "0";
    list.dataset.selectedIndex = "0";
    return;
  }
  const normalizedIndex =
    ((selectedIndex % entries.length) + entries.length) % entries.length;
  const parts = [];
  if (recentStart !== -1) {
    parts.push('<div class="palette-section-head">Recent</div>');
  }
  entries.forEach((action, index) => {
    if (
      recentEnd !== -1 &&
      index === recentEnd + 1 &&
      entries.length > recentEnd + 1
    ) {
      parts.push('<div class="palette-section-head">All commands</div>');
    }
    parts.push(`
      <button
        type="button"
        role="option"
        aria-selected="${index === normalizedIndex ? "true" : "false"}"
        class="palette-item${index === normalizedIndex ? " active" : ""}"
        data-action-id="${action.id}"
      >
        <div class="palette-item-main">
          <span class="palette-item-label">${escapeHtmlPalette(action.label)}</span>
          <span class="palette-item-hint">${escapeHtmlPalette(action.hint ?? "")}</span>
        </div>
        <span class="palette-item-group">${escapeHtmlPalette(action.group ?? "")}</span>
      </button>
    `);
  });
  list.innerHTML = parts.join("");
  list.dataset.matchCount = String(entries.length);
  list.dataset.selectedIndex = String(normalizedIndex);
  const activeItem = list.querySelector(".palette-item.active");
  if (activeItem) {
    activeItem.scrollIntoView({ block: "nearest" });
  }
}

function escapeHtmlPalette(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PALETTE_RECENTS_KEY = "paletteRecentActionIds";
const PALETTE_RECENTS_MAX = 6;

function readPaletteRecents() {
  try {
    const raw = localStorage.getItem(PALETTE_RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value) => typeof value === "string");
  } catch {
    return [];
  }
}

function recordPaletteRecent(actionId) {
  if (!actionId) return;
  try {
    const recents = readPaletteRecents().filter((id) => id !== actionId);
    recents.unshift(actionId);
    localStorage.setItem(
      PALETTE_RECENTS_KEY,
      JSON.stringify(recents.slice(0, PALETTE_RECENTS_MAX)),
    );
  } catch {
    // non-fatal — MRU is a nice-to-have
  }
}

function openCommandPalette() {
  const actions = buildPaletteActions();
  const root = $("#modal-root");
  if (!root) return;
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal palette-modal" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          id="palette-input"
          type="text"
          class="palette-input"
          placeholder="Type a command or action…"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
        />
        <div id="palette-list" class="palette-list" role="listbox" aria-label="Matching commands"></div>
        <div class="palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  `;
  const backdrop = root.querySelector(".modal-backdrop");
  const mount = root.querySelector(".palette-modal");
  const input = root.querySelector("#palette-input");
  const list = root.querySelector("#palette-list");
  const previousFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  let query = "";
  let selectedIndex = 0;

  const close = () => {
    root.innerHTML = "";
    if (previousFocus && typeof previousFocus.focus === "function") {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {}
    }
  };

  const runAction = (id) => {
    const action = actions.find((entry) => entry.id === id);
    if (!action) return;
    recordPaletteRecent(id);
    close();
    try {
      action.run();
    } catch (error) {
      renderers.appendSystem(
        `command failed: ${error.message ?? error}`,
        "error",
      );
    }
  };

  const execSelected = () => {
    const selected = list.querySelector(".palette-item.active");
    if (!selected) return;
    runAction(selected.dataset.actionId);
  };

  const updateAriaActiveDescendant = () => {
    const active = list.querySelector(".palette-item.active");
    if (active) {
      if (!active.id) active.id = `palette-item-${active.dataset.actionId}`;
      input.setAttribute("aria-activedescendant", active.id);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const rerender = () => {
    renderPaletteList(mount, actions, query, selectedIndex, readPaletteRecents());
    updateAriaActiveDescendant();
  };

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });

  input.addEventListener("input", () => {
    query = input.value;
    selectedIndex = 0;
    rerender();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      execSelected();
      return;
    }
    const matchCount = Number(list.dataset.matchCount ?? 0);
    if (matchCount === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = (selectedIndex + 1) % matchCount;
      rerender();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex = (selectedIndex - 1 + matchCount) % matchCount;
      rerender();
    } else if (event.key === "Home") {
      event.preventDefault();
      selectedIndex = 0;
      rerender();
    } else if (event.key === "End") {
      event.preventDefault();
      selectedIndex = matchCount - 1;
      rerender();
    }
  });

  list.addEventListener("click", (event) => {
    const target = event.target.closest(".palette-item");
    if (!target) return;
    runAction(target.dataset.actionId);
  });

  rerender();
  setTimeout(() => input.focus(), 10);
}

async function createProject() {
  const name = prompt("Project name:");
  if (!name) return;
  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? `project create failed (${response.status})`);
    }
    await refreshProjects();
    renderers.appendSystem(`Created project ${data.project?.name ?? name}.`);
  } catch (error) {
    renderers.appendSystem(`project create failed: ${error.message}`, "error");
  }
}

async function activateProject(project) {
  if (!project?.slug) return;
  const previousSlug = state.whoami?.activeProjectSlug ?? null;
  const previousName = state.whoami?.activeProjectName ?? null;
  if (state.whoami) {
    state.whoami.activeProjectSlug = project.system ? null : project.slug;
    state.whoami.activeProjectName =
      project.name ?? (project.system ? "Scratch workspace" : project.slug);
  }
  state.projects = state.projects.map((entry) => ({
    ...entry,
    active: entry.slug === project.slug,
  }));
  renderers.renderProjects();
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(project.slug)}/activate`,
      {
        method: "POST",
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? `project activate failed (${response.status})`);
    }
    await refreshWhoAmI();
    await refreshProjects();
    newThread();
    renderers.appendSystem(
      `Workspace switched to ${data.project?.name ?? project.name ?? project.slug}.`,
    );
  } catch (error) {
    if (state.whoami) {
      state.whoami.activeProjectSlug = previousSlug;
      state.whoami.activeProjectName = previousName;
    }
    state.projects = state.projects.map((entry) => ({
      ...entry,
      active: entry.slug === (previousSlug ?? "_scratch"),
    }));
    renderers.renderProjects();
    renderers.appendSystem(`project activate failed: ${error.message}`, "error");
  }
}

async function deleteProject(project) {
  const label = project?.name ?? project?.slug ?? "project";
  if (!project?.slug) return;
  if (!confirm(`Delete project "${label}"?`)) return;
  try {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(project.slug)}`,
      {
        method: "DELETE",
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? `project delete failed (${response.status})`);
    }
    await refreshWhoAmI();
    await refreshProjects();
    renderers.appendSystem(`Deleted project ${label}.`);
  } catch (error) {
    renderers.appendSystem(`project delete failed: ${error.message}`, "error");
  }
}

async function handleProjectAction(action, project) {
  switch (action) {
    case "activate":
      await activateProject(project);
      return;
    case "delete":
      await deleteProject(project);
      return;
    default:
      return;
  }
}

async function onInput(event) {
  const input = event.target;
  const position = input.selectionStart;
  const textBeforeCursor = input.value.slice(0, position);
  const slashMatch = /(^|\n)(\/[A-Za-z\-]*)$/.exec(textBeforeCursor);
  if (slashMatch) {
    const query = slashMatch[2];
    const items = state.slashCommands.filter(
      (command) => command.name.startsWith(query) && !command.cliOnly,
    );
    showAutocomplete({
      kind: "slash",
      items,
      anchorStart: position - query.length,
    });
    return;
  }
  const mentionMatch = /(^|\s)@([A-Za-z0-9_\-./]*)$/.exec(textBeforeCursor);
  if (mentionMatch) {
    const query = mentionMatch[2];
    const anchorStart = position - query.length - 1;
    // Show a placeholder row immediately so the user knows the trigger is
    // registered — otherwise an empty workdir silently eats the `@` keystroke.
    showAutocomplete({
      kind: "file",
      items: [{ name: "Searching files…", desc: "", disabled: true }],
      anchorStart,
    });
    try {
      const response = await fetch("/api/file-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await response.json();
      const results = data.results ?? [];
      const items = results.length
        ? results.map((path) => ({ name: `@${path}`, desc: "file" }))
        : [
            {
              name: query ? `No files match "${query}"` : "No files in workspace",
              desc: "",
              disabled: true,
            },
          ];
      showAutocomplete({ kind: "file", items, anchorStart });
    } catch (error) {
      console.warn("file-search failed", error);
      showAutocomplete({
        kind: "file",
        items: [
          { name: "File search unavailable", desc: "", disabled: true },
        ],
        anchorStart,
      });
    }
    return;
  }
  hideAutocomplete();
}

function showAutocomplete({ kind, items, anchorStart }) {
  const autocomplete = $("#autocomplete");
  if (items.length === 0) {
    hideAutocomplete();
    return;
  }
  const firstSelectable = items.findIndex((item) => !item.disabled);
  const initialSelected = firstSelectable >= 0 ? firstSelectable : 0;
  setAutocompleteState({ kind, items, selected: initialSelected, anchorStart });
  const itemsHtml = items
    .map((item, index) => {
      const classes = ["ac-item"];
      if (index === initialSelected && !item.disabled) classes.push("selected");
      if (item.disabled) classes.push("disabled");
      return `<div class="${classes.join(" ")}" data-idx="${index}">${escapeHtml(item.name)}<span class="ac-desc">${escapeHtml(item.desc ?? "")}</span></div>`;
    })
    .join("");
  const footerHtml =
    '<div class="ac-footer">' +
    '<span><kbd>\u2191</kbd><kbd>\u2193</kbd> nav</span>' +
    '<span><kbd>\u21b5</kbd> select</span>' +
    '<span><kbd>esc</kbd> cancel</span>' +
    "</div>";
  autocomplete.innerHTML = itemsHtml + footerHtml;
  autocomplete.hidden = false;
  autocomplete.querySelectorAll(".ac-item").forEach((node) => {
    node.addEventListener("click", () => {
      const current = getAutocompleteState();
      const idx = Number(node.dataset.idx);
      if (current.items[idx]?.disabled) return;
      setAutocompleteState({ ...current, selected: idx });
      acceptAutocomplete();
    });
  });
}

function hideAutocomplete() {
  const autocomplete = $("#autocomplete");
  autocomplete.hidden = true;
  autocomplete.innerHTML = "";
  setAutocompleteState({ kind: null, items: [], selected: 0, anchorStart: 0 });
}

function acceptAutocomplete() {
  const autocompleteState = getAutocompleteState();
  const item = autocompleteState.items[autocompleteState.selected];
  if (!item || item.disabled) return;
  const input = $("#input");
  const before = input.value.slice(0, autocompleteState.anchorStart);
  const after = input.value.slice(input.selectionStart);
  input.value = `${before}${item.name} ${after}`;
  const newPosition = `${before}${item.name} `.length;
  input.setSelectionRange(newPosition, newPosition);
  hideAutocomplete();
  input.focus();
}

function moveSelection(delta) {
  const nodes = $$("#autocomplete .ac-item");
  if (!nodes.length) return;
  const autocompleteState = getAutocompleteState();
  const modelItems = autocompleteState.items;
  // Skip disabled entries when navigating; if all are disabled, bail.
  const hasSelectable = modelItems.some((item) => !item.disabled);
  if (!hasSelectable) return;
  let selected = autocompleteState.selected;
  for (let step = 0; step < modelItems.length; step += 1) {
    selected = (selected + delta + modelItems.length) % modelItems.length;
    if (!modelItems[selected]?.disabled) break;
  }
  setAutocompleteState({ ...autocompleteState, selected });
  nodes.forEach((node, index) => {
    node.classList.toggle("selected", index === selected);
  });
}

function onKeyDown(event) {
  const autocomplete = $("#autocomplete");
  if (!autocomplete.hidden) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const autocompleteState = getAutocompleteState();
      const selected = autocompleteState.items[autocompleteState.selected];
      const inputValue = $("#input").value.trim();
      if (autocompleteState.kind === "slash" && selected?.name === inputValue) {
        hideAutocomplete();
        $("#composer").requestSubmit();
      } else {
        acceptAutocomplete();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      hideAutocomplete();
    }
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#composer").requestSubmit();
  } else if (event.key === "Escape" && state.inFlight) {
    event.preventDefault();
    void interruptTurn();
  }
}

function onSubmit(event) {
  event.preventDefault();
  const input = $("#input");
  const text = input.value.trim();
  if (!text && state.pendingUploads.length === 0) return;
  if (text.startsWith("/")) {
    handleSlash(text);
    input.value = "";
    autoGrowReset(input);
    return;
  }
  void startTurn(text);
  input.value = "";
  autoGrowReset(input);
}

function selectedModelId() {
  if (state.settings.model) return state.settings.model;
  const pick = state.models.find((model) => model.isDefault) ?? state.models[0];
  return modelSlug(pick) || "gpt-5";
}

function buildCollaborationMode() {
  return {
    mode: state.composerFlags.planMode ? "plan" : "default",
    settings: {
      model: selectedModelId(),
      reasoning_effort: state.settings.modelReasoningEffort || null,
      developer_instructions: null,
    },
  };
}

async function startTurn(text, options = {}) {
  setInFlight(true);
  const uploadsSnapshot = options.uploads ?? [...state.pendingUploads];
  lastSubmittedTurn = { text, uploads: uploadsSnapshot };
  try {
    let threadId = state.activeThreadId;
    if (!threadId) {
      const response = await rpc.rpcCall("thread/start", {
        cwd: state.whoami?.workdir,
        model: state.settings.model || null,
        sandbox: state.settings.sandboxMode,
        approvalPolicy: state.settings.approvalPolicy,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      });
      threadId = response?.thread?.id ?? null;
      if (threadId) state.activeThreadId = threadId;
    }
    const input = [];
    if (text) input.push({ type: "text", text, text_elements: [] });
    input.push(
      ...uploadsSnapshot.map((upload) => ({
        type: "localImage",
        path: upload.path,
      })),
    );
    await rpc.rpcCall("turn/start", {
      threadId,
      input,
      collaborationMode: buildCollaborationMode(),
    });
    if (!options.isRetry) {
      state.pendingUploads = [];
      uploads.renderPendingUploads();
    }
  } catch (error) {
    setInFlight(false);
    if (isAuthErrorMessage(error.message)) {
      renderers.showAuthRequiredCard(error.message);
      return;
    }
    renderers.appendSystem(`✗ ${error.message}`, "error", {
      action: canRetryLastTurn()
        ? { label: "Retry", onClick: retryLastTurn }
        : null,
    });
  }
}

function canRetryLastTurn() {
  if (!lastSubmittedTurn) return false;
  if (state.inFlight) return false;
  return Boolean(
    lastSubmittedTurn.text || (lastSubmittedTurn.uploads ?? []).length,
  );
}

function retryLastTurn() {
  if (!canRetryLastTurn()) return;
  const { text, uploads } = lastSubmittedTurn;
  void startTurn(text, { uploads, isRetry: true });
}

async function interruptTurn() {
  if (!state.activeThreadId || !state.activeTurnId) return;
  try {
    await rpc.rpcCall("turn/interrupt", {
      threadId: state.activeThreadId,
      turnId: state.activeTurnId,
    });
  } catch {}
}

function showCliOnlyBanner(feature) {
  renderers.appendSystem(
    `${feature} is not available in the web build. Use the CLI for that workflow.`,
    "error",
  );
}

function onAccountClick() {
  if (state.whoami?.hasApiKey || state.whoami?.hasOauth) {
    void doLogout();
  } else {
    modals.openLogin();
  }
}

async function doLogout() {
  if (state.initialized) {
    await rpc.rpcCall("account/logout", {}).catch(() => {});
  }
  await fetch("/api/logout", { method: "POST" });
  renderers.clearAuthRequiredCard();
  await refreshWhoAmI();
  await refreshModels().catch(() => {});
  updateStatusBar();
  showToast("Signed out.", "info");
}

bootstrap();
