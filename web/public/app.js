import {
  $,
  $$,
  state,
  save,
  getAutocompleteState,
  setAutocompleteState,
} from "./state.js";
import { escapeHtml } from "./utils.js";
import { createUploads, hydrateWorkdirMedia } from "./uploads.js";
import { createRenderers } from "./renderers.js";
import { createModals } from "./modals.js";
import { createNotificationHandlers, isAuthErrorMessage } from "./notifications.js";
import { createRpc } from "./rpc.js";
import { createCommandHandler } from "./commands.js";

function scrollToBottom() {
  const transcript = $("#transcript");
  transcript.scrollTop = transcript.scrollHeight;
}

function setInFlight(value) {
  state.inFlight = value;
  $("#cancel-btn").hidden = !value;
  $("#send-btn").disabled = value;
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
  $("#approval-pill").textContent = `approvals: ${state.settings.approvalPolicy}`;
  $("#sandbox-pill").textContent = `sandbox: ${state.settings.sandboxMode}`;
}

const renderers = createRenderers({
  openThread: (threadId) => void openThread(threadId),
  onThreadAction: (action, thread) => handleThreadAction(action, thread),
  onRollbackToItem: (itemId) => rollbackToItem(itemId),
  openLogin: () => modals.openLogin(),
  scrollToBottom,
  hydrateWorkdirMedia,
  afterUpsertItem: (item, isStart, isComplete) => trackAfterUpsertItem(item, isStart, isComplete),
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
  refreshWhoAmI,
  refreshAccount,
  refreshConfigState,
  refreshExperimentalFeatures,
  pushSettingsToBackend,
  updateStatusBar,
  appendSystem: renderers.appendSystem,
  clearAuthRequiredCard: renderers.clearAuthRequiredCard,
});

notificationHandlers = createNotificationHandlers({
  rpcReply: rpc.rpcReply,
  rpcRaw: rpc.rpcRaw,
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
  onStandaloneCommandDelta,
});

const handleSlash = createCommandHandler({
  newThread,
  clearTranscript: renderers.clearTranscript,
  openSettings: modals.openSettings,
  openLogin: modals.openLogin,
  doLogout,
  openMcpModal: modals.openMcpModal,
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
  await refreshWhoAmI();
  await refreshThreads();
  rpc.connectWs();
  bindUi();
  updateStatusBar();
  uploads.renderPendingUploads();
}

async function refreshWhoAmI() {
  const response = await fetch("/api/whoami");
  state.whoami = await response.json();
  renderers.renderAccount();
  renderers.renderAccountPill();
  updateStatusBar();
}

async function refreshThreads() {
  try {
    if (state.initialized) {
      const response = await rpc.rpcCall("thread/list", { limit: 100 });
      state.threads = (response?.data ?? []).map((thread) => ({
        id: thread.id,
        name: thread.name ?? thread.preview ?? thread.id,
        preview: thread.preview ?? "",
        lastActive: (thread.updatedAt ?? thread.createdAt ?? Math.floor(Date.now() / 1000)) * 1000,
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
}

async function refreshModels() {
  if (!state.initialized) return;
  try {
    const response = await rpc.rpcCall("model/list", { limit: 100, includeHidden: false });
    const models = Array.isArray(response?.data)
      ? response.data
      : (Array.isArray(response?.models) ? response.models : []);
    state.models = models;
    if (!state.settings.model && models.length) {
      const pick = models.find((model) => model.isDefault) ?? models[0];
      const slug = pick?.id ?? pick?.model ?? pick?.slug ?? "";
      if (slug) {
        state.settings.model = slug;
        save("settings", state.settings);
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
    state.configRequirements = await rpc.rpcCall("configRequirements/read", {})
      .catch(() => ({ requirements: null }));
  } catch (error) {
    console.warn("config/read failed", error.message);
  }
}

async function refreshExperimentalFeatures() {
  if (!state.initialized) return;
  try {
    const response = await rpc.rpcCall("experimentalFeature/list", { limit: 100 });
    state.experimentalFeatures = response?.data ?? [];
  } catch (error) {
    console.warn("experimentalFeature/list failed", error.message);
  }
}

async function pushSettingsToBackend() {
  if (!state.initialized) return;
  const settings = state.settings;
  const edits = [
    ...(settings.model ? [{ keyPath: "model", value: settings.model, mergeStrategy: "replace" }] : []),
    { keyPath: "model_reasoning_effort", value: settings.modelReasoningEffort, mergeStrategy: "replace" },
    { keyPath: "approval_policy", value: settings.approvalPolicy, mergeStrategy: "replace" },
    { keyPath: "sandbox_mode", value: settings.sandboxMode, mergeStrategy: "replace" },
    { keyPath: "tools.web_search", value: settings.webSearchMode !== "disabled", mergeStrategy: "replace" },
  ];
  await rpc.rpcCall("config/batchWrite", {
    edits,
    expectedVersion: state.configSnapshot?.layers?.[0]?.version ?? null,
    reloadUserConfig: true,
  }).catch(() => {});
}

function clearConversationState() {
  state.activeTurnId = null;
  state.currentTurnRecordId = null;
  renderers.clearTranscript();
}

function hydrateThread(thread) {
  clearConversationState();
  if (!thread) return;
  $("#thread-title").textContent = thread.name ?? thread.preview ?? thread.id;
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
  $("#thread-title").textContent = threadId;
  clearConversationState();
  renderers.renderThreads();
  try {
    try {
      const response = await rpc.rpcCall("thread/read", { threadId, includeTurns: true });
      if (response?.thread) hydrateThread(response.thread);
    } catch (error) {
      console.warn("thread/read failed, resuming without hydration", error.message);
    }
    await rpc.rpcCall("thread/resume", { threadId, persistExtendedHistory: true });
    renderers.appendSystem(`Resumed thread ${threadId}.`);
  } catch (error) {
    renderers.appendSystem(`Could not resume ${threadId}: ${error.message}`, "error");
  }
}

function newThread() {
  if (state.activeThreadId && state.activeTurnId) {
    void rpc.rpcCall("turn/interrupt", {
      threadId: state.activeThreadId,
      turnId: state.activeTurnId,
    }).catch(() => {});
  }
  state.activeThreadId = null;
  state.activeTurnId = null;
  $("#thread-title").textContent = "New conversation";
  clearConversationState();
  renderers.renderThreads();
}

function onThreadStarted(thread) {
  if (!thread?.id) return;
  state.activeThreadId = thread.id;
  $("#thread-title").textContent = thread.name ?? thread.preview ?? thread.id ?? "thread";
  const existing = state.threads.find((entry) => entry.id === thread.id);
  const snapshot = {
    id: thread.id,
    name: thread.name ?? thread.preview ?? thread.id,
    preview: thread.preview ?? "",
    lastActive: (thread.updatedAt ?? thread.createdAt ?? Math.floor(Date.now() / 1000)) * 1000,
    status: thread.status ?? "active",
    archived: thread.status === "archived",
  };
  if (existing) Object.assign(existing, snapshot);
  else state.threads.unshift(snapshot);
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
}

function onTurnFinished(turn) {
  const turnId = turn?.id ?? state.currentTurnRecordId;
  if (!turnId) return;
  const record = state.turns.find((entry) => entry.id === turnId);
  if (record) record.status = turn?.status ?? record.status;
  state.currentTurnRecordId = null;
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
    let turnIndex = state.turns.findIndex((record) => record.id === state.activeTurnId);
    if (turnIndex === -1) {
      state.turns.push({ id: state.activeTurnId, status: "inProgress", items: [] });
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
}

async function rollbackTurns(numTurns) {
  if (!state.activeThreadId) return;
  try {
    const result = await rpc.rpcCall("thread/rollback", { threadId: state.activeThreadId, numTurns });
    if (result?.thread) {
      hydrateThread(result.thread);
      renderers.appendSystem(`Rolled back ${numTurns} turn${numTurns === 1 ? "" : "s"}.`);
    }
  } catch (error) {
    renderers.appendSystem(`rollback failed: ${error.message}`, "error");
  }
}

async function rollbackToItem(itemId) {
  const turnIndex = state.itemTurnIndex.get(itemId);
  if (turnIndex == null) {
    renderers.appendSystem("Could not determine the turn for that rollback point.", "error");
    return;
  }
  const numTurns = state.turns.length - turnIndex;
  if (numTurns < 1) {
    renderers.appendSystem("There are no later turns to roll back.", "error");
    return;
  }
  await rollbackTurns(numTurns);
}

async function handleThreadAction(action, thread) {
  const threadId = thread?.id ?? state.activeThreadId;
  if (!threadId) return;
  switch (action) {
    case "fork": {
      const result = await rpc.rpcCall("thread/fork", {
        threadId,
        persistExtendedHistory: true,
      }).catch((error) => {
        renderers.appendSystem(`fork failed: ${error.message}`, "error");
        return null;
      });
      const nextThread = result?.thread ?? result;
      if (nextThread?.id) await openThread(nextThread.id);
      return;
    }
    case "rename": {
      const proposed = thread?.promptDefault ?? thread?.name ?? "";
      const name = prompt("New thread name:", proposed);
      if (!name) return;
      await rpc.rpcCall("thread/name/set", { threadId, name })
        .then(async () => {
          const active = state.threads.find((entry) => entry.id === threadId);
          if (active) active.name = name;
          if (state.activeThreadId === threadId) $("#thread-title").textContent = name;
          await refreshThreads();
        })
        .catch((error) => renderers.appendSystem(`rename failed: ${error.message}`, "error"));
      return;
    }
    case "archive":
      await rpc.rpcCall("thread/archive", { threadId })
        .then(refreshThreads)
        .catch((error) => renderers.appendSystem(`archive failed: ${error.message}`, "error"));
      return;
    case "unarchive":
      await rpc.rpcCall("thread/unarchive", { threadId })
        .then(refreshThreads)
        .catch((error) => renderers.appendSystem(`unarchive failed: ${error.message}`, "error"));
      return;
    case "copyId":
      try {
        await navigator.clipboard.writeText(threadId);
        renderers.appendSystem(`Copied thread id ${threadId}.`);
      } catch {
        renderers.appendSystem(`Thread id: ${threadId}`);
      }
      return;
    default:
      return;
  }
}

function bindUi() {
  $("#composer").addEventListener("submit", onSubmit);
  $("#cancel-btn").addEventListener("click", () => void interruptTurn());
  $("#new-thread").addEventListener("click", newThread);
  $("#account-btn").addEventListener("click", onAccountClick);
  $("#settings-btn").addEventListener("click", () => modals.openSettings());
  $("#attach-btn")?.addEventListener("click", () => $("#attach-input")?.click());
  $("#attach-input")?.addEventListener("change", uploads.onAttachChange);
  $("#thread-filter-active")?.addEventListener("click", () => {
    state.filterArchived = false;
    renderers.renderThreads();
  });
  $("#thread-filter-archived")?.addEventListener("click", () => {
    state.filterArchived = true;
    renderers.renderThreads();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".thread-actions") && state.threadMenuOpenId) {
      state.threadMenuOpenId = null;
      renderers.renderThreads();
    }
  });

  const input = $("#input");
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("paste", uploads.onComposerPaste);
  autoGrow(input);
}

async function onInput(event) {
  const input = event.target;
  const position = input.selectionStart;
  const textBeforeCursor = input.value.slice(0, position);
  const slashMatch = /(^|\n)(\/[A-Za-z\-]*)$/.exec(textBeforeCursor);
  if (slashMatch) {
    const query = slashMatch[2];
    const items = state.slashCommands.filter((command) => command.name.startsWith(query));
    showAutocomplete({ kind: "slash", items, anchorStart: position - query.length });
    return;
  }
  const mentionMatch = /(^|\s)@([A-Za-z0-9_\-./]*)$/.exec(textBeforeCursor);
  if (mentionMatch) {
    const query = mentionMatch[2];
    try {
      const response = await fetch("/api/file-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await response.json();
      const items = (data.results ?? []).map((path) => ({ name: `@${path}`, desc: "file" }));
      showAutocomplete({ kind: "file", items, anchorStart: position - query.length - 1 });
    } catch {
      hideAutocomplete();
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
  setAutocompleteState({ kind, items, selected: 0, anchorStart });
  autocomplete.innerHTML = items.map((item, index) =>
    `<div class="ac-item ${index === 0 ? "selected" : ""}" data-idx="${index}">${escapeHtml(item.name)}<span class="ac-desc">${escapeHtml(item.desc ?? "")}</span></div>`,
  ).join("");
  autocomplete.hidden = false;
  autocomplete.querySelectorAll(".ac-item").forEach((node) => {
    node.addEventListener("click", () => {
      const current = getAutocompleteState();
      setAutocompleteState({ ...current, selected: Number(node.dataset.idx) });
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
  if (!item) return;
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
  const items = $$("#autocomplete .ac-item");
  if (!items.length) return;
  const autocompleteState = getAutocompleteState();
  const selected = (autocompleteState.selected + delta + items.length) % items.length;
  setAutocompleteState({ ...autocompleteState, selected });
  items.forEach((node, index) => {
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

async function startTurn(text) {
  setInFlight(true);
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
    input.push(...state.pendingUploads.map((upload) => ({ type: "localImage", path: upload.path })));
    await rpc.rpcCall("turn/start", {
      threadId,
      input,
    });
    state.pendingUploads = [];
    uploads.renderPendingUploads();
  } catch (error) {
    setInFlight(false);
    if (isAuthErrorMessage(error.message)) {
      renderers.showAuthRequiredCard(error.message);
      return;
    }
    renderers.appendSystem(`✗ ${error.message}`, "error");
  }
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
  renderers.appendSystem(`${feature} is not available in the web build. Use the CLI for that workflow.`, "error");
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
  updateStatusBar();
  renderers.appendSystem("Signed out.");
}

bootstrap();
