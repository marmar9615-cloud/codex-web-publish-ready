import { $, state } from "./state.js";
import { escapeHtml } from "./utils.js";

function decodeBase64Utf8(value) {
  try {
    const binary = atob(value ?? "");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function stripAnsi(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "");
}

export function createTerminal({ appendSystem }) {
  let ws = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let currentWorkdir = "";
  let status = "idle";
  let shell = "";
  let output = "";
  let intentionalClose = false;

  function host() {
    return $("#workspace-terminal");
  }

  function scheduleReconnect() {
    if (reconnectTimer || !currentWorkdir) return;
    reconnectTimer = setTimeout(
      () => {
        reconnectTimer = null;
        connect();
      },
      Math.min(4000, 500 * 2 ** reconnectAttempts++),
    );
  }

  function setStatus(nextStatus, nextShell = shell) {
    status = nextStatus;
    shell = nextShell || shell;
    render();
  }

  function appendOutput(text) {
    if (!text) return;
    output = `${output}${text}`;
    if (output.length > 100_000) {
      output = output.slice(-100_000);
    }
    const pre = $("#workspace-terminal-output");
    if (pre) {
      pre.textContent = output;
      pre.scrollTop = pre.scrollHeight;
    }
    const empty = $("#workspace-terminal-empty");
    if (empty) empty.hidden = Boolean(output);
  }

  function render() {
    const root = host();
    if (!root) return;
    const previousInput = root.querySelector("#workspace-terminal-input");
    const pendingValue = previousInput?.value ?? "";
    const pendingSelectionStart = previousInput?.selectionStart ?? null;
    const pendingSelectionEnd = previousInput?.selectionEnd ?? null;
    const hadFocus = previousInput && document.activeElement === previousInput;
    root.innerHTML = `
      <div class="workspace-runner-head">
        <div>
          <div class="workspace-section-title">Terminal</div>
          <div class="workspace-runner-meta">
            ${escapeHtml(status)}${shell ? ` · ${escapeHtml(shell)}` : ""}
          </div>
        </div>
        <div class="workspace-actions">
          <button id="workspace-terminal-restart" type="button">Restart shell</button>
          <button id="workspace-terminal-ctrlc" type="button">Ctrl+C</button>
          <button id="workspace-terminal-clear" type="button">Clear</button>
        </div>
      </div>
      <pre id="workspace-terminal-output" class="workspace-test-output"></pre>
      <div id="workspace-terminal-empty" class="workspace-empty"${output ? " hidden" : ""}>
        Open a named project or the scratch workspace, then run shell commands here.
      </div>
      <div class="workspace-terminal-form">
        <textarea
          id="workspace-terminal-input"
          rows="2"
          placeholder="echo hello from the embedded terminal"
        ></textarea>
        <button id="workspace-terminal-send" type="button" class="primary">Run</button>
      </div>
    `;
    $("#workspace-terminal-output").textContent = output;
    $("#workspace-terminal-output").scrollTop = $(
      "#workspace-terminal-output",
    ).scrollHeight;
    $("#workspace-terminal-send")?.addEventListener("click", () => {
      void submit();
    });
    $("#workspace-terminal-input")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    });
    $("#workspace-terminal-restart")?.addEventListener("click", () => {
      output = "";
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "restart" }));
        setStatus("restarting");
      } else {
        connect({ restart: true });
      }
    });
    $("#workspace-terminal-ctrlc")?.addEventListener("click", () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "interrupt" }));
      }
    });
    $("#workspace-terminal-clear")?.addEventListener("click", () => {
      output = "";
      render();
    });
    const input = $("#workspace-terminal-input");
    if (input && pendingValue) {
      input.value = pendingValue;
      if (pendingSelectionStart != null && pendingSelectionEnd != null) {
        try {
          input.setSelectionRange(pendingSelectionStart, pendingSelectionEnd);
        } catch {}
      }
    }
    if (hadFocus && input) {
      input.focus();
    }
  }

  async function submit() {
    const input = $("#workspace-terminal-input");
    const text = input?.value ?? "";
    if (!text.trim()) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendSystem("terminal is not connected yet", "error");
      return;
    }
    ws.send(
      JSON.stringify({
        type: "input",
        data: text.endsWith("\n") ? text : `${text}\n`,
      }),
    );
    appendOutput(`$ ${text}\n`);
    input.value = "";
  }

  function disconnect() {
    intentionalClose = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    ws = null;
  }

  function connect(options = {}) {
    disconnect();
    intentionalClose = false;
    setStatus(options.restart ? "restarting" : "connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws/term`);
    ws.addEventListener("open", () => {
      reconnectAttempts = 0;
      setStatus("connected");
      if (options.restart) {
        ws.send(JSON.stringify({ type: "restart" }));
      }
    });
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "output") {
        appendOutput(stripAnsi(decodeBase64Utf8(message.dataBase64)));
        return;
      }
      if (message.type === "status") {
        const details = [];
        if (message.code != null) details.push(`exit ${message.code}`);
        if (message.signal) details.push(message.signal);
        const nextStatus = details.length
          ? `${message.state} · ${details.join(" · ")}`
          : message.state;
        setStatus(nextStatus, message.shell);
      }
    });
    ws.addEventListener("close", () => {
      ws = null;
      setStatus("disconnected");
      if (!intentionalClose) scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      try {
        ws?.close();
      } catch {}
    });
  }

  async function refresh() {
    const nextWorkdir = state.whoami?.workdir ?? "";
    if (!nextWorkdir) {
      currentWorkdir = "";
      disconnect();
      output = "";
      setStatus("idle");
      return;
    }
    if (nextWorkdir !== currentWorkdir) {
      currentWorkdir = nextWorkdir;
      output = "";
      connect();
      return;
    }
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect();
    } else {
      render();
    }
  }

  function init() {
    currentWorkdir = state.whoami?.workdir ?? "";
    render();
    if (currentWorkdir) {
      connect();
    }
  }

  return {
    init,
    refresh,
  };
}
