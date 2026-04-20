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
const DATABASE_EXTENSIONS = new Set([".db", ".db3", ".sqlite", ".sqlite3"]);
const DATABASE_PAGE_LIMIT = 50;

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

function isDatabaseFile(path) {
  return DATABASE_EXTENSIONS.has(fileExtension(path));
}

function createSelectedFile(overrides = {}) {
  return {
    path: "",
    text: "",
    loading: false,
    error: "",
    previewUrl: "",
    database: null,
    ...overrides,
  };
}

function formatDatabaseCell(value) {
  if (value == null) return "NULL";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
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
  let selectedFile = createSelectedFile();

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

  async function fetchJson(url) {
    const response = await fetch(url);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? `request failed (${response.status})`);
    }
    return data;
  }

  async function fetchDatabaseTable(path, table, offset = 0) {
    return fetchJson(
      `/api/db/table?path=${encodeURIComponent(path)}&table=${encodeURIComponent(table)}&limit=${DATABASE_PAGE_LIMIT}&offset=${offset}`,
    );
  }

  async function openDatabase(path, options = {}) {
    const currentDatabase =
      selectedFile.path === path ? selectedFile.database : null;
    selectedFile = createSelectedFile({
      path,
      loading: true,
      database: currentDatabase,
    });
    renderTree();
    renderViewer();
    try {
      const inspect = await fetchJson(
        `/api/db/inspect?path=${encodeURIComponent(path)}`,
      );
      const tables = inspect.tables ?? [];
      const selectedTable =
        options.table ??
        currentDatabase?.selectedTable ??
        tables[0]?.name ??
        "";
      let tableData = {
        columns: [],
        rows: [],
        totalRows: 0,
        offset: 0,
        limit: DATABASE_PAGE_LIMIT,
      };
      if (selectedTable) {
        tableData = await fetchDatabaseTable(
          path,
          selectedTable,
          options.offset ?? 0,
        );
      }
      selectedFile = createSelectedFile({
        path,
        loading: false,
        database: {
          dialect: inspect.dialect ?? "sqlite",
          tables,
          selectedTable,
          columns: tableData.columns ?? [],
          rows: tableData.rows ?? [],
          totalRows: tableData.totalRows ?? null,
          offset: tableData.offset ?? 0,
          limit: tableData.limit ?? DATABASE_PAGE_LIMIT,
        },
      });
      renderTree();
      renderViewer();
    } catch (error) {
      selectedFile = createSelectedFile({
        path,
        loading: false,
        error: error.message,
      });
      renderViewer();
      if (!options.quiet) {
        appendSystem(`database preview failed: ${error.message}`, "error");
      }
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
    const database = selectedFile.database;
    const selectedTableMeta = database?.tables?.find(
      (table) => table.name === database.selectedTable,
    );
    const databaseColumns =
      database?.columns?.map((column) => column.name ?? "") ??
      [];
    const databaseBody = !database?.tables?.length
      ? '<div class="workspace-empty">No tables or views were found in this SQLite database.</div>'
      : `
        <div class="workspace-db">
          <aside class="workspace-db-sidebar">
            <div class="workspace-section-title">Tables</div>
            <div class="workspace-db-list">
              ${database.tables
                .map(
                  (table) => `
                    <button
                      type="button"
                      class="workspace-db-table-button${table.name === database.selectedTable ? " active" : ""}"
                      data-db-table="${escapeHtml(table.name ?? "")}"
                    >
                      <span>${escapeHtml(table.name ?? "")}</span>
                      <span class="workspace-db-kind">${escapeHtml(table.type ?? "table")}</span>
                    </button>
                  `,
                )
                .join("")}
            </div>
          </aside>
          <div class="workspace-db-panel">
            <div class="workspace-db-meta">
              <span>${escapeHtml(selectedTableMeta?.name ?? "Select a table")}</span>
              <span>${database.totalRows == null ? "row count unavailable" : `${database.totalRows} rows`}</span>
              <span>${database.columns?.length ?? 0} columns</span>
            </div>
            ${
              database.selectedTable
                ? `
                  <div class="workspace-db-controls">
                    <button type="button" class="ghost" data-db-prev ${
                      database.offset > 0 ? "" : "disabled"
                    }>Previous</button>
                    <button type="button" class="ghost" data-db-next ${
                      database.totalRows != null &&
                      database.offset + database.rows.length >= database.totalRows
                        ? "disabled"
                        : ""
                    }>Next</button>
                    <button type="button" class="ghost" data-db-refresh>Refresh table</button>
                  </div>
                  <div class="workspace-db-scroll">
                    <table class="workspace-db-grid">
                      <thead>
                        <tr>
                          ${databaseColumns
                            .map((name) => `<th>${escapeHtml(name)}</th>`)
                            .join("")}
                        </tr>
                      </thead>
                      <tbody>
                        ${
                          database.rows?.length
                            ? database.rows
                                .map(
                                  (row) => `
                                    <tr>
                                      ${databaseColumns
                                        .map(
                                          (name) =>
                                            `<td>${escapeHtml(
                                              formatDatabaseCell(row?.[name]),
                                            )}</td>`,
                                        )
                                        .join("")}
                                    </tr>
                                  `,
                                )
                                .join("")
                            : `<tr><td colspan="${Math.max(databaseColumns.length, 1)}" class="workspace-db-empty-cell">No rows in this page.</td></tr>`
                        }
                      </tbody>
                    </table>
                  </div>
                `
                : '<div class="workspace-empty">Select a table or view to browse rows.</div>'
            }
          </div>
        </div>
      `;
    const body = selectedFile.loading
      ? '<div class="workspace-empty">Loading file…</div>'
      : selectedFile.error
        ? `<div class="workspace-empty workspace-error">${escapeHtml(selectedFile.error)}</div>`
        : database
          ? databaseBody
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
    host.querySelectorAll("[data-db-table]").forEach((button) => {
      button.addEventListener("click", () => {
        void openDatabase(selectedFile.path, {
          table: button.dataset.dbTable ?? "",
          offset: 0,
        });
      });
    });
    host.querySelector("[data-db-prev]")?.addEventListener("click", () => {
      void openDatabase(selectedFile.path, {
        table: selectedFile.database?.selectedTable ?? "",
        offset: Math.max(
          0,
          (selectedFile.database?.offset ?? 0) -
            (selectedFile.database?.limit ?? DATABASE_PAGE_LIMIT),
        ),
      });
    });
    host.querySelector("[data-db-next]")?.addEventListener("click", () => {
      void openDatabase(selectedFile.path, {
        table: selectedFile.database?.selectedTable ?? "",
        offset:
          (selectedFile.database?.offset ?? 0) +
          (selectedFile.database?.limit ?? DATABASE_PAGE_LIMIT),
      });
    });
    host.querySelector("[data-db-refresh]")?.addEventListener("click", () => {
      void openDatabase(selectedFile.path, {
        table: selectedFile.database?.selectedTable ?? "",
        offset: selectedFile.database?.offset ?? 0,
      });
    });
    hydrateWorkdirMedia(host);
  }

  async function openFile(path, options = {}) {
    if (isDatabaseFile(path)) {
      await openDatabase(path, options);
      return;
    }
    selectedFile = createSelectedFile({
      path,
      loading: true,
    });
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
      selectedFile = createSelectedFile({
        path,
        text: isTextRenderable(path, text)
          ? text
          : "This file looks binary, so the web viewer is showing the raw file preview instead.",
        loading: false,
        error: "",
        previewUrl,
      });
      renderTree();
      renderViewer();
    } catch (error) {
      selectedFile = createSelectedFile({
        path,
        text: "",
        loading: false,
        error: error.message,
        previewUrl: "",
      });
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
      selectedFile = createSelectedFile();
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
      selectedFile = createSelectedFile();
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
