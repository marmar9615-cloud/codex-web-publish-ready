import { state } from "./state.js";
import { showToast } from "./toast.js";

// Reconnect backoff parameters. The previous implementation capped at 5 s with
// no jitter, which meant a backend that was slow to answer `initialize` would
// spam the transcript with dozens of identical errors per minute. We cap much
// higher and add jitter so reconnect storms thin out.
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 30_000;
const WS_READY_WATCHDOG_MS = 15_000;

function reconnectDelayMs(attempt) {
  const exponential = Math.min(
    RECONNECT_CAP_MS,
    RECONNECT_BASE_MS * 2 ** attempt,
  );
  // ±25% jitter so many clients don't reconnect in lockstep.
  const jitter = exponential * 0.25 * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(exponential + jitter));
}

function setWsStatusPill(text, kind) {
  const pill = document.getElementById("ws-status-pill");
  if (!pill) return;
  if (!text) {
    pill.hidden = true;
    pill.textContent = "";
    pill.classList.remove("pill-danger", "pill-warn", "ok");
    return;
  }
  pill.hidden = false;
  pill.textContent = text;
  pill.classList.remove("pill-danger", "pill-warn", "ok");
  if (kind === "error") pill.classList.add("pill-danger");
  else if (kind === "warn") pill.classList.add("pill-warn");
  else if (kind === "ok") pill.classList.add("ok");
}

export function createRpc({
  onNotification,
  onServerRequest,
  refreshWhoAmI,
  refreshThreads,
  refreshModels,
  refreshAccount,
  refreshRateLimits,
  refreshConfigState,
  refreshExperimentalFeatures,
  pushSettingsToBackend,
  appendSystem,
  setInFlight,
}) {
  let disconnectToastShown = false;
  let readyWatchdog = null;
  function rpcRaw(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  function rpcNotify(method, params) {
    rpcRaw({ jsonrpc: "2.0", method, params });
  }

  function rpcCall(method, params) {
    return new Promise((resolve, reject) => {
      const id = `c${state.nextReqId++}`;
      state.pending.set(id, { resolve, reject, method });
      rpcRaw({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (state.pending.has(id)) {
          state.pending.delete(id);
          reject(new Error(`rpc timeout: ${method}`));
        }
      }, 60_000);
    });
  }

  function rpcReply(id, result) {
    rpcRaw({ jsonrpc: "2.0", id, result });
  }

  function initializeRpcSession() {
    return rpcCall("initialize", {
      clientInfo: { name: "codex-web", title: "Codex Web", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    })
      .then(() => {
        state.initialized = true;
      })
      .catch((error) => {
        const message = String(error?.message ?? "");
        // The backend replies "Already initialized" when a WS reconnects to
        // a session whose app-server initialize() already succeeded. That's
        // not a real failure — the session is ready to use.
        if (/already initialized/i.test(message)) {
          state.initialized = true;
          return;
        }
        console.warn("initialize failed", error);
        setWsStatusPill("backend not ready", "warn");
        // Force the socket closed so the onclose handler schedules the next
        // attempt with exponential backoff instead of letting this one hang.
        try {
          state.ws?.close();
        } catch {}
      });
  }

  function onJsonRpc(message) {
    if (!message || typeof message !== "object") return;
    if (message.id !== undefined && message.method === undefined) {
      const pending = state.pending.get(String(message.id));
      if (pending) {
        state.pending.delete(String(message.id));
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      onServerRequest(message);
      return;
    }
    onNotification(message.method, message.params ?? {});
  }

  function armReadyWatchdog(ws) {
    if (readyWatchdog) clearTimeout(readyWatchdog);
    readyWatchdog = setTimeout(() => {
      if (state.ws !== ws) return;
      if (ws.readyState === WebSocket.OPEN && state.initialized) return;
      // Socket is stuck — either never opened or initialize never completed.
      // Force-close so the onclose handler schedules a reconnect with backoff.
      console.warn("ws ready watchdog fired; forcing reconnect");
      try {
        ws.close();
      } catch {}
    }, WS_READY_WATCHDOG_MS);
  }

  function clearReadyWatchdog() {
    if (readyWatchdog) {
      clearTimeout(readyWatchdog);
      readyWatchdog = null;
    }
  }

  function connectWs() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    state.ws = ws;
    setWsStatusPill("link: connecting…", "warn");
    armReadyWatchdog(ws);
    ws.addEventListener("open", async () => {
      state.reconnectAttempts = 0;
      disconnectToastShown = false;
      setWsStatusPill("link: syncing…", "warn");
      await initializeRpcSession();
      await refreshWhoAmI();
      await refreshThreads();
      await refreshModels();
      await refreshAccount();
      await refreshRateLimits();
      await refreshConfigState();
      await refreshExperimentalFeatures();
      if (state.activeThreadId) {
        try {
          await rpcCall("thread/resume", {
            threadId: state.activeThreadId,
            persistExtendedHistory: true,
          });
        } catch (error) {
          console.warn("thread/resume failed", error.message);
        }
      }
      void pushSettingsToBackend().catch(() => {});
      clearReadyWatchdog();
      setWsStatusPill(null);
      window.dispatchEvent(new CustomEvent("codex:ready"));
    });
    ws.addEventListener("message", (event) => {
      try {
        onJsonRpc(JSON.parse(event.data));
      } catch (error) {
        console.error("bad rpc frame", error, event.data);
      }
    });
    ws.addEventListener("close", (event) => {
      state.ws = null;
      state.initialized = false;
      setInFlight(false);
      clearReadyWatchdog();
      if (event.code === 4401) {
        setWsStatusPill("session expired", "error");
        appendSystem("Session expired. Reload the page.", "error");
        return;
      }
      const attempt = state.reconnectAttempts++;
      const delay = reconnectDelayMs(attempt);
      const delaySec = Math.max(1, Math.round(delay / 1000));
      setWsStatusPill(`reconnecting in ${delaySec}s…`, "warn");
      if (!disconnectToastShown) {
        disconnectToastShown = true;
        showToast(
          `Disconnected${event.reason ? ` (${event.reason})` : ""}. Reconnecting…`,
          "warn",
        );
      }
      setTimeout(connectWs, delay);
    });
    ws.addEventListener("error", () => ws.close());
  }

  function waitForReady(timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (
        state.ws &&
        state.ws.readyState === WebSocket.OPEN &&
        state.initialized
      ) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        window.removeEventListener("codex:ready", onReady);
        resolve();
      }, timeoutMs);
      function onReady() {
        clearTimeout(timer);
        window.removeEventListener("codex:ready", onReady);
        resolve();
      }
      window.addEventListener("codex:ready", onReady);
    });
  }

  return {
    connectWs,
    rpcCall,
    rpcNotify,
    rpcRaw,
    rpcReply,
    waitForReady,
  };
}
