import { $, load, save, state } from "./state.js";
import { escapeHtml } from "./utils.js";

const todoUi = load("todoUi", {
  visible: true,
});

function statusLabel(status) {
  switch (status) {
    case "completed":
      return "done";
    case "inProgress":
      return "in progress";
    default:
      return "pending";
  }
}

export function createTodoPane() {
  function persistUi() {
    save("todoUi", todoUi);
  }

  function applyVisibility() {
    const pane = $("#todo-pane");
    if (!pane) return;
    const hasPlan = Boolean(state.plan?.plan?.length);
    pane.hidden = !todoUi.visible || !hasPlan;
    const toggle = $("#todo-toggle-btn");
    if (toggle) {
      toggle.textContent = pane.hidden ? "Todos" : "Hide todos";
    }
  }

  function render() {
    const pane = $("#todo-pane");
    if (!pane) return;
    const plan = state.plan;
    if (!plan?.plan?.length) {
      pane.innerHTML = "";
      applyVisibility();
      return;
    }
    pane.innerHTML = `
      <div class="todo-pane-head">
        <div>
          <div class="workspace-eyebrow">Latest plan</div>
          <div class="todo-pane-meta">${escapeHtml(plan.explanation ?? "Tracked from update_plan")}</div>
        </div>
        <button id="todo-pane-close" type="button" class="ghost">Hide</button>
      </div>
      <ul class="todo-pane-list">
        ${plan.plan
          .map(
            (item) => `
          <li class="todo-pane-item status-${escapeHtml(item.status ?? "pending")}">
            <span class="todo-pane-step">${escapeHtml(item.step ?? "")}</span>
            <span class="todo-pane-status">${escapeHtml(statusLabel(item.status))}</span>
          </li>
        `,
          )
          .join("")}
      </ul>
    `;
    pane.querySelector("#todo-pane-close")?.addEventListener("click", () => {
      todoUi.visible = false;
      persistUi();
      applyVisibility();
    });
    applyVisibility();
  }

  function update(plan) {
    state.plan = {
      threadId: plan?.threadId ?? null,
      turnId: plan?.turnId ?? null,
      explanation: plan?.explanation ?? "",
      plan: Array.isArray(plan?.plan) ? plan.plan : [],
    };
    if (state.plan.plan.length) {
      todoUi.visible = true;
      persistUi();
    }
    render();
  }

  function clear() {
    state.plan = null;
    render();
  }

  function init() {
    $("#todo-toggle-btn")?.addEventListener("click", () => {
      todoUi.visible = !todoUi.visible;
      persistUi();
      applyVisibility();
    });
    render();
  }

  return {
    clear,
    init,
    update,
  };
}
