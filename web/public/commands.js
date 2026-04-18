import { state, save } from "./state.js";

function parseReviewTarget(arg) {
  if (!arg) return { type: "uncommittedChanges" };
  if (arg.startsWith("commit:")) {
    const sha = arg.slice("commit:".length).trim();
    return { type: "commit", sha, title: null };
  }
  if (arg.startsWith("branch:")) {
    return {
      type: "baseBranch",
      branch: arg.slice("branch:".length).trim() || "main",
    };
  }
  return { type: "custom", instructions: arg };
}

export function createCommandHandler({
  newThread,
  clearTranscript,
  openSettings,
  openLogin,
  doLogout,
  openMcpModal,
  openJsonModal,
  openListModal,
  appendSystem,
  updateStatusBar,
  refreshConfigState,
  rpcCall,
  showCliOnlyBanner,
  interruptTurn,
  handleThreadAction,
  rollbackTurns,
}) {
  return function handleSlash(text) {
    const [command, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (command) {
      case "/new":
        newThread();
        return;
      case "/clear":
        clearTranscript();
        return;
      case "/help":
        openJsonModal("Slash commands", state.slashCommands);
        return;
      case "/settings":
        openSettings();
        return;
      case "/theme":
        openSettings("appearance");
        return;
      case "/status": {
        const whoami = state.whoami ?? {};
        appendSystem(
          `backend=${whoami.backend ?? "?"} · model=${state.settings.model || "auto"} · ` +
            `approvals=${state.settings.approvalPolicy} · sandbox=${state.settings.sandboxMode} · ` +
            `network=${state.settings.networkAccessEnabled} · workdir=${whoami.workdir ?? "?"}`,
        );
        return;
      }
      case "/login":
        openLogin();
        return;
      case "/logout":
        void doLogout();
        return;
      case "/mcp":
        void openMcpModal();
        return;
      case "/fork":
        if (!state.activeThreadId) {
          appendSystem("No active thread to fork.", "error");
          return;
        }
        void handleThreadAction("fork", { id: state.activeThreadId });
        return;
      case "/rename":
        if (!state.activeThreadId) {
          appendSystem("No active thread to rename.", "error");
          return;
        }
        void handleThreadAction("rename", {
          id: state.activeThreadId,
          name: null,
          promptDefault: arg || null,
        });
        return;
      case "/archive":
        if (!state.activeThreadId) {
          appendSystem("No active thread to archive.", "error");
          return;
        }
        void handleThreadAction("archive", { id: state.activeThreadId });
        return;
      case "/unarchive":
        if (!state.activeThreadId) {
          appendSystem("No active thread to unarchive.", "error");
          return;
        }
        void handleThreadAction("unarchive", { id: state.activeThreadId });
        return;
      case "/rollback": {
        if (!state.activeThreadId) {
          appendSystem("No active thread to roll back.", "error");
          return;
        }
        const numTurns = Number.parseInt(arg || "1", 10);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          appendSystem("Usage: /rollback <positive-number-of-turns>", "error");
          return;
        }
        void rollbackTurns(numTurns);
        return;
      }
      case "/review":
        if (!state.activeThreadId) {
          appendSystem("No active thread to review.", "error");
          return;
        }
        void rpcCall("review/start", {
          threadId: state.activeThreadId,
          delivery: "inline",
          target: parseReviewTarget(arg),
        })
          .then(() => appendSystem("Review started."))
          .catch((error) =>
            appendSystem(`review failed: ${error.message}`, "error"),
          );
        return;
      case "/model":
        if (arg) {
          state.settings.model = arg;
          save("settings", state.settings);
          updateStatusBar();
          appendSystem(`model → ${arg}`);
        } else {
          openSettings("model");
        }
        return;
      case "/approvals":
        if (["never", "on-request", "on-failure", "untrusted"].includes(arg)) {
          state.settings.approvalPolicy = arg;
          save("settings", state.settings);
          updateStatusBar();
          appendSystem(`approvals → ${arg}`);
        } else {
          openSettings("approvalPolicy");
        }
        return;
      case "/sandbox":
        if (
          ["read-only", "workspace-write", "danger-full-access"].includes(arg)
        ) {
          state.settings.sandboxMode = arg;
          save("settings", state.settings);
          updateStatusBar();
          appendSystem(`sandbox → ${arg}`);
        } else {
          openSettings("sandboxMode");
        }
        return;
      case "/reasoning":
        if (["minimal", "low", "medium", "high", "xhigh"].includes(arg)) {
          state.settings.modelReasoningEffort = arg;
          save("settings", state.settings);
          appendSystem(`reasoning → ${arg}`);
        } else {
          openSettings("modelReasoningEffort");
        }
        return;
      case "/web-search":
        if (["disabled", "cached", "live"].includes(arg)) {
          state.settings.webSearchMode = arg;
          save("settings", state.settings);
          appendSystem(`web search → ${arg}`);
        } else {
          openSettings("webSearchMode");
        }
        return;
      case "/network":
        state.settings.networkAccessEnabled =
          !state.settings.networkAccessEnabled;
        save("settings", state.settings);
        appendSystem(
          `network access → ${state.settings.networkAccessEnabled ? "on" : "off"}`,
        );
        return;
      case "/resume":
        appendSystem("Pick a thread from the sidebar to resume.");
        return;
      case "/skills":
        void openListModal("Skills", "skills/list", {
          cwds: state.whoami?.workdir ? [state.whoami.workdir] : null,
          forceReload: true,
        });
        return;
      case "/apps":
        void openListModal("Apps", "app/list", {
          limit: 100,
          forceRefetch: true,
        });
        return;
      case "/plugins":
        void openListModal("Plugins", "plugin/list", { limit: 100 });
        return;
      case "/experimental":
        void openListModal(
          "Experimental Features",
          "experimentalFeature/list",
          { limit: 100 },
        );
        return;
      case "/debug-config":
        void refreshConfigState().then(() =>
          openJsonModal("Config Snapshot", {
            config: state.configSnapshot?.config ?? {},
            layers: state.configSnapshot?.layers ?? [],
            requirements: state.configRequirements?.requirements ?? null,
          }),
        );
        return;
      case "/permissions":
        openSettings("approvals");
        return;
      case "/feedback":
        void rpcCall("feedback/upload", {
          classification: "other",
          reason: arg || "Feedback from codex-web",
          threadId: state.activeThreadId ?? null,
          includeLogs: false,
          extraLogFiles: [],
          tags: { surface: "web" },
        })
          .then(() => appendSystem("Feedback uploaded."))
          .catch((error) =>
            appendSystem(`feedback failed: ${error.message}`, "error"),
          );
        return;
      case "/ps":
        openJsonModal("Tracked sessions", {
          activeThreadId: state.activeThreadId,
          sessions: [...state.commandSessions.values()],
        });
        return;
      case "/stop": {
        const targets = arg ? [arg] : [...state.commandSessions.keys()];
        const requests = targets.map((processId) =>
          rpcCall("command/exec/terminate", { processId })
            .then(() => {
              state.commandSessions.delete(processId);
            })
            .catch(() => {}),
        );
        if (state.activeThreadId) {
          requests.push(
            rpcCall("thread/backgroundTerminals/clean", {
              threadId: state.activeThreadId,
            }).catch(() => {}),
          );
        }
        void Promise.all(requests).then(() => appendSystem("Stop requested."));
        return;
      }
      case "/realtime":
      case "/fast":
      case "/title":
      case "/statusline":
      case "/setup-default-sandbox":
      case "/sandbox-add-read-dir":
        showCliOnlyBanner(command);
        return;
      case "/reset":
        void interruptTurn();
        newThread();
        appendSystem("Conversation reset.");
        return;
      case "/compact":
        if (!state.activeThreadId) {
          appendSystem("No active thread to compact.", "error");
          return;
        }
        void rpcCall("thread/compact/start", { threadId: state.activeThreadId })
          .then(() => appendSystem("Compact requested."))
          .catch((error) =>
            appendSystem(`compact failed: ${error.message}`, "error"),
          );
        return;
      default:
        appendSystem(`unknown command: ${command}`, "error");
    }
  };
}
