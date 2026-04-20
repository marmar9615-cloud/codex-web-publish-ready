import { $, state } from "./state.js";
import { el, escapeHtml, renderMarkdownish } from "./utils.js";

export function patchKind(kind) {
  if (!kind) return "update";
  if (typeof kind === "string") return kind;
  return kind.type ?? "update";
}

export function createRenderers({
  openThread,
  onThreadAction,
  onProjectAction,
  onRollbackToItem,
  onEditItem,
  onForkFromItem,
  openLogin,
  scrollToBottom,
  hydrateWorkdirMedia,
  afterUpsertItem,
}) {
  function renderAccount() {
    const whoami = state.whoami;
    const status = $("#account-status");
    const button = $("#account-btn");
    if (!status || !button) return;
    if (!whoami) {
      status.textContent = "—";
      return;
    }
    if (whoami.hasOauth) {
      status.textContent = `ChatGPT: ${whoami.account?.email ?? whoami.account?.chatgptAccountId ?? "signed in"}`;
      status.classList.remove("muted");
      button.textContent = "Sign out";
    } else if (whoami.oauthPending) {
      status.textContent = "ChatGPT sign-in pending";
      status.classList.remove("muted");
      button.textContent = "Sign in";
    } else if (whoami.hasApiKey) {
      status.textContent = "API key set";
      status.classList.remove("muted");
      button.textContent = "Sign out";
    } else {
      status.textContent = whoami.realBinaryConfigured
        ? "not signed in"
        : "backend unavailable";
      status.classList.add("muted");
      button.textContent = "Sign in";
    }
    if (whoami.oauthError)
      status.textContent = `Sign-in failed: ${whoami.oauthError}`;
  }

  function renderProjects() {
    const host = $("#projects");
    if (!host) return;
    host.innerHTML = "";
    if (!state.projects.length) {
      host.innerHTML =
        '<div class="muted thread-empty">Create a named project to keep a persistent workspace handy.</div>';
      return;
    }
    for (const project of state.projects) {
      const row = el("div", {
        class: `project-item${project.active ? " active" : ""}`,
      });
      const main = el("button", { class: "project-main", type: "button" });
      main.innerHTML = `
        <div class="project-name">${escapeHtml(project.name ?? project.slug ?? "Project")}</div>
        <div class="project-meta">${escapeHtml(project.system ? "session workspace" : (project.slug ?? ""))}</div>
      `;
      main.addEventListener("click", () => {
        if (!onProjectAction) return;
        void onProjectAction("activate", project);
      });
      row.appendChild(main);
      if (!project.system) {
        const actions = el("div", { class: "project-actions" });
        const deleteButton = el("button", {
          class: "project-delete ghost",
          type: "button",
          title: `Delete ${project.name ?? project.slug ?? "project"}`,
          "aria-label": `Delete ${project.name ?? project.slug ?? "project"}`,
        });
        deleteButton.textContent = "×";
        deleteButton.addEventListener("click", (event) => {
          event.stopPropagation();
          if (!onProjectAction) return;
          void onProjectAction("delete", project);
        });
        actions.appendChild(deleteButton);
        row.appendChild(actions);
      }
      host.appendChild(row);
    }
  }

  function renderThreads() {
    const nav = $("#threads");
    if (!nav) return;
    nav.innerHTML = "";
    $("#thread-filter-active")?.classList.toggle(
      "active",
      !state.filterArchived,
    );
    $("#thread-filter-archived")?.classList.toggle(
      "active",
      state.filterArchived,
    );
    const threads = state.threads.filter(
      (thread) => Boolean(thread.archived) === state.filterArchived,
    );
    if (threads.length === 0) {
      nav.innerHTML = `<div class="muted thread-empty">No ${state.filterArchived ? "archived" : "saved"} threads yet.</div>`;
      return;
    }
    for (const thread of threads) {
      const row = el("div", {
        class: `thread-item${thread.id === state.activeThreadId ? " active" : ""}`,
      });
      const main = el("button", { class: "thread-main", type: "button" });
      main.innerHTML = `
        <div class="thread-name">${escapeHtml(thread.name ?? thread.id)}</div>
        <div class="thread-time">${escapeHtml(new Date(thread.lastActive).toLocaleString())}</div>
      `;
      main.addEventListener("click", () => {
        state.threadMenuOpenId = null;
        openThread(thread.id);
      });
      const actions = el("div", { class: "thread-actions" });
      const menuButton = el("button", {
        "class": "thread-menu-toggle ghost",
        "type": "button",
        "aria-label": "Thread actions",
        "title": "Thread actions",
      });
      menuButton.textContent = "⋯";
      menuButton.addEventListener("click", (event) => {
        event.stopPropagation();
        state.threadMenuOpenId =
          state.threadMenuOpenId === thread.id ? null : thread.id;
        renderThreads();
      });
      actions.appendChild(menuButton);
      if (state.threadMenuOpenId === thread.id) {
        const menu = el("div", { class: "thread-menu" });
        const options = [
          { action: "fork", label: "Fork" },
          { action: "rename", label: "Rename" },
          {
            action: thread.archived ? "unarchive" : "archive",
            label: thread.archived ? "Unarchive" : "Archive",
          },
          { action: "copyId", label: "Copy id" },
        ];
        for (const option of options) {
          const button = el("button", {
            class: "thread-menu-item ghost",
            type: "button",
          });
          button.textContent = option.label;
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            state.threadMenuOpenId = null;
            renderThreads();
            void onThreadAction(option.action, thread);
          });
          menu.appendChild(button);
        }
        actions.appendChild(menu);
      }
      row.appendChild(main);
      row.appendChild(actions);
      nav.appendChild(row);
    }
  }

  function clearTranscript() {
    $("#transcript").innerHTML = "";
    state.itemsById.clear();
    state.itemOrder = [];
    state.itemTurnIndex.clear();
    state.turns = [];
    state.currentTurnRecordId = null;
    clearAuthRequiredCard();
  }

  function appendSystem(text, kind = "info") {
    const cell = el("div", { class: "cell system" });
    const bubble = el("div", { class: "bubble" });
    bubble.textContent = text;
    if (kind === "error") bubble.style.color = "var(--danger)";
    cell.appendChild(bubble);
    $("#transcript").appendChild(cell);
    scrollToBottom();
  }

  function upsertItem(item, isStart, isComplete = false) {
    const transcript = $("#transcript");
    let entry = state.itemsById.get(item.id);
    if (!entry) {
      entry = { item, el: renderItem(item, isComplete) };
      state.itemsById.set(item.id, entry);
      state.itemOrder.push(item.id);
      transcript.appendChild(entry.el);
    } else {
      entry.item = item;
      const replacement = renderItem(item, isComplete);
      entry.el.replaceWith(replacement);
      entry.el = replacement;
    }
    afterUpsertItem?.(item, isStart, isComplete);
    scrollToBottom();
  }

  function renderItem(item, isComplete) {
    switch (item.type) {
      case "userMessage":
        return renderUserMessage(item);
      case "hookPrompt":
        return renderHookPrompt(item);
      case "agentMessage":
        return renderAgentMessage(item);
      case "reasoning":
        return renderReasoning(item);
      case "commandExecution":
        return renderCommandExec(item);
      case "fileChange":
        return renderFileChange(item);
      case "mcpToolCall":
        return renderMcp(item);
      case "dynamicToolCall":
        return renderDynamicTool(item);
      case "collabAgentToolCall":
        return renderCollabAgentTool(item);
      case "webSearch":
        return renderWebSearch(item);
      case "imageView":
        return renderImageView(item);
      case "imageGeneration":
        return renderImageGeneration(item);
      case "enteredReviewMode":
        return renderReviewMode(item, true);
      case "exitedReviewMode":
        return renderReviewMode(item, false);
      case "contextCompaction":
        return renderContextCompaction(item);
      case "plan":
        return renderPlan(item);
      default:
        return renderUnknown(item, isComplete);
    }
  }

  function renderUserMessage(item) {
    const cell = el("div", { class: "cell user" });
    const bubble = el("div", { class: "bubble user-bubble" });
    const parts = (item.content ?? []).map((part) => {
      if (part.type === "text")
        return `<div>${renderMarkdownish(part.text ?? "")}</div>`;
      if (part.type === "localImage") {
        return `<figure class="image-item"><img data-workdir-path="${escapeHtml(part.path ?? "")}" alt="uploaded image" /></figure>`;
      }
      return `<div class="upload-chip">${escapeHtml(part.type ?? "attachment")}</div>`;
    });
    bubble.innerHTML = parts.join("");
    const turnIndex = state.itemTurnIndex.get(item.id);
    if (turnIndex != null && turnIndex >= 0) {
      const tools = el("div", { class: "msg-tools" });
      const makeBtn = (label, title, handler) => {
        const btn = el("button", {
          class: "msg-tool ghost",
          type: "button",
          title,
        });
        btn.textContent = label;
        btn.addEventListener("click", (event) => {
          event.stopPropagation();
          handler();
        });
        return btn;
      };
      if (onEditItem) {
        tools.appendChild(
          makeBtn("Edit", "Edit this message and resend", () =>
            onEditItem(item.id),
          ),
        );
      }
      if (onForkFromItem) {
        tools.appendChild(
          makeBtn(
            "Fork",
            "Fork the thread at this point into a new conversation",
            () => onForkFromItem(item.id),
          ),
        );
      }
      tools.appendChild(
        makeBtn("Rollback", "Drop later turns and keep this one", () =>
          onRollbackToItem(item.id),
        ),
      );
      bubble.appendChild(tools);
    }
    cell.appendChild(bubble);
    hydrateWorkdirMedia(cell);
    return cell;
  }

  function renderHookPrompt(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card" });
    card.innerHTML = `
      <div class="tc-head"><span class="badge">hook</span><span>Prompt</span></div>
      <pre>${escapeHtml((item.fragments ?? []).map((fragment) => fragment.text ?? JSON.stringify(fragment)).join("\n"))}</pre>
    `;
    cell.appendChild(card);
    return cell;
  }

  function renderAgentMessage(item) {
    const cell = el("div", { class: "cell assistant" });
    const bubble = el("div", { class: "bubble" });
    bubble.innerHTML = renderMarkdownish(item.text ?? "");
    cell.appendChild(bubble);
    return cell;
  }

  function renderReasoning(item) {
    const cell = el("div", { class: "cell assistant" });
    const parts = [
      ...(item.summary ?? []),
      ...(item.content ?? []),
      ...(item.text ? [item.text] : []),
    ].filter(Boolean);
    const body = parts.join("\n\n");
    const effort = item.reasoningEffort || state.settings?.modelReasoningEffort || "";
    const details = el("details", { class: "reasoning", open: "" });
    const summary = el("summary", { class: "reasoning-summary" });
    const label = el("span", { class: "reasoning-label" });
    label.textContent = "Thinking";
    summary.appendChild(label);
    if (effort) {
      const badge = el("span", { class: `reasoning-effort effort-${effort}` });
      badge.textContent = effort;
      summary.appendChild(badge);
    }
    const preview = el("span", { class: "reasoning-preview" });
    preview.textContent = firstLine(body, 80);
    summary.appendChild(preview);
    details.appendChild(summary);
    const bodyEl = el("div", { class: "reasoning-body" });
    bodyEl.textContent = body;
    details.appendChild(bodyEl);
    cell.appendChild(details);
    return cell;
  }

  function firstLine(text, limit) {
    if (!text) return "";
    const line = text.split("\n").find((entry) => entry.trim().length > 0) ?? "";
    const clean = line.trim().replace(/\s+/g, " ");
    return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
  }

  function renderCommandExec(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card" });
    card.innerHTML = `
      <div class="tc-head">
        <span class="status-dot ${escapeHtml(item.status)}"></span>
        <span class="badge">shell</span>
        <span>${escapeHtml(item.status)}${item.exitCode != null ? ` · exit ${item.exitCode}` : ""}</span>
      </div>
      <div class="tc-cmd">$ ${escapeHtml(item.command ?? "")}</div>
      ${item.cwd ? `<div class="tc-meta">cwd: ${escapeHtml(item.cwd)}</div>` : ""}
      ${item.processId ? `<div class="tc-meta">process: ${escapeHtml(item.processId)}</div>` : ""}
    `;
    if (item.aggregatedOutput) {
      const pre = el("pre", { "data-stream": "command" });
      pre.textContent = item.aggregatedOutput;
      card.appendChild(pre);
    }
    cell.appendChild(card);
    return cell;
  }

  function renderFileChange(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card" });
    const counts =
      item.changes?.reduce((acc, change) => {
        const kind = patchKind(change.kind);
        acc[kind] = (acc[kind] ?? 0) + 1;
        return acc;
      }, {}) ?? {};
    const fileCount = item.changes?.length ?? 0;
    const summary = Object.entries(counts)
      .map(([kind, count]) => `${count} ${kind}`)
      .join(", ");
    // Total +/- across all files, for the card header.
    const totals = (item.changes ?? []).reduce(
      (acc, change) => {
        if (!change.diff) return acc;
        const lc = countDiffLines(change.diff);
        acc.add += lc.add;
        acc.del += lc.del;
        return acc;
      },
      { add: 0, del: 0 },
    );
    const totalBadge =
      totals.add > 0 || totals.del > 0
        ? ` · <span class="diff-add-count">+${totals.add}</span> <span class="diff-del-count">\u2212${totals.del}</span>`
        : "";
    card.innerHTML = `
      <div class="tc-head">
        <span class="status-dot ${escapeHtml(item.status)}"></span>
        <span class="badge">apply_patch</span>
        <span>${escapeHtml(item.status)}${summary ? ` \u00b7 ${summary}` : ""}${totalBadge}</span>
        ${fileCount > 1 ? `<button type="button" class="diff-expand-all" data-expand="1">Expand all</button>` : ""}
      </div>
    `;
    const expandAllBtn = card.querySelector(".diff-expand-all");
    for (const change of item.changes ?? []) {
      const kind = patchKind(change.kind);
      const lineCounts = change.diff
        ? countDiffLines(change.diff)
        : { add: 0, del: 0 };
      const shouldCollapse = lineCounts.add + lineCounts.del > 50;
      const file = el("details", {
        class: "diff-file",
        ...(shouldCollapse ? {} : { open: "" }),
      });
      file.innerHTML = `
        <summary>
          <span class="kind ${escapeHtml(kind)}">${escapeHtml(kind)}</span>
          <span class="diff-path">${escapeHtml(change.path)}</span>
          <span class="diff-counts">
            <span class="diff-add-count">+${lineCounts.add}</span>
            <span class="diff-del-count">\u2212${lineCounts.del}</span>
          </span>
        </summary>
        ${change.diff ? `<div class="diff-body">${renderDiff(change.diff)}</div>` : ""}
      `;
      card.appendChild(file);
    }
    if (expandAllBtn) {
      expandAllBtn.addEventListener("click", () => {
        const files = card.querySelectorAll(".diff-file");
        const shouldOpen = expandAllBtn.dataset.expand === "1";
        files.forEach((f) => {
          if (shouldOpen) f.setAttribute("open", "");
          else f.removeAttribute("open");
        });
        expandAllBtn.textContent = shouldOpen ? "Collapse all" : "Expand all";
        expandAllBtn.dataset.expand = shouldOpen ? "0" : "1";
      });
    }
    cell.appendChild(card);
    return cell;
  }

  function countDiffLines(diff) {
    let add = 0;
    let del = 0;
    const lines = diff.split("\n");
    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) add++;
      else if (line.startsWith("-") && !line.startsWith("---")) del++;
    }
    return { add, del };
  }

  function renderDiff(diff) {
    return diff
      .split("\n")
      .map((line) => {
        const safe = escapeHtml(line);
        if (line.startsWith("+") && !line.startsWith("+++"))
          return `<div class="add">${safe}</div>`;
        if (line.startsWith("-") && !line.startsWith("---"))
          return `<div class="del">${safe}</div>`;
        return `<div>${safe}</div>`;
      })
      .join("");
  }

  function renderMcp(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card" });
    card.innerHTML = `
      <div class="tc-head">
        <span class="status-dot ${escapeHtml(item.status)}"></span>
        <span class="badge">mcp</span>
        <span>${escapeHtml(item.server ?? "")} · ${escapeHtml(item.tool ?? "")} · ${escapeHtml(item.status ?? "")}</span>
      </div>
      <details><summary>arguments</summary><pre>${escapeHtml(JSON.stringify(item.arguments, null, 2))}</pre></details>
      ${item.result ? `<details><summary>result</summary><pre>${escapeHtml(JSON.stringify(item.result, null, 2))}</pre></details>` : ""}
      ${item.mcpAppResourceUri ? `<div class="tc-meta">resource: ${escapeHtml(item.mcpAppResourceUri)}</div>` : ""}
      ${item.error ? `<div class="tc-meta" style="color:var(--danger)">${escapeHtml(item.error.message ?? JSON.stringify(item.error))}</div>` : ""}
    `;
    cell.appendChild(card);
    return cell;
  }

  function renderDynamicTool(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card" });
    card.innerHTML = `
      <div class="tc-head">
        <span class="status-dot ${escapeHtml(item.status ?? "completed")}"></span>
        <span class="badge">tool</span>
        <span>${escapeHtml(item.tool ?? "")}</span>
      </div>
      <details><summary>arguments</summary><pre>${escapeHtml(JSON.stringify(item.arguments, null, 2))}</pre></details>
      ${item.contentItems ? `<details open><summary>result</summary><pre>${escapeHtml(JSON.stringify(item.contentItems, null, 2))}</pre></details>` : ""}
      <div class="tc-meta">${item.success === false ? "rejected" : "completed"}</div>
    `;
    cell.appendChild(card);
    return cell;
  }

  function renderCollabAgentTool(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card" });
    const agentStates = Object.entries(item.agentsStates ?? {})
      .map(([threadId, value]) => `${threadId}: ${value}`)
      .join("\n");
    card.innerHTML = `
      <div class="tc-head">
        <span class="status-dot ${escapeHtml(item.status ?? "inProgress")}"></span>
        <span class="badge">agent</span>
        <span>${escapeHtml(item.tool ?? "")}</span>
      </div>
      ${item.prompt ? `<pre>${escapeHtml(item.prompt)}</pre>` : ""}
      <div class="tc-meta">receivers: ${escapeHtml((item.receiverThreadIds ?? []).join(", ") || "—")}</div>
      ${item.model ? `<div class="tc-meta">model: ${escapeHtml(item.model)}</div>` : ""}
      ${item.reasoningEffort ? `<div class="tc-meta">reasoning: ${escapeHtml(item.reasoningEffort)}</div>` : ""}
      ${agentStates ? `<details><summary>agent states</summary><pre>${escapeHtml(agentStates)}</pre></details>` : ""}
    `;
    cell.appendChild(card);
    return cell;
  }

  function renderWebSearch(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card" });
    card.innerHTML = `
      <div class="tc-head">
        <span class="badge">web</span>
        <span>Search</span>
      </div>
      <div class="tc-meta">${escapeHtml(item.query ?? "")}</div>
      ${item.action ? `<pre>${escapeHtml(JSON.stringify(item.action, null, 2))}</pre>` : ""}
    `;
    cell.appendChild(card);
    return cell;
  }

  function renderImageView(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card image-card" });
    card.innerHTML = `
      <div class="tc-head"><span class="badge">image</span><span>View</span></div>
      <img class="inline-image" data-workdir-path="${escapeHtml(item.path ?? "")}" alt="image output" />
      <div class="tc-meta">${escapeHtml(item.path ?? "")}</div>
    `;
    cell.appendChild(card);
    hydrateWorkdirMedia(cell);
    return cell;
  }

  function renderImageGeneration(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card image-card" });
    card.innerHTML = `
      <div class="tc-head">
        <span class="status-dot ${escapeHtml(item.status ?? "completed")}"></span>
        <span class="badge">image</span>
        <span>Generation</span>
      </div>
      ${item.revisedPrompt ? `<pre>${escapeHtml(item.revisedPrompt)}</pre>` : ""}
      ${item.savedPath ? `<img class="inline-image" data-workdir-path="${escapeHtml(item.savedPath)}" alt="generated image" />` : ""}
      ${item.result ? `<div class="tc-meta">${escapeHtml(item.result)}</div>` : ""}
    `;
    cell.appendChild(card);
    hydrateWorkdirMedia(cell);
    return cell;
  }

  function renderReviewMode(item, entering) {
    const cell = el("div", { class: "cell system" });
    const bubble = el("div", { class: "bubble" });
    bubble.textContent = `${entering ? "Entered" : "Exited"} review mode: ${item.review ?? "review"}`;
    cell.appendChild(bubble);
    return cell;
  }

  function renderContextCompaction() {
    const cell = el("div", { class: "cell system" });
    const bubble = el("div", { class: "bubble" });
    bubble.textContent = "Context compacted.";
    cell.appendChild(bubble);
    return cell;
  }

  function renderPlan(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card" });
    card.innerHTML = `
      <div class="tc-head">
        <span class="status-dot completed"></span>
        <span class="badge">plan</span>
      </div>
      <pre>${escapeHtml(item.text ?? "")}</pre>
    `;
    cell.appendChild(card);
    return cell;
  }

  function renderUnknown(item) {
    const cell = el("div", { class: "cell assistant" });
    const card = el("div", { class: "tool-card" });
    card.innerHTML = `
      <div class="tc-head"><span class="badge">${escapeHtml(item.type)}</span></div>
      <pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>
    `;
    cell.appendChild(card);
    return cell;
  }

  function renderApproval({ request, onDecision }) {
    const transcript = $("#transcript");
    const card = el("div", { class: "approval-card" });
    const head =
      request.kind === "apply_patch"
        ? "Apply patch?"
        : request.kind === "exec"
          ? "Run command?"
          : "Approval requested";
    let body;
    if (request.kind === "exec") {
      body = `
        <div class="tc-cmd">$ ${escapeHtml(request.command ?? "")}</div>
        ${request.cwd ? `<div class="tc-meta">cwd: ${escapeHtml(request.cwd)}</div>` : ""}
        ${request.reason ? `<div class="tc-meta">${escapeHtml(request.reason)}</div>` : ""}
      `;
    } else if (request.kind === "apply_patch") {
      body = `
        <div class="tc-meta">${escapeHtml(request.summary ?? "")}</div>
        <ul class="todo-list">${(request.files ?? []).map((file) => `<li class="done">${escapeHtml(file.kind)} ${escapeHtml(file.path)}</li>`).join("")}</ul>
      `;
    } else {
      body = `<pre>${escapeHtml(JSON.stringify(request, null, 2))}</pre>`;
    }
    card.innerHTML = `
      <div class="ap-head">⚠ ${head}</div>
      <div class="ap-body">${body}</div>
      <div class="ap-actions">
        <button class="primary" data-decision="approve">Approve once</button>
        <button data-decision="approve-session">Approve for session</button>
        <button class="danger" data-decision="deny">Deny</button>
      </div>
    `;
    card.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-decision]");
      if (!button) return;
      onDecision(button.dataset.decision);
      card.querySelectorAll("button").forEach((node) => {
        node.disabled = true;
      });
      card.querySelector(".ap-head").textContent =
        `→ ${button.dataset.decision}`;
    });
    transcript.appendChild(card);
    scrollToBottom();
  }

  function appendStreamDelta(itemId, delta, kind) {
    const entry = state.itemsById.get(itemId);
    if (!entry || !delta) return;
    const card = entry.el.querySelector(".tool-card") ?? entry.el;
    let pre = card.querySelector(`pre[data-stream="${kind}"]`);
    if (!pre) {
      pre = document.createElement("pre");
      pre.dataset.stream = kind;
      card.appendChild(pre);
    }
    pre.appendChild(document.createTextNode(delta));
    if (kind === "command") {
      entry.item.aggregatedOutput = (entry.item.aggregatedOutput ?? "") + delta;
    }
    scrollToBottom();
  }

  function appendMcpProgress(itemId, message) {
    const entry = state.itemsById.get(itemId);
    if (!entry) return;
    const card = entry.el.querySelector(".tool-card") ?? entry.el;
    let meta = card.querySelector(".mcp-progress");
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "tc-meta mcp-progress";
      card.appendChild(meta);
    }
    meta.textContent = message;
    scrollToBottom();
  }

  function renderTokenPill(usage) {
    const pill = $("#token-pill");
    if (!pill) return;
    if (!usage) {
      pill.hidden = true;
      return;
    }
    const total = usage.total?.totalTokens ?? 0;
    const contextWindow = usage.modelContextWindow;
    pill.hidden = false;
    pill.textContent = contextWindow
      ? `tokens: ${total.toLocaleString()} / ${contextWindow.toLocaleString()}`
      : `tokens: ${total.toLocaleString()}`;
    pill.className =
      contextWindow && total / contextWindow > 0.75 ? "pill warn" : "pill";
  }

  function renderRatePill(rateLimits) {
    const pill = $("#rate-pill");
    if (!pill) return;
    if (!rateLimits) {
      pill.hidden = true;
      return;
    }
    const primary = rateLimits.primary?.usedPercent;
    if (primary == null && !rateLimits.credits) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    const used = primary != null ? `${Math.round(primary)}%` : "—";
    const credits = rateLimits.credits?.unlimited
      ? " · unlimited"
      : rateLimits.credits?.balance
        ? ` · ${rateLimits.credits.balance}`
        : "";
    pill.textContent = `rate: ${used}${credits}`;
    pill.className = `pill${primary != null && primary >= 80 ? " warn" : ""}`;
  }

  function renderAccountPill() {
    const pill = $("#account-pill");
    if (!pill) return;
    const whoami = state.whoami ?? {};
    if (whoami.hasOauth) {
      pill.hidden = false;
      pill.textContent = `account: ChatGPT${whoami.account?.planType ? ` · ${whoami.account.planType}` : ""}`;
      pill.className = "pill ok";
    } else if (whoami.hasApiKey) {
      pill.hidden = false;
      pill.textContent = "account: API key";
      pill.className = "pill";
    } else {
      pill.hidden = true;
    }
  }

  function clearAuthRequiredCard() {
    if (state.authCard?.isConnected) state.authCard.remove();
    state.authCard = null;
  }

  function showAuthRequiredCard(message) {
    if (state.authCard?.isConnected) {
      const detail = state.authCard.querySelector(".ap-body .tc-meta");
      if (detail) detail.textContent = message;
      return;
    }
    const transcript = $("#transcript");
    const card = el("div", { class: "approval-card auth-required-card" });
    card.innerHTML = `
      <div class="ap-head">OpenAI authentication required</div>
      <div class="ap-body">
        <div>Sign in with ChatGPT in this browser or use an API key before sending another turn.</div>
        <div class="tc-meta">${escapeHtml(message ?? "The backend rejected the request as unauthenticated.")}</div>
      </div>
      <div class="ap-actions">
        <button class="primary" data-action="login">Sign in</button>
        <button data-action="dismiss">Dismiss</button>
      </div>
    `;
    card.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      if (button.dataset.action === "login") openLogin();
      if (button.dataset.action === "dismiss") clearAuthRequiredCard();
    });
    transcript.appendChild(card);
    state.authCard = card;
    scrollToBottom();
  }

  return {
    appendMcpProgress,
    appendStreamDelta,
    appendSystem,
    clearAuthRequiredCard,
    clearTranscript,
    renderAccount,
    renderAccountPill,
    renderApproval,
    renderProjects,
    renderRatePill,
    renderThreads,
    renderTokenPill,
    showAuthRequiredCard,
    upsertItem,
  };
}
