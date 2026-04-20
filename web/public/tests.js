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

function summarizeOutput(command, output, exitCode) {
  if (!output) {
    return exitCode == null
      ? "Waiting for output…"
      : exitCode === 0
        ? "Completed successfully."
        : `Exited with code ${exitCode}.`;
  }
  if (command[0] === "cargo") {
    const match = /test result:\s+(\w+)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/i.exec(
      output,
    );
    if (match) {
      return `${match[2]} passed · ${match[3]} failed`;
    }
  }
  if (command[0] === "pytest") {
    const match = /=+\s+(.+?)\s+in\s+/i.exec(output);
    if (match) return match[1];
  }
  const passing = /(\d+)\s+passing/i.exec(output);
  const failing = /(\d+)\s+failing/i.exec(output);
  if (passing || failing) {
    return `${passing?.[1] ?? 0} passing · ${failing?.[1] ?? 0} failing`;
  }
  return exitCode == null
    ? "Streaming test output…"
    : exitCode === 0
      ? "Completed successfully."
      : `Exited with code ${exitCode}.`;
}

export function createTestRunner({ rpcCall, appendSystem }) {
  let currentRun = null;

  async function detectCommand() {
    const root = state.whoami?.workdir ?? "";
    if (!root) return null;
    const result = await rpcCall("fs/readDirectory", { path: root });
    const entries = new Set((result?.entries ?? []).map((entry) => entry.fileName));
    if (entries.has("package.json")) {
      return {
        label: "npm test -- --runInBand",
        command: ["npm", "test", "--", "--runInBand"],
      };
    }
    if (entries.has("Cargo.toml")) {
      return {
        label: "cargo test",
        command: ["cargo", "test"],
      };
    }
    if (entries.has("pytest.ini") || entries.has("pyproject.toml")) {
      return {
        label: "pytest",
        command: ["pytest"],
      };
    }
    return null;
  }

  function render() {
    const host = $("#workspace-runner");
    if (!host) return;
    const summary =
      currentRun?.summary ??
      "Detect a common test harness in the active workspace and stream the results here.";
    const meta = currentRun
      ? `${escapeHtml(currentRun.label)}${currentRun.exitCode != null ? ` · exit ${currentRun.exitCode}` : currentRun.running ? " · running" : ""}`
      : "No test run started yet.";
    const output = currentRun?.output ?? "";
    host.innerHTML = `
      <div class="workspace-runner-head">
        <div>
          <div class="workspace-section-title">Tests</div>
          <div class="workspace-runner-meta">${meta}</div>
        </div>
        <div class="workspace-actions">
          <button id="workspace-run-tests" type="button" class="primary">
            ${currentRun?.running ? "Running…" : "Run detected tests"}
          </button>
          <button id="workspace-stop-tests" type="button" ${currentRun?.running ? "" : "disabled"}>
            Stop
          </button>
        </div>
      </div>
      <div class="workspace-runner-summary">${escapeHtml(summary)}</div>
      ${
        output
          ? `<pre class="workspace-test-output"><code>${escapeHtml(output)}</code></pre>`
          : '<div class="workspace-empty">No test output yet.</div>'
      }
    `;
    $("#workspace-run-tests")?.addEventListener("click", () => {
      void runDetectedTests();
    });
    $("#workspace-stop-tests")?.addEventListener("click", () => {
      void stopTests();
    });
  }

  async function runDetectedTests() {
    if (currentRun?.running) return;
    try {
      const detected = await detectCommand();
      if (!detected) {
        appendSystem(
          "No package.json, Cargo.toml, pytest.ini, or pyproject.toml found in the active workspace.",
          "error",
        );
        return;
      }
      const processId = `workspace-tests-${Date.now()}`;
      currentRun = {
        ...detected,
        processId,
        output: "",
        running: true,
        exitCode: null,
        summary: `Running ${detected.label}…`,
      };
      render();
      const result = await rpcCall("command/exec", {
        processId,
        command: detected.command,
        cwd: state.whoami?.workdir ?? null,
        streamStdoutStderr: true,
        disableOutputCap: true,
        timeoutMs: 10 * 60 * 1000,
      });
      if (!currentRun || currentRun.processId !== processId) return;
      currentRun.running = false;
      currentRun.exitCode = result?.exitCode ?? null;
      currentRun.summary = summarizeOutput(
        detected.command,
        currentRun.output,
        currentRun.exitCode,
      );
      render();
      appendSystem(
        currentRun.exitCode === 0
          ? `Tests passed · ${detected.label}`
          : `Tests finished with exit ${currentRun.exitCode ?? "?"} · ${detected.label}`,
        currentRun.exitCode === 0 ? "info" : "error",
      );
    } catch (error) {
      if (!currentRun) return;
      currentRun.running = false;
      currentRun.exitCode = -1;
      currentRun.summary = error.message;
      render();
      appendSystem(`test run failed: ${error.message}`, "error");
    }
  }

  async function stopTests() {
    if (!currentRun?.running || !currentRun.processId) return;
    await rpcCall("command/exec/terminate", {
      processId: currentRun.processId,
    }).catch(() => {});
    currentRun.running = false;
    currentRun.summary = "Test run interrupted.";
    render();
  }

  function handleOutputDelta(params) {
    if (!currentRun?.running || params.processId !== currentRun.processId) return;
    currentRun.output = `${currentRun.output}${decodeBase64Utf8(params.deltaBase64 ?? "")}`;
    currentRun.summary = summarizeOutput(
      currentRun.command,
      currentRun.output,
      currentRun.exitCode,
    );
    render();
  }

  async function refresh() {
    render();
  }

  function init() {
    $("#workspace-run-tests-btn")?.addEventListener("click", () => {
      void runDetectedTests();
    });
    render();
  }

  return {
    handleOutputDelta,
    init,
    refresh,
    runDetectedTests,
  };
}
