import { $, state } from "./state.js";
import { escapeHtml } from "./utils.js";

const MOBILE_POLL_MS = 2000;

export function createMobilePreview({ appendSystem }) {
  let currentWorkdir = "";
  let snapshot = {
    detected: false,
    status: "idle",
    startCommand: "",
    configPath: "",
    packageJsonPath: "",
    output: "",
    expoUrl: "",
    dashboardUrl: "",
    qrDataUrl: "",
    running: false,
    exitCode: null,
    signal: null,
  };
  let pollTimer = null;

  function host() {
    return $("#workspace-mobile");
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePolling() {
    stopPolling();
    if (!snapshot.running) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void fetchStatus({ quiet: true });
    }, MOBILE_POLL_MS);
  }

  function render() {
    const root = host();
    if (!root) return;
    if (!currentWorkdir) {
      root.innerHTML = `
        <div class="workspace-empty">
          Activate a workspace project to launch an Expo mobile preview here.
        </div>
      `;
      return;
    }
    const statusMeta = [
      snapshot.status,
      snapshot.exitCode != null ? `exit ${snapshot.exitCode}` : "",
      snapshot.signal ? `signal ${snapshot.signal}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    root.innerHTML = `
      <div class="workspace-runner-head">
        <div>
          <div class="workspace-section-title">Mobile preview</div>
          <div class="workspace-runner-meta">
            ${escapeHtml(statusMeta || "idle")}
          </div>
        </div>
        <div class="workspace-actions">
          <button id="workspace-mobile-refresh" type="button">Refresh</button>
          <button
            id="workspace-mobile-start"
            type="button"
            class="primary"
            ${snapshot.detected ? "" : "disabled"}
          >
            Start Expo
          </button>
          <button
            id="workspace-mobile-stop"
            type="button"
            class="ghost"
            ${snapshot.running ? "" : "disabled"}
          >
            Stop
          </button>
        </div>
      </div>
      ${
        snapshot.detected
          ? `
            <div class="workspace-mobile-meta">
              <span>${escapeHtml(snapshot.configPath || snapshot.packageJsonPath || "Expo project detected")}</span>
              <span>${escapeHtml(snapshot.startCommand || "npx expo start --tunnel")}</span>
            </div>
            <div class="workspace-mobile-grid">
              <div class="workspace-mobile-card">
                <div class="workspace-section-title">Expo link</div>
                ${
                  snapshot.expoUrl
                    ? `
                      <a
                        href="${escapeHtml(snapshot.expoUrl)}"
                        target="_blank"
                        rel="noreferrer noopener"
                        class="workspace-mobile-link"
                      >
                        ${escapeHtml(snapshot.expoUrl)}
                      </a>
                    `
                    : `<div class="workspace-empty">Start Expo and wait for the tunnel URL.</div>`
                }
                ${
                  snapshot.dashboardUrl
                    ? `
                      <a
                        href="${escapeHtml(snapshot.dashboardUrl)}"
                        target="_blank"
                        rel="noreferrer noopener"
                        class="workspace-mobile-link subdued"
                      >
                        ${escapeHtml(snapshot.dashboardUrl)}
                      </a>
                    `
                    : ""
                }
              </div>
              <div class="workspace-mobile-card workspace-mobile-qr-card">
                <div class="workspace-section-title">Scan in Expo Go</div>
                ${
                  snapshot.qrDataUrl
                    ? `<img id="workspace-mobile-qr" class="workspace-mobile-qr" src="${escapeHtml(snapshot.qrDataUrl)}" alt="Expo QR code" />`
                    : `<div class="workspace-empty">A QR code will appear as soon as Expo prints a mobile link.</div>`
                }
              </div>
            </div>
            <pre class="workspace-mobile-output">${escapeHtml(snapshot.output || "Waiting for Expo output…")}</pre>
          `
          : `
            <div class="workspace-empty">
              No Expo project detected yet. Add an <code>app.json</code> or install <code>expo</code> in this workspace, then refresh.
            </div>
          `
      }
    `;
    $("#workspace-mobile-refresh")?.addEventListener("click", async () => {
      const button = $("#workspace-mobile-refresh");
      if (button) button.disabled = true;
      try {
        await fetchStatus();
      } catch (error) {
        appendSystem(
          `mobile preview refresh failed: ${error.message}`,
          "error",
        );
      } finally {
        if (button) button.disabled = false;
      }
    });
    $("#workspace-mobile-start")?.addEventListener("click", async () => {
      const button = $("#workspace-mobile-start");
      if (button) button.disabled = true;
      try {
        await start();
      } catch (error) {
        appendSystem(`mobile preview start failed: ${error.message}`, "error");
      } finally {
        if (button) button.disabled = false;
      }
    });
    $("#workspace-mobile-stop")?.addEventListener("click", async () => {
      const button = $("#workspace-mobile-stop");
      if (button) button.disabled = true;
      stopPolling();
      snapshot = {
        ...snapshot,
        running: false,
        status: "stopped",
        output: trimLocalOutput(
          `${snapshot.output || ""}\n[codex-web] stopped mobile preview\n`,
        ),
      };
      render();
      try {
        await stop();
      } catch (error) {
        appendSystem(`mobile preview stop failed: ${error.message}`, "error");
      } finally {
        if (button) button.disabled = false;
      }
    });
  }

  function trimLocalOutput(value) {
    const text = String(value ?? "");
    return text.length <= 8000 ? text : text.slice(-8000);
  }

  async function fetchStatus(options = {}) {
    const response = await fetch("/api/mobile/status");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        data.error ?? `mobile preview failed (${response.status})`,
      );
    }
    snapshot = {
      ...snapshot,
      ...data,
    };
    render();
    schedulePolling();
    if (!options.quiet && !snapshot.detected) {
      appendSystem(
        "No Expo project detected in the active workspace yet.",
        "warn",
      );
    }
  }

  async function start() {
    const response = await fetch("/api/mobile/start", {
      method: "POST",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        data.error ?? `mobile preview start failed (${response.status})`,
      );
    }
    snapshot = {
      ...snapshot,
      ...data,
    };
    render();
    schedulePolling();
  }

  async function stop() {
    const response = await fetch("/api/mobile/stop", {
      method: "POST",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        data.error ?? `mobile preview stop failed (${response.status})`,
      );
    }
    snapshot = {
      ...snapshot,
      ...data,
    };
    render();
    schedulePolling();
  }

  async function refresh() {
    const nextWorkdir = state.whoami?.workdir ?? "";
    if (!nextWorkdir) {
      currentWorkdir = "";
      snapshot = {
        detected: false,
        status: "idle",
        startCommand: "",
        configPath: "",
        packageJsonPath: "",
        output: "",
        expoUrl: "",
        dashboardUrl: "",
        qrDataUrl: "",
        running: false,
        exitCode: null,
        signal: null,
      };
      stopPolling();
      render();
      return;
    }
    currentWorkdir = nextWorkdir;
    await fetchStatus({ quiet: true }).catch((error) => {
      appendSystem(`mobile preview failed: ${error.message}`, "error");
    });
  }

  function init() {
    currentWorkdir = state.whoami?.workdir ?? "";
    render();
    if (currentWorkdir) {
      void refresh();
    }
  }

  return {
    init,
    refresh,
  };
}
