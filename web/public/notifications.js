import { $, state } from "./state.js";

export function isAuthErrorMessage(message) {
  return /401|unauthorized|auth/i.test(String(message ?? ""));
}

export function shouldSuppressRetryNoise(message) {
  return /retrying sampling request|stream disconnected|^reconnecting/i.test(
    String(message ?? ""),
  );
}

function mapDecision(uiDecision) {
  if (uiDecision === "approve") return "accept";
  if (uiDecision === "approve-session") return "acceptForSession";
  return "decline";
}

export function createNotificationHandlers({
  rpcReply,
  rpcRaw,
  refreshWhoAmI,
  refreshAccount,
  renderAccount,
  renderAccountPill,
  renderApproval,
  renderRatePill,
  renderThreads,
  renderTokenPill,
  upsertItem,
  appendStreamDelta,
  appendMcpProgress,
  appendSystem,
  clearAuthRequiredCard,
  showAuthRequiredCard,
  setInFlight,
  updateStatusBar,
  openUserInputModal,
  openElicitationModal,
  openPermissionsModal,
  onThreadStarted,
  onTurnStarted,
  onTurnFinished,
  onStandaloneCommandDelta,
}) {
  async function refreshChatgptAuthTokens(message) {
    try {
      const response = await fetch("/api/oauth/chatgpt/refresh", {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error ?? `refresh failed (${response.status})`);
      rpcReply(message.id, data);
    } catch (error) {
      rpcRaw({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32001, message: error.message },
      });
      showAuthRequiredCard(error.message);
      await refreshWhoAmI().catch(() => {});
    }
  }

  function onServerRequest(message) {
    switch (message.method) {
      case "item/commandExecution/requestApproval": {
        const params = message.params ?? {};
        const command =
          typeof params.command === "string"
            ? params.command
            : Array.isArray(params.command)
              ? params.command.join(" ")
              : "";
        renderApproval({
          request: {
            kind: "exec",
            command,
            cwd: params.cwd,
            reason: params.reason,
          },
          onDecision: (decision) =>
            rpcReply(message.id, { decision: mapDecision(decision) }),
        });
        return;
      }
      case "item/fileChange/requestApproval": {
        const params = message.params ?? {};
        const item = state.itemsById.get(params.itemId)?.item;
        const files = (item?.changes ?? []).map((change) => ({
          path: change.path,
          kind:
            typeof change.kind === "string"
              ? change.kind
              : (change.kind?.type ?? "update"),
          diff: change.diff,
        }));
        renderApproval({
          request: {
            kind: "apply_patch",
            summary: files.length
              ? `${files.length} file(s)`
              : (params.reason ?? "patch"),
            files,
          },
          onDecision: (decision) =>
            rpcReply(message.id, { decision: mapDecision(decision) }),
        });
        return;
      }
      case "item/tool/requestUserInput":
        openUserInputModal(message);
        return;
      case "mcpServer/elicitation/request":
        openElicitationModal(message);
        return;
      case "item/permissions/requestApproval":
        openPermissionsModal(message);
        return;
      case "item/tool/call":
        rpcReply(message.id, {
          contentItems: [
            { type: "inputText", text: "No matching local tool in web build" },
          ],
          success: false,
        });
        return;
      case "account/chatgptAuthTokens/refresh":
        void refreshChatgptAuthTokens(message);
        return;
      default:
        rpcRaw({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `unsupported server method: ${message.method}`,
          },
        });
    }
  }

  function onNotification(method, params) {
    switch (method) {
      case "thread/started":
        onThreadStarted(params.thread ?? null);
        renderThreads();
        return;
      case "turn/started":
        state.activeTurnId = params.turn?.id ?? null;
        onTurnStarted(params.turn ?? null);
        return;
      case "turn/completed": {
        state.activeTurnId = null;
        setInFlight(false);
        onTurnFinished(params.turn ?? null);
        const status = params.turn?.status;
        if (status === "interrupted") {
          appendSystem("Turn interrupted.");
          return;
        }
        const durationMs = params.turn?.durationMs;
        appendSystem(
          `Turn complete${durationMs != null ? ` · ${durationMs} ms` : ""}`,
        );
        return;
      }
      case "turn/failed":
        state.activeTurnId = null;
        setInFlight(false);
        onTurnFinished(params.turn ?? null);
        if (isAuthErrorMessage(params.error?.message)) {
          showAuthRequiredCard(params.error?.message);
          return;
        }
        appendSystem(`✗ ${params.error?.message ?? "turn failed"}`, "error");
        return;
      case "item/started":
        upsertItem(params.item, true, false);
        return;
      case "item/agentMessage/delta": {
        clearAuthRequiredCard();
        const existing = state.itemsById.get(params.itemId);
        const text = `${existing?.item?.text ?? ""}${params.delta ?? ""}`;
        upsertItem(
          {
            id: params.itemId,
            type: "agentMessage",
            text,
            phase: null,
            memoryCitation: null,
          },
          !existing,
          false,
        );
        return;
      }
      case "item/completed":
        if (params.item?.type === "agentMessage") clearAuthRequiredCard();
        upsertItem(params.item, false, true);
        return;
      case "item/commandExecution/outputDelta":
        appendStreamDelta(params.itemId, params.delta ?? "", "command");
        return;
      case "item/fileChange/outputDelta":
        appendStreamDelta(params.itemId, params.delta ?? "", "file");
        return;
      case "item/reasoning/textDelta": {
        const existing = state.itemsById.get(params.itemId);
        const base = existing?.item ?? {
          id: params.itemId,
          type: "reasoning",
          summary: [],
          content: [],
        };
        const content = [...(base.content ?? [])];
        const index = params.contentIndex ?? 0;
        content[index] = `${content[index] ?? ""}${params.delta ?? ""}`;
        upsertItem(
          { ...base, id: params.itemId, type: "reasoning", content },
          !existing,
          false,
        );
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        const existing = state.itemsById.get(params.itemId);
        const base = existing?.item ?? {
          id: params.itemId,
          type: "reasoning",
          summary: [],
          content: [],
        };
        const summary = [...(base.summary ?? [])];
        const index = params.summaryIndex ?? 0;
        summary[index] = `${summary[index] ?? ""}${params.delta ?? ""}`;
        upsertItem(
          { ...base, id: params.itemId, type: "reasoning", summary },
          !existing,
          false,
        );
        return;
      }
      case "item/reasoning/summaryPartAdded":
        return;
      case "item/plan/delta": {
        const existing = state.itemsById.get(params.itemId);
        const text = `${existing?.item?.text ?? ""}${params.delta ?? ""}`;
        upsertItem({ id: params.itemId, type: "plan", text }, !existing, false);
        return;
      }
      case "item/mcpToolCall/progress":
        appendMcpProgress(params.itemId, params.message ?? "");
        return;
      case "item/commandExecution/terminalInteraction":
        return;
      case "turn/diff/updated":
      case "turn/plan/updated":
        return;
      case "thread/compacted":
        appendSystem("History compacted.");
        return;
      case "thread/status/changed":
      case "thread/archived":
      case "thread/unarchived":
      case "thread/closed":
        renderThreads();
        return;
      case "thread/name/updated":
      case "thread/nameUpdated":
        if (state.activeThreadId === params.threadId) {
          $("#thread-title").textContent =
            params.threadName ?? params.name ?? state.activeThreadId;
        }
        renderThreads();
        return;
      case "thread/tokenUsage/updated":
      case "thread/tokenUsageUpdated":
        renderTokenPill(params.tokenUsage ?? params);
        return;
      case "model/rerouted":
        appendSystem(
          `Model rerouted ${params.fromModel ?? "?"} → ${params.toModel ?? "?"}${params.reason ? ` (${params.reason})` : ""}`,
        );
        return;
      case "account/updated": {
        const authMode = params.authMode ?? null;
        const planType = params.planType ?? null;
        const hasOauth =
          authMode === "chatgpt" || authMode === "chatgptAuthTokens";
        const hasApiKey = authMode === "apikey";
        state.whoami = {
          ...(state.whoami ?? {}),
          authMethod: authMode,
          account: hasOauth
            ? {
                ...(state.whoami?.account ?? {}),
                planType,
              }
            : null,
          hasOauth,
          hasApiKey,
          oauthPending: false,
          oauthError: null,
        };
        renderAccount();
        renderAccountPill();
        updateStatusBar();
        if (hasOauth) {
          clearAuthRequiredCard();
          appendSystem(
            `Signed in with ChatGPT${planType ? ` (${planType})` : ""}`,
          );
          window.dispatchEvent(new CustomEvent("codex:signedIn"));
        } else if (hasApiKey) {
          clearAuthRequiredCard();
          appendSystem("API key login confirmed by backend.");
        } else if (authMode === null) {
          appendSystem("Signed out by backend.");
        }
        return;
      }
      case "account/login/completed":
        if (params?.success === false) {
          appendSystem(
            `Login failed: ${params.error ?? "unknown error"}`,
            "error",
          );
        }
        return;
      case "account/rateLimits/updated":
        renderRatePill(params.rateLimits ?? params);
        return;
      case "configWarning":
        appendSystem(
          `⚠ config: ${params.summary ?? ""}${params.details ? ` — ${params.details}` : ""}`,
          "error",
        );
        return;
      case "deprecationNotice":
        appendSystem(
          `⚠ deprecated: ${params.summary ?? ""}${params.details ? ` — ${params.details}` : ""}`,
        );
        return;
      case "error":
        if (shouldSuppressRetryNoise(params.error?.message)) {
          if (!state.whoami?.hasOauth && !state.whoami?.hasApiKey) {
            showAuthRequiredCard(
              "OpenAI authentication is required before this turn can complete.",
            );
          }
          return;
        }
        if (isAuthErrorMessage(params.error?.message)) {
          showAuthRequiredCard(params.error?.message);
          return;
        }
        appendSystem(
          `✗ ${params.error?.message ?? "error"}${params.willRetry ? " (retrying)" : ""}`,
          "error",
        );
        return;
      case "hook/started":
      case "hook/completed":
        return;
      case "skills/changed":
        if (typeof window.__skillsRefresh === "function")
          window.__skillsRefresh();
        return;
      case "apps/listUpdated":
      case "app/list/updated":
        if (typeof window.__appsRefresh === "function") window.__appsRefresh();
        return;
      case "mcpServer/startupStatus/updated":
        if (typeof window.__mcpRefresh === "function") window.__mcpRefresh();
        return;
      case "mcpServer/oauthLogin/completed":
        return;
      case "fs/changed":
      case "fuzzyFileSearch/sessionCompleted":
      case "fuzzyFileSearch/sessionUpdated":
      case "serverRequest/resolved":
      case "externalAgentConfig/import/completed":
        return;
      case "item/autoApprovalReview/started":
        appendSystem("Guardian review started.");
        return;
      case "item/autoApprovalReview/completed":
        appendSystem("Guardian review completed.");
        return;
      case "windowsSandbox/setupCompleted":
      case "windows/worldWritableWarning":
        return;
      case "command/exec/outputDelta":
        onStandaloneCommandDelta(params);
        return;
      case "thread/realtime/started":
      case "thread/realtime/closed":
      case "thread/realtime/error":
      case "thread/realtime/itemAdded":
      case "thread/realtime/outputAudio/delta":
      case "thread/realtime/sdp":
      case "thread/realtime/transcript/delta":
      case "thread/realtime/transcript/done":
        return;
      default:
        console.debug("unhandled notification", method, params);
    }
  }

  return {
    onNotification,
    onServerRequest,
  };
}
