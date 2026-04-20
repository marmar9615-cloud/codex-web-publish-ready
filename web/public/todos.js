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
      toggle.setAttribute("aria-pressed", pane.hidden ? "false" : "true");
      toggle.setAttribute(
        "title",
        hasPlan
          ? pane.hidden
            ? "Show the latest plan"
            : "Hide the plan"
          : "Codex will populate this once it starts a plan",
      );
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
    const completed = plan.plan.filter((item) => item.status === "completed").length;
    const total = plan.plan.length;
    const inProgress = plan.plan.some((item) => item.status === "inProgress");
    const summary = `${completed} of ${total} done${inProgress ? " · one in progress" : ""}`;
    pane.innerHTML = `
      <div class="todo-pane-head">
        <div>
          <div class="workspace-eyebrow">Latest plan</div>
          <div class="todo-pane-meta">${escapeHtml(plan.explanation ?? "Tracked from update_plan")}</div>
          <div class="todo-pane-progress">${escapeHtml(summary)}</div>
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
      const hasPlan = Boolean(state.plan?.plan?.length);
      if (!hasPlan) {
        // Nothing to show yet — give visible feedback rather than silently
        // flipping internal state. The toggle is "armed"; as soon as the
        // next plan update lands it will appear.
        todoUi.visible = true;
        persistUi();
        applyVisibility();
        import("./toast.js")
          .then(({ showToast }) =>
            showToast(
              "No plan yet. Todos will appear here as Codex plans a turn.",
              "info",
            ),
          )
          .catch(() => {});
        return;
      }
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
