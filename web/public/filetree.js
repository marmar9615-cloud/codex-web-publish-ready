import { $, load, save, state } from "./state.js";
import { escapeHtml, renderMarkdownish } from "./utils.js";
import { getWorkdirPreviewUrl, hydrateWorkdirMedia } from "./uploads.js";

const workspaceUi = load("workspaceUi", {
  visible: true,
});

const MARKDOWN_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);

const HTML_EXTENSIONS = new Set([".html", ".htm"]);

function fileExtension(path) {
  const index = String(path ?? "").lastIndexOf(".");
  return index >= 0 ? String(path).slice(index).toLowerCase() : "";
}

function decodeBase64Utf8(value) {
  try {
    const binary = atob(value ?? "");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function joinPath(dir, fileName) {
  return `${String(dir).replace(/\/$/, "")}/${fileName}`;
}

function parentPath(path) {
  const normalized = String(path ?? "").replace(/\/$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function looksBinary(text) {
  return text.includes("\u0000");
}

function isTextRenderable(path, text) {
  const extension = fileExtension(path);
  if (IMAGE_EXTENSIONS.has(extension) || HTML_EXTENSIONS.has(extension)) {
    return false;
  }
  return !looksBinary(text);
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) {
      return left.isDirectory ? -1 : 1;
    }
    return left.fileName.localeCompare(right.fileName);
  });
}

export function createFileTree({ rpcCall, appendSystem }) {
  const treeCache = new Map();
  const expandedDirectories = new Set();
  let activeRoot = "";
  let watchId = null;
  let selectedFile = {
    path: "",
    text: "",
    loading: false,
    error: "",
    previewUrl: "",
  };

  function persistUi() {
    save("workspaceUi", workspaceUi);
  }

  function applyVisibility() {
    document.body.classList.toggle(
      "workspace-collapsed",
      workspaceUi.visible === false,
    );
    const toggleButton = $("#workspace-toggle-btn");
    if (toggleButton) {
      toggleButton.textContent =
        workspaceUi.visible === false ? "Show files" : "Hide files";
    }
  }

  function setStatus(text) {
    const node = $("#workspace-status");
    if (node) node.textContent = text;
  }

  function setRootLabel(root) {
    const rootPath = $("#workspace-root-path");
    if (rootPath) rootPath.textContent = root || "No active workspace";
    const rootChip = $("#workspace-root-chip");
    if (!rootChip) return;
    if (!root) {
      rootChip.hidden = true;
      rootChip.textContent = "";
      return;
    }
    const label =
      state.whoami?.activeProjectName ??
      state.whoami?.activeProjectSlug ??
      root.split("/").filter(Boolean).at(-1) ??
      root;
    rootChip.hidden = false;
    rootChip.textContent = label;
  }

  function bindUi() {
    $("#workspace-toggle-btn")?.addEventListener("click", () => {
      workspaceUi.visible = workspaceUi.visible === false;
      persistUi();
      applyVisibility();
    });
    $("#workspace-close-btn")?.addEventListener("click", () => {
      workspaceUi.visible = false;
      persistUi();
      applyVisibility();
    });
    $("#workspace-refresh-btn")?.addEventListener("click", () => {
      void refresh({ force: true });
    });
  }

  async function unwatch() {
    if (!watchId) return;
    const nextWatchId = watchId;
    watchId = null;
    await rpcCall("fs/unwatch", { watchId: nextWatchId }).catch(() => {});
  }

  async function ensureWatch(root) {
    if (!root || watchId) return;
    const nextWatchId = `workspace-${Date.now()}`;
    await rpcCall("fs/watch", {
      watchId: nextWatchId,
      path: root,
    });
    watchId = nextWatchId;
  }

  async function loadDirectory(path, force = false) {
    if (!force && treeCache.has(path)) return treeCache.get(path);
    const result = await rpcCall("fs/readDirectory", { path });
    const entries = sortEntries(result?.entries ?? []);
    treeCache.set(path, entries);
    return entries;
  }

  async function refreshExpandedDirectories(force = false) {
    const directories = [activeRoot, ...expandedDirectories]
      .filter(Boolean)
      .filter((value, index, array) => array.indexOf(value) === index);
    for (const directory of directories) {
      await loadDirectory(directory, force).catch(() => {});
    }
  }

  function renderTreeBranch(dir, depth) {
    const entries = treeCache.get(dir) ?? [];
    if (!entries.length && depth === 0) {
      return '<div class="workspace-empty">This workspace is empty.</div>';
    }
    return entries
      .map((entry) => {
        const path = joinPath(dir, entry.fileName);
        const isExpanded = entry.isDirectory && expandedDirectories.has(path);
        const isSelected = selectedFile.path === path;
        return `
          <div class="workspace-node">
            <button
              type="button"
              class="workspace-row${isSelected ? " selected" : ""}"
              data-path="${escapeHtml(path)}"
              data-kind="${entry.isDirectory ? "directory" : "file"}"
              style="--workspace-depth:${depth}"
            >
              <span class="workspace-icon">${entry.isDirectory ? (isExpanded ? "▾" : "▸") : "·"}</span>
              <span class="workspace-label">${escapeHtml(entry.fileName)}</span>
            </button>
            ${
              entry.isDirectory && isExpanded
                ? `<div class="workspace-children">${renderTreeBranch(path, depth + 1)}</div>`
                : ""
            }
          </div>
        `;
      })
      .join("");
  }

  function renderTree() {
    const host = $("#workspace-files");
    if (!host) return;
    if (!activeRoot) {
      host.innerHTML =
        '<div class="workspace-empty">Connect to a live workspace to browse files.</div>';
      return;
    }
    host.innerHTML = `
      <div class="workspace-section-title">Workspace files</div>
      <div class="workspace-tree">${renderTreeBranch(activeRoot, 0)}</div>
    `;
    host.querySelectorAll(".workspace-row").forEach((button) => {
      button.addEventListener("click", async () => {
        const path = button.dataset.path ?? "";
        if (!path) return;
        if (button.dataset.kind === "directory") {
          if (expandedDirectories.has(path)) {
            expandedDirectories.delete(path);
            renderTree();
            return;
          }
          expandedDirectories.add(path);
          renderTree();
          await loadDirectory(path).catch((error) => {
            appendSystem(`file tree load failed: ${error.message}`, "error");
          });
          renderTree();
          return;
        }
        await openFile(path);
      });
    });
  }

  function renderViewer() {
    const host = $("#workspace-viewer");
    if (!host) return;
    if (!selectedFile.path) {
      host.innerHTML = `
        <div class="workspace-empty">
          Select a file from the workspace tree to preview it here.
        </div>
      `;
      return;
    }
    const extension = fileExtension(selectedFile.path);
    const isImage = IMAGE_EXTENSIONS.has(extension);
    const isHtml = HTML_EXTENSIONS.has(extension);
    const isMarkdown = MARKDOWN_EXTENSIONS.has(extension);
    const body = selectedFile.loading
      ? '<div class="workspace-empty">Loading file…</div>'
      : selectedFile.error
        ? `<div class="workspace-empty workspace-error">${escapeHtml(selectedFile.error)}</div>`
        : isImage
          ? `<div class="workspace-media-wrap"><img data-workdir-path="${escapeHtml(selectedFile.path)}" alt="${escapeHtml(selectedFile.path)}" /></div>`
          : isHtml && selectedFile.previewUrl
            ? `<iframe class="workspace-preview-frame" src="${escapeHtml(selectedFile.previewUrl)}" title="${escapeHtml(selectedFile.path)}"></iframe>`
            : isMarkdown
              ? `<div class="workspace-markdown">${renderMarkdownish(selectedFile.text)}</div>`
              : `<pre class="workspace-code"><code>${escapeHtml(selectedFile.text)}</code></pre>`;
    host.innerHTML = `
      <div class="workspace-viewer-head">
        <div>
          <div class="workspace-section-title">Preview</div>
          <div class="workspace-viewer-path">${escapeHtml(selectedFile.path)}</div>
        </div>
        <button type="button" id="workspace-open-preview" class="ghost"${
          selectedFile.previewUrl ? "" : " disabled"
        }>
          Open
        </button>
      </div>
      <div class="workspace-viewer-body">${body}</div>
    `;
    const openPreview = $("#workspace-open-preview");
    openPreview?.addEventListener("click", () => {
      if (!selectedFile.previewUrl) return;
      window.open(selectedFile.previewUrl, "_blank", "noopener");
    });
    hydrateWorkdirMedia(host);
  }

  async function openFile(path, options = {}) {
    selectedFile = {
      path,
      text: "",
      loading: true,
      error: "",
      previewUrl: "",
    };
    renderTree();
    renderViewer();
    try {
      const result = await rpcCall("fs/readFile", { path });
      const text = decodeBase64Utf8(result?.dataBase64 ?? "");
      const previewUrl =
        IMAGE_EXTENSIONS.has(fileExtension(path)) ||
        HTML_EXTENSIONS.has(fileExtension(path))
          ? await getWorkdirPreviewUrl(path).catch(() => "")
          : "";
      selectedFile = {
        path,
        text: isTextRenderable(path, text)
          ? text
          : "This file looks binary, so the web viewer is showing the raw file preview instead.",
        loading: false,
        error: "",
        previewUrl,
      };
      renderTree();
      renderViewer();
    } catch (error) {
      selectedFile = {
        path,
        text: "",
        loading: false,
        error: error.message,
        previewUrl: "",
      };
      renderViewer();
      if (!options.quiet) {
        appendSystem(`file preview failed: ${error.message}`, "error");
      }
    }
  }

  async function refresh({ force = false } = {}) {
    applyVisibility();
    const nextRoot = state.whoami?.workdir ?? "";
    setRootLabel(nextRoot);
    if (!nextRoot) {
      activeRoot = "";
      treeCache.clear();
      selectedFile = {
        path: "",
        text: "",
        loading: false,
        error: "",
        previewUrl: "",
      };
      renderTree();
      renderViewer();
      setStatus("idle");
      return;
    }
    if (!state.initialized) {
      activeRoot = nextRoot;
      setStatus("connecting");
      return;
    }
    if (nextRoot !== activeRoot) {
      await unwatch();
      activeRoot = nextRoot;
      treeCache.clear();
      expandedDirectories.clear();
      expandedDirectories.add(activeRoot);
      selectedFile = {
        path: "",
        text: "",
        loading: false,
        error: "",
        previewUrl: "",
      };
    }
    setStatus("loading");
    await ensureWatch(activeRoot).catch((error) => {
      appendSystem(`file watch failed: ${error.message}`, "error");
    });
    await refreshExpandedDirectories(force).catch((error) => {
      appendSystem(`file tree refresh failed: ${error.message}`, "error");
    });
    if (selectedFile.path && force) {
      await openFile(selectedFile.path, { quiet: true });
    }
    renderTree();
    renderViewer();
    setStatus("watching");
  }

  async function handleFsChanged(params) {
    if (!watchId || params?.watchId !== watchId) return;
    const changedPaths = params?.changedPaths ?? [];
    if (
      !changedPaths.some(
        (path) => path === activeRoot || path.startsWith(`${activeRoot}/`),
      )
    ) {
      return;
    }
    for (const changedPath of changedPaths) {
      treeCache.delete(changedPath);
      treeCache.delete(parentPath(changedPath));
    }
    await refresh({ force: true });
  }

  function init() {
    bindUi();
    applyVisibility();
    renderTree();
    renderViewer();
  }

  return {
    init,
    refresh,
    handleFsChanged,
  };
}
