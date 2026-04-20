import { $, load, save, state } from "./state.js";
import { escapeHtml } from "./utils.js";

const previewUi = load("livePreviewUi", {
  port: "",
  path: "/",
  device: "desktop",
});

function normalizePath(value) {
  const text = String(value ?? "").trim();
  if (!text) return "/";
  return text.startsWith("/") ? text : `/${text}`;
}

function buildFrameUrl(baseUrl) {
  if (!baseUrl) return "";
  const path = normalizePath(previewUi.path);
  const separator = path.includes("?") ? "&" : "?";
  return `${baseUrl}${path}${separator}_=${Date.now()}`;
}

export function createLivePreview({ appendSystem }) {
  let currentWorkdir = "";
  let detectedPorts = [];
  let activeBaseUrl = "";

  function persistUi() {
    save("livePreviewUi", previewUi);
  }

  function host() {
    return $("#workspace-live-preview");
  }

  function render() {
    const root = host();
    if (!root) return;
    const frameUrl = buildFrameUrl(activeBaseUrl);
    const portButtons = detectedPorts.length
      ? `
        <div class="workspace-preview-port-list">
          ${detectedPorts
            .map(
              (item) => `
                <button
                  type="button"
                  class="ghost workspace-preview-port-chip"
                  data-port="${item.port}"
                >
                  ${escapeHtml(`${item.port}`)} · ${escapeHtml(item.command)}
                </button>
              `,
            )
            .join("")}
        </div>
      `
      : `
        <div class="workspace-runner-summary">
          No extra listening ports detected yet. Start a dev server, then click Detect.
        </div>
      `;
    root.innerHTML = `
      <div class="workspace-runner-head">
        <div>
          <div class="workspace-section-title">Live preview</div>
          <div class="workspace-runner-meta">
            ${escapeHtml(activeBaseUrl ? `${previewUi.port}${normalizePath(previewUi.path)}` : "No active preview")}
          </div>
        </div>
        <div class="workspace-actions">
          <button id="workspace-preview-detect" type="button">Detect</button>
          <button id="workspace-preview-reload" type="button"${activeBaseUrl ? "" : " disabled"}>Reload</button>
          <button id="workspace-preview-open" type="button"${activeBaseUrl ? "" : " disabled"}>Open</button>
        </div>
      </div>
      <div class="workspace-preview-toolbar">
        <label class="workspace-preview-field">
          <span>Port</span>
          <input
            id="workspace-preview-port"
            type="number"
            min="1024"
            max="65535"
            value="${escapeHtml(previewUi.port)}"
            placeholder="5173"
          />
        </label>
        <label class="workspace-preview-field">
          <span>Path</span>
          <input
            id="workspace-preview-path"
            type="text"
            value="${escapeHtml(normalizePath(previewUi.path))}"
            placeholder="/"
          />
        </label>
        <button id="workspace-preview-load" type="button" class="primary">Load</button>
      </div>
      <div class="workspace-preview-presets">
        ${["desktop", "tablet", "mobile"]
          .map(
            (device) => `
              <button
                type="button"
                class="${previewUi.device === device ? "primary" : "ghost"}"
                data-device="${device}"
              >
                ${escapeHtml(device)}
              </button>
            `,
          )
          .join("")}
      </div>
      ${portButtons}
      <div class="workspace-preview-stage device-${escapeHtml(previewUi.device)}">
        ${
          frameUrl
            ? `<iframe id="workspace-live-preview-frame" class="workspace-preview-frame" src="${escapeHtml(frameUrl)}" title="Live preview"></iframe>`
            : `<div class="workspace-empty">Choose a local preview port and path to render your app here.</div>`
        }
      </div>
    `;

    $("#workspace-preview-port")?.addEventListener("input", (event) => {
      previewUi.port = event.target.value;
      persistUi();
    });
    $("#workspace-preview-path")?.addEventListener("input", (event) => {
      previewUi.path = normalizePath(event.target.value);
      persistUi();
    });
    $("#workspace-preview-load")?.addEventListener("click", () => {
      void activate();
    });
    $("#workspace-preview-detect")?.addEventListener("click", () => {
      void refreshPorts();
    });
    $("#workspace-preview-reload")?.addEventListener("click", () => {
      render();
    });
    $("#workspace-preview-open")?.addEventListener("click", () => {
      const nextFrameUrl = buildFrameUrl(activeBaseUrl);
      if (!nextFrameUrl) return;
      window.open(nextFrameUrl, "_blank", "noopener");
    });
    root.querySelectorAll("[data-port]").forEach((button) => {
      button.addEventListener("click", () => {
        previewUi.port = button.dataset.port ?? "";
        persistUi();
        render();
      });
    });
    root.querySelectorAll("[data-device]").forEach((button) => {
      button.addEventListener("click", () => {
        previewUi.device = button.dataset.device ?? "desktop";
        persistUi();
        render();
      });
    });
  }

  async function refreshPorts() {
    const response = await fetch("/api/preview/ports");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? `preview detection failed (${response.status})`);
    }
    detectedPorts = data.ports ?? [];
    if (!previewUi.port && detectedPorts.length) {
      previewUi.port = String(detectedPorts[0].port);
      persistUi();
    }
    render();
  }

  async function activate(options = {}) {
    const port = Number.parseInt(String(previewUi.port ?? ""), 10);
    if (!Number.isInteger(port)) {
      if (!options.quiet) {
        appendSystem("enter a local preview port first", "warn");
      }
      return;
    }
    previewUi.path = normalizePath(previewUi.path);
    persistUi();
    const response = await fetch("/api/preview/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? `preview activation failed (${response.status})`);
    }
    activeBaseUrl = data.previewBaseUrl ?? "";
    render();
  }

  async function refresh() {
    const nextWorkdir = state.whoami?.workdir ?? "";
    if (!nextWorkdir) {
      currentWorkdir = "";
      activeBaseUrl = "";
      detectedPorts = [];
      render();
      return;
    }
    if (nextWorkdir !== currentWorkdir) {
      currentWorkdir = nextWorkdir;
      activeBaseUrl = "";
      await refreshPorts().catch((error) => {
        appendSystem(`preview detection failed: ${error.message}`, "error");
      });
      if (previewUi.port) {
        await activate({ quiet: true }).catch((error) => {
          appendSystem(`preview activation failed: ${error.message}`, "warn");
        });
      }
      render();
      return;
    }
    render();
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
