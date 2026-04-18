import { state } from "./state.js";

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
        console.error("initialize failed", error);
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

  function connectWs() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    state.ws = ws;
    ws.addEventListener("open", async () => {
      state.reconnectAttempts = 0;
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
      if (event.code === 4401) {
        appendSystem("Session expired. Reload the page.", "error");
        return;
      }
      appendSystem(
        `Disconnected${event.reason ? ` (${event.reason})` : ""}. Reconnecting…`,
      );
      setTimeout(
        connectWs,
        Math.min(5000, 500 * 2 ** state.reconnectAttempts++),
      );
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
