import { $, load, save, state } from "./state.js";
import { escapeHtml, renderMarkdownish } from "./utils.js";
import {
  getSubagentParentThreadId,
  getThreadSpawnMeta,
  subagentThreadLabel,
} from "./subagent-meta.js";

const subagentUi = load("subagentUi", {
  visible: true,
  selectedThreadId: "",
});

function persistUi() {
  save("subagentUi", subagentUi);
}

function extractUserText(item) {
  return (item?.content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function summarizeToolItem(item) {
  switch (item?.type) {
    case "commandExecution":
      return item.command ? `Command: ${item.command}` : "Ran a shell command";
    case "fileChange":
      return item.files?.length
        ? `Edited ${item.files.length} file${item.files.length === 1 ? "" : "s"}`
        : "Applied file changes";
    case "plan":
      return item.text ? `Plan: ${item.text}` : "Updated a plan";
    case "mcpToolCall":
      return item.tool ? `MCP: ${item.tool}` : "Ran an MCP tool";
    case "dynamicToolCall":
      return item.tool ? `Tool: ${item.tool}` : "Ran a dynamic tool";
    case "collabAgentToolCall":
      return item.tool ? `Delegation: ${item.tool}` : "Delegated work";
    default:
      return "";
  }
}

function renderTurnSummary(turn) {
  const items = turn?.items ?? [];
  const userMessages = items
    .filter((item) => item.type === "userMessage")
    .map(extractUserText)
    .filter(Boolean);
  const assistantMessages = items
    .filter((item) => item.type === "agentMessage")
    .map((item) => item.text ?? "")
    .filter(Boolean);
  const toolMessages = items.map(summarizeToolItem).filter(Boolean);
  return `
    <article class="subagent-turn">
      <div class="subagent-turn-head">
        <span>Turn</span>
        <span>${escapeHtml(turn?.status ?? "active")}</span>
      </div>
      ${
        userMessages.length
          ? userMessages
              .map(
                (text) =>
                  `<div class="subagent-entry user">${renderMarkdownish(text)}</div>`,
              )
              .join("")
          : ""
      }
      ${
        assistantMessages.length
          ? assistantMessages
              .map(
                (text) =>
                  `<div class="subagent-entry assistant">${renderMarkdownish(text)}</div>`,
              )
              .join("")
          : '<div class="subagent-entry pending">Waiting for the agent to reply…</div>'
      }
      ${
        toolMessages.length
          ? `<div class="subagent-entry tool">${toolMessages
              .map((text) => escapeHtml(text))
              .join("<br />")}</div>`
          : ""
      }
    </article>
  `;
}

export function createSubagentPane({ rpcCall, openThread, appendSystem }) {
  const detailCache = new Map();
  let lastParentThreadId = "";
  let lastTasks = [];

  function host() {
    return $("#subagent-pane");
  }

  function toggleButton() {
    return $("#subagent-toggle-btn");
  }

  function currentAgentStates() {
    const map = new Map();
    for (const itemId of state.itemOrder) {
      const item = state.itemsById.get(itemId)?.item;
      if (item?.type !== "collabAgentToolCall") continue;
      for (const [threadId, status] of Object.entries(
        item.agentsStates ?? {},
      )) {
        map.set(threadId, String(status ?? ""));
      }
    }
    return map;
  }

  function tasksForActiveThread() {
    const parentThreadId = state.activeThreadId;
    if (!parentThreadId) return [];
    const agentStates = currentAgentStates();
    const tasks = state.threads
      .filter((thread) => getSubagentParentThreadId(thread) === parentThreadId)
      .map((thread) => ({
        ...thread,
        taskState: agentStates.get(thread.id) || thread.status || "idle",
      }))
      .sort((left, right) => {
        const leftRunning = /progress|running|queued|waiting/i.test(
          left.taskState,
        );
        const rightRunning = /progress|running|queued|waiting/i.test(
          right.taskState,
        );
        if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
        return (right.lastActive ?? 0) - (left.lastActive ?? 0);
      });
    if (tasks.length) {
      lastParentThreadId = parentThreadId;
      lastTasks = tasks;
      return tasks;
    }
    if (parentThreadId === lastParentThreadId && lastTasks.length) {
      return lastTasks;
    }
    return [];
  }

  async function ensureDetail(threadId) {
    const cached = detailCache.get(threadId);
    if (cached?.turns?.length) return cached;
    const thread = state.threads.find((entry) => entry.id === threadId) ?? null;
    if (thread?.turns?.length) {
      detailCache.set(threadId, thread);
      return thread;
    }
    if (
      !state.initialized ||
      !state.ws ||
      state.ws.readyState !== WebSocket.OPEN
    ) {
      return thread;
    }
    try {
      const response = await rpcCall("thread/read", {
        threadId,
        includeTurns: true,
      });
      if (response?.thread) {
        detailCache.set(threadId, response.thread);
        render();
        return response.thread;
      }
    } catch (error) {
      appendSystem(`sub-agent snapshot failed: ${error.message}`, "error");
    }
    return thread;
  }

  function render() {
    const pane = host();
    const button = toggleButton();
    if (!pane || !button) return;
    const tasks = tasksForActiveThread();
    const runningCount = tasks.filter((task) =>
      /progress|running|queued|waiting/i.test(task.taskState),
    ).length;
    button.hidden = tasks.length === 0;
    button.textContent = runningCount ? `Tasks · ${runningCount}` : "Tasks";
    button.setAttribute("aria-pressed", subagentUi.visible ? "true" : "false");
    if (!tasks.length) {
      pane.hidden = true;
      pane.innerHTML = "";
      return;
    }
    if (
      !subagentUi.selectedThreadId ||
      !tasks.some((task) => task.id === subagentUi.selectedThreadId)
    ) {
      subagentUi.selectedThreadId = tasks[0].id;
      persistUi();
    }
    const selectedThread =
      tasks.find((task) => task.id === subagentUi.selectedThreadId) ?? tasks[0];
    const detail = detailCache.get(selectedThread.id) ?? selectedThread;
    const meta = getThreadSpawnMeta(selectedThread);
    pane.hidden = !subagentUi.visible;
    pane.innerHTML = `
      <div class="subagent-pane-head">
        <div>
          <div class="workspace-section-title">Running tasks</div>
          <div class="subagent-pane-meta">
            ${runningCount ? `${runningCount} active` : `${tasks.length} linked`} sub-agent task${tasks.length === 1 ? "" : "s"}
          </div>
        </div>
        <div class="workspace-actions">
          <button id="subagent-open-thread" type="button" class="ghost">Open thread</button>
          <button id="subagent-hide" type="button" class="ghost">Hide</button>
        </div>
      </div>
      <div class="subagent-task-strip">
        ${tasks
          .map(
            (task) => `
              <button
                type="button"
                class="subagent-task-chip${task.id === selectedThread.id ? " active" : ""}"
                data-subagent-thread="${escapeHtml(task.id)}"
              >
                <span class="subagent-task-label">${escapeHtml(subagentThreadLabel(task))}</span>
                <span class="subagent-task-status">${escapeHtml(task.taskState || "idle")}</span>
              </button>
            `,
          )
          .join("")}
      </div>
      <div class="subagent-detail">
        <div class="subagent-detail-head">
          <div>
            <strong>${escapeHtml(subagentThreadLabel(selectedThread))}</strong>
            <div class="subagent-detail-meta">
              ${escapeHtml(meta?.agent_role ?? selectedThread.agentRole ?? "sub-agent")}
              <span>·</span>
              <span>${escapeHtml(selectedThread.id)}</span>
            </div>
          </div>
          <div class="subagent-detail-state">${escapeHtml(selectedThread.taskState || "idle")}</div>
        </div>
        <div class="subagent-stream">
          ${
            detail?.turns?.length
              ? detail.turns.slice(-6).map(renderTurnSummary).join("")
              : `
                <div class="subagent-entry pending">
                  ${escapeHtml(selectedThread.preview || "This sub-agent has started, but its event stream has not been loaded yet.")}
                </div>
              `
          }
        </div>
      </div>
    `;
    pane.querySelectorAll("[data-subagent-thread]").forEach((node) => {
      node.addEventListener("click", () => {
        subagentUi.selectedThreadId = node.dataset.subagentThread ?? "";
        persistUi();
        render();
        void ensureDetail(subagentUi.selectedThreadId);
      });
    });
    $("#subagent-open-thread")?.addEventListener("click", () => {
      void openThread(selectedThread.id);
    });
    $("#subagent-hide")?.addEventListener("click", () => {
      subagentUi.visible = false;
      persistUi();
      render();
    });
  }

  async function refresh() {
    const tasks = tasksForActiveThread();
    if (
      tasks.length &&
      subagentUi.visible === false &&
      !toggleButton()?.matches(":focus")
    ) {
      // Respect explicit hides until the selection disappears.
      if (!tasks.some((task) => task.id === subagentUi.selectedThreadId)) {
        subagentUi.visible = true;
        persistUi();
      }
    }
    render();
    if (tasks.length) {
      await ensureDetail(subagentUi.selectedThreadId || tasks[0].id);
    }
  }

  function init() {
    toggleButton()?.addEventListener("click", () => {
      subagentUi.visible = !subagentUi.visible;
      persistUi();
      render();
      if (subagentUi.visible) {
        void refresh();
      }
    });
    // Retry ensureDetail whenever the RPC socket becomes ready again — otherwise
    // the first load leaves the detail pane stuck on "event stream not loaded".
    window.addEventListener("codex:ready", () => {
      const selected = subagentUi.selectedThreadId;
      if (selected && subagentUi.visible) {
        void ensureDetail(selected);
      }
    });
    render();
  }

  return {
    init,
    refresh,
  };
}
