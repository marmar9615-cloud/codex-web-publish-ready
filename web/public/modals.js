import { $, load, state, save } from "./state.js";
import { escapeHtml } from "./utils.js";
import { showToast } from "./toast.js";

export function createModals({
  rpcCall,
  rpcRaw,
  rpcReply,
  refreshModels,
  refreshWhoAmI,
  refreshAccount,
  refreshConfigState,
  refreshExperimentalFeatures,
  pushSettingsToBackend,
  updateStatusBar,
  appendSystem,
  clearAuthRequiredCard,
}) {
  function isLocalBrowserFlowSupported() {
    return ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  }

  const hookEvents = [
    "PreToolUse",
    "PostToolUse",
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
  ];
  const threadMemoryModes = load("threadMemoryModes", {});
  let nextHookRowId = 1;

  function modal(html, onMount, options = {}) {
    const root = $("#modal-root");
    const className = options.className ? ` ${options.className}` : "";
    root.innerHTML = `<div class="modal-backdrop"><div class="modal${className}">${html}</div></div>`;
    root.querySelector(".modal-backdrop").addEventListener("click", (event) => {
      if (event.target.classList.contains("modal-backdrop")) closeModal();
    });
    if (onMount) onMount(root.querySelector(".modal"));
  }

  function closeModal() {
    $("#modal-root").innerHTML = "";
  }

  function openJsonModal(title, data) {
    modal(
      `
      <h2>${escapeHtml(title)}</h2>
      <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
      <div class="modal-actions">
        <button id="close" class="primary">Close</button>
      </div>
    `,
      (mount) => {
        mount.querySelector("#close").addEventListener("click", closeModal);
      },
    );
  }

  async function openListModal(title, method, params = {}) {
    try {
      const data = await rpcCall(method, params);
      openJsonModal(title, data);
    } catch (error) {
      appendSystem(`${title} failed: ${error.message}`, "error");
    }
  }

  function openTextModal(title, text, options = {}) {
    modal(
      `
      <h2>${escapeHtml(title)}</h2>
      <pre>${escapeHtml(text)}</pre>
      <div class="modal-actions">
        <button id="close" class="primary">Close</button>
      </div>
    `,
      (mount) => {
        mount.querySelector("#close").addEventListener("click", closeModal);
      },
      options,
    );
  }

  function openModelPickerModal() {
    const models = Array.isArray(state.models) ? state.models : [];
    const current = state.settings?.model ?? "";
    if (!models.length) {
      modal(
        `
        <h2>Pick a model</h2>
        <p class="settings-copy">The backend hasn't returned a model list yet. Sign in and wait for the connection, or open Settings to configure one.</p>
        <div class="modal-actions">
          <button id="close" class="primary">Close</button>
        </div>
      `,
        (mount) => {
          mount.querySelector("#close").addEventListener("click", closeModal);
        },
      );
      return;
    }
    const rows = models
      .map((model) => {
        const slug = model.id ?? model.slug ?? model.model ?? "";
        const name = model.name ?? model.title ?? slug;
        const desc = model.description ?? "";
        return `
          <button type="button" class="model-row${slug === current ? " active" : ""}" data-model-slug="${escapeHtml(slug)}">
            <div class="model-row-main">
              <strong>${escapeHtml(name)}</strong>
              ${slug && slug !== name ? `<span class="model-row-slug">${escapeHtml(slug)}</span>` : ""}
            </div>
            ${desc ? `<div class="model-row-desc">${escapeHtml(desc)}</div>` : ""}
          </button>
        `;
      })
      .join("");
    modal(
      `
      <h2>Pick a model</h2>
      <p class="settings-copy">Applies to new turns on the active thread. Reasoning effort and other settings stay as configured.</p>
      <div class="model-list">${rows}</div>
      <div class="modal-actions">
        <button id="close" class="primary">Close</button>
      </div>
    `,
      (mount) => {
        mount.querySelector("#close").addEventListener("click", closeModal);
        mount.querySelectorAll("[data-model-slug]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const slug = btn.dataset.modelSlug ?? "";
            if (!slug) return;
            state.settings.model = slug;
            save("settings", state.settings);
            updateStatusBar();
            closeModal();
            showToast(`Model set to ${slug}.`, "success");
            await pushSettingsToBackend().catch(() => {});
          });
        });
      },
    );
  }

  function openShortcutsModal() {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
    const rows = [
      ["Enter", "Send the current message"],
      ["Shift + Enter", "Insert a newline in the composer"],
      ["/", "Open the slash-command palette"],
      ["@", "Reference a file or path"],
      ["Esc", "Cancel the in-flight turn or close the autocomplete"],
      ["↑ / ↓", "Navigate autocomplete suggestions"],
      ["Tab", "Accept the highlighted autocomplete item"],
      ["?", "Show this shortcuts reference"],
      [`${mod} + K`, "Open the command palette (search actions and commands)"],
      [`${mod} + N`, "Start a new thread"],
      [`${mod} + B`, "Toggle the sidebar"],
      [`${mod} + ,`, "Open settings"],
    ];
    const body = rows
      .map(
        ([keys, desc]) => `
          <tr>
            <td class="kbd-cell">${keys
              .split(" + ")
              .map((k) => `<kbd>${escapeHtml(k)}</kbd>`)
              .join(" <span class=\"kbd-plus\">+</span> ")}</td>
            <td>${escapeHtml(desc)}</td>
          </tr>
        `,
      )
      .join("");
    modal(
      `
      <h2>Keyboard shortcuts</h2>
      <p class="settings-copy">Quick reference for the composer and autocomplete. Press <kbd>?</kbd> anywhere outside an input to reopen this.</p>
      <table class="shortcuts-table">
        <tbody>${body}</tbody>
      </table>
      <div class="modal-actions">
        <button id="close" class="primary">Close</button>
      </div>
    `,
      (mount) => {
        mount.querySelector("#close").addEventListener("click", closeModal);
      },
    );
  }

  function getSessionCodexHome() {
    const workdir = state.whoami?.workdir ?? "";
    if (!workdir) return "";
    return `${workdir.replace(/\/$/, "")}/.codex`;
  }

  function getHooksFilePath() {
    const codexHome = getSessionCodexHome();
    return codexHome ? `${codexHome}/hooks.json` : "";
  }

  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function decodeBase64(base64) {
    const binary = atob(base64 ?? "");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function createEmptyHookRow() {
    return {
      id: `hook-row-${nextHookRowId++}`,
      eventName: "PreToolUse",
      matcher: "",
      command: "",
      statusMessage: "",
      timeoutSec: "",
      enabled: true,
    };
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeHooksForEditor(rawHooksFile) {
    const preserved = { hooks: {} };
    const rows = [];
    let unsupportedCount = 0;
    const hooksByEvent = rawHooksFile?.hooks ?? {};

    for (const eventName of hookEvents) {
      const groups = Array.isArray(hooksByEvent?.[eventName])
        ? hooksByEvent[eventName]
        : [];
      for (const group of groups) {
        const matcher = typeof group?.matcher === "string" ? group.matcher : "";
        const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
        const preservedHooks = [];
        for (const hook of hooks) {
          if (hook?.type === "command" && !hook?.async) {
            rows.push({
              id: `hook-row-${nextHookRowId++}`,
              eventName,
              matcher,
              command: String(hook.command ?? ""),
              statusMessage: String(hook.statusMessage ?? ""),
              timeoutSec:
                hook.timeoutSec != null
                  ? String(hook.timeoutSec)
                  : hook.timeout != null
                    ? String(hook.timeout)
                    : "",
              enabled: true,
            });
            continue;
          }
          if (hook && typeof hook === "object") {
            preservedHooks.push(hook);
            unsupportedCount += 1;
          }
        }
        if (preservedHooks.length) {
          (preserved.hooks[eventName] ??= []).push({
            ...(matcher ? { matcher } : {}),
            hooks: preservedHooks,
          });
        }
      }
    }

    if (!rows.length) rows.push(createEmptyHookRow());
    return { rows, preserved, unsupportedCount };
  }

  async function loadHooksEditorState() {
    const hooksPath = getHooksFilePath();
    if (!state.initialized || !hooksPath) {
      return {
        rows: [createEmptyHookRow()],
        preserved: { hooks: {} },
        unsupportedCount: 0,
        loadError: null,
      };
    }
    try {
      const response = await rpcCall("fs/readFile", { path: hooksPath });
      const rawText = decodeBase64(response?.dataBase64 ?? "");
      const parsed = rawText.trim() ? JSON.parse(rawText) : { hooks: {} };
      return {
        ...normalizeHooksForEditor(parsed),
        loadError: null,
      };
    } catch (error) {
      return {
        rows: [createEmptyHookRow()],
        preserved: { hooks: {} },
        unsupportedCount: 0,
        loadError: /not found/i.test(error.message) ? null : error.message,
      };
    }
  }

  function buildHooksFile(rows, preserved) {
    const next = cloneJson(preserved ?? { hooks: {} });
    next.hooks ??= {};
    for (const row of rows) {
      if (!row.enabled || !row.command.trim()) continue;
      (next.hooks[row.eventName] ??= []).push({
        ...(row.matcher.trim() ? { matcher: row.matcher.trim() } : {}),
        hooks: [
          {
            type: "command",
            command: row.command.trim(),
            ...(row.statusMessage.trim()
              ? { statusMessage: row.statusMessage.trim() }
              : {}),
            ...(row.timeoutSec ? { timeoutSec: Number(row.timeoutSec) } : {}),
          },
        ],
      });
    }
    for (const [eventName, groups] of Object.entries(next.hooks)) {
      if (!Array.isArray(groups) || groups.length === 0) delete next.hooks[eventName];
    }
    return next;
  }

  async function writeHooksFile(rows, preserved) {
    const codexHome = getSessionCodexHome();
    const hooksPath = getHooksFilePath();
    if (!codexHome || !hooksPath) {
      throw new Error("session config directory is unavailable");
    }
    await rpcCall("fs/createDirectory", {
      path: codexHome,
      recursive: true,
    });
    const text = `${JSON.stringify(buildHooksFile(rows, preserved), null, 2)}\n`;
    await rpcCall("fs/writeFile", {
      path: hooksPath,
      dataBase64: encodeBase64(text),
    });
  }

  async function loadMemoriesData() {
    try {
      const response = await fetch("/api/memories");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error ?? `memory discovery failed (${response.status})`);
      }
      return data;
    } catch (error) {
      return { items: [], error: error.message };
    }
  }

  async function loadProjectSecretsData() {
    const slug = state.whoami?.activeProjectSlug;
    if (!slug) {
      return {
        available: false,
        configured: false,
        keys: [],
        slug: null,
        error: null,
      };
    }
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(slug)}/secrets`,
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error ?? `secret list failed (${response.status})`);
      }
      return {
        available: true,
        configured: Boolean(data.configured),
        keys: data.keys ?? [],
        slug,
        error: null,
      };
    } catch (error) {
      return {
        available: true,
        configured: false,
        keys: [],
        slug,
        error: error.message,
      };
    }
  }

  async function fetchProjectJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? `request failed (${response.status})`);
    }
    return data;
  }

  async function loadProjectGitData() {
    const slug = state.whoami?.activeProjectSlug;
    const emptyOauth = {
      configured: false,
      connected: false,
      user: null,
      scopes: [],
    };
    if (!slug) {
      return {
        available: false,
        slug: null,
        status: null,
        githubConfigured: false,
        repos: [],
        oauth: emptyOauth,
        error: null,
      };
    }
    try {
      const [statusData, reposData, oauthData] = await Promise.all([
        fetchProjectJson(`/api/projects/${encodeURIComponent(slug)}/git/status`),
        fetchProjectJson(`/api/github/repos?slug=${encodeURIComponent(slug)}`).catch(
          () => ({
            configured: false,
            repos: [],
          }),
        ),
        fetchProjectJson("/api/oauth/github/status").catch(() => emptyOauth),
      ]);
      return {
        available: true,
        slug,
        status: statusData.status ?? null,
        githubConfigured: Boolean(reposData.configured),
        repos: reposData.repos ?? [],
        oauth: {
          configured: Boolean(oauthData.configured),
          connected: Boolean(oauthData.connected),
          user: oauthData.user ?? null,
          scopes: Array.isArray(oauthData.scopes) ? oauthData.scopes : [],
        },
        error: null,
      };
    } catch (error) {
      return {
        available: true,
        slug,
        status: null,
        githubConfigured: false,
        repos: [],
        oauth: emptyOauth,
        error: error.message,
      };
    }
  }

  async function loadProjectDeployData() {
    const slug = state.whoami?.activeProjectSlug;
    const emptyRender = {
      configured: false,
      hookLabel: null,
      lastDeploy: null,
      error: null,
    };
    const emptyVercel = {
      configured: false,
      hookLabel: null,
      hasToken: false,
      hasProjectId: false,
      hasTeamId: false,
      recent: null,
      recentError: null,
      lastDeploy: null,
      error: null,
    };
    const emptyNetlify = {
      configured: false,
      hookLabel: null,
      hasToken: false,
      hasSiteId: false,
      recent: null,
      recentError: null,
      lastDeploy: null,
      error: null,
    };
    const emptyCloudflare = {
      configured: false,
      hookLabel: null,
      hasToken: false,
      hasAccountId: false,
      hasProjectName: false,
      recent: null,
      recentError: null,
      lastDeploy: null,
      error: null,
    };
    if (!slug) {
      return {
        available: false,
        slug: null,
        render: emptyRender,
        vercel: emptyVercel,
        netlify: emptyNetlify,
        cloudflare: emptyCloudflare,
      };
    }
    const [renderData, vercelData, netlifyData, cloudflareData] = await Promise.all([
      fetchProjectJson(`/api/projects/${encodeURIComponent(slug)}/deploy/render`)
        .then((data) => ({
          configured: Boolean(data.configured),
          hookLabel: data.hookLabel ?? null,
          lastDeploy: data.lastDeploy ?? null,
          error: null,
        }))
        .catch((error) => ({ ...emptyRender, error: error.message })),
      fetchProjectJson(`/api/projects/${encodeURIComponent(slug)}/deploy/vercel`)
        .then((data) => ({
          configured: Boolean(data.configured),
          hookLabel: data.hookLabel ?? null,
          hasToken: Boolean(data.hasToken),
          hasProjectId: Boolean(data.hasProjectId),
          hasTeamId: Boolean(data.hasTeamId),
          recent: Array.isArray(data.recent) ? data.recent : null,
          recentError: data.recentError ?? null,
          lastDeploy: data.lastDeploy ?? null,
          error: null,
        }))
        .catch((error) => ({ ...emptyVercel, error: error.message })),
      fetchProjectJson(`/api/projects/${encodeURIComponent(slug)}/deploy/netlify`)
        .then((data) => ({
          configured: Boolean(data.configured),
          hookLabel: data.hookLabel ?? null,
          hasToken: Boolean(data.hasToken),
          hasSiteId: Boolean(data.hasSiteId),
          recent: Array.isArray(data.recent) ? data.recent : null,
          recentError: data.recentError ?? null,
          lastDeploy: data.lastDeploy ?? null,
          error: null,
        }))
        .catch((error) => ({ ...emptyNetlify, error: error.message })),
      fetchProjectJson(`/api/projects/${encodeURIComponent(slug)}/deploy/cloudflare`)
        .then((data) => ({
          configured: Boolean(data.configured),
          hookLabel: data.hookLabel ?? null,
          hasToken: Boolean(data.hasToken),
          hasAccountId: Boolean(data.hasAccountId),
          hasProjectName: Boolean(data.hasProjectName),
          recent: Array.isArray(data.recent) ? data.recent : null,
          recentError: data.recentError ?? null,
          lastDeploy: data.lastDeploy ?? null,
          error: null,
        }))
        .catch((error) => ({ ...emptyCloudflare, error: error.message })),
    ]);
    return {
      available: true,
      slug,
      render: renderData,
      vercel: vercelData,
      netlify: netlifyData,
      cloudflare: cloudflareData,
    };
  }

  async function loadProjectLogsData() {
    const slug = state.whoami?.activeProjectSlug;
    if (!slug) {
      return {
        available: false,
        slug: null,
        configured: false,
        hasApiKey: false,
        hasServiceId: false,
        logs: [],
        error: null,
      };
    }
    try {
      const data = await fetchProjectJson(
        `/api/projects/${encodeURIComponent(slug)}/logs/render?limit=150`,
      );
      return {
        available: true,
        slug,
        configured: Boolean(data.configured),
        hasApiKey: Boolean(data.hasApiKey),
        hasServiceId: Boolean(data.hasServiceId),
        serviceIdLabel: data.serviceIdLabel ?? null,
        logs: Array.isArray(data.logs) ? data.logs : [],
        error: null,
      };
    } catch (error) {
      return {
        available: true,
        slug,
        configured: false,
        hasApiKey: false,
        hasServiceId: false,
        logs: [],
        error: error.message,
      };
    }
  }

  async function loadProjectShipData() {
    const slug = state.whoami?.activeProjectSlug;
    if (!slug) {
      return {
        available: false,
        slug: null,
        commands: {
          testsCommand: "",
          buildCommand: "",
          source: "none",
        },
        git: null,
        deploy: null,
        error: null,
      };
    }
    try {
      const data = await fetchProjectJson(`/api/projects/${encodeURIComponent(slug)}/ship`);
      return {
        available: true,
        slug,
        commands: data.commands ?? {
          testsCommand: "",
          buildCommand: "",
          source: "none",
        },
        git: data.git ?? null,
        deploy: data.deploy ?? null,
        error: null,
      };
    } catch (error) {
      return {
        available: true,
        slug,
        commands: {
          testsCommand: "",
          buildCommand: "",
          source: "none",
        },
        git: null,
        deploy: null,
        error: error.message,
      };
    }
  }

  function renderGitChangedFiles(status) {
    if (!status?.changedFiles?.length) {
      return '<div class="manager-empty">No local git changes detected right now.</div>';
    }
    return `
      <div class="manager-tags">
        ${status.changedFiles
          .slice(0, 16)
          .map(
            (file) =>
              `<span class="manager-tag">${escapeHtml(`${file.status} ${file.path}`)}</span>`,
          )
          .join("")}
      </div>
    `;
  }

  function renderRepoSuggestions(repos) {
    if (!repos?.length) return "";
    return `
      <div class="choice-row repo-choice-row">
        ${repos
          .slice(0, 8)
          .map(
            (repo) => `
          <button
            type="button"
            class="choice-chip"
            data-project-repo="${escapeHtml(repo.fullName ?? "")}"
            data-project-branch="${escapeHtml(repo.defaultBranch ?? "")}"
          >
            ${escapeHtml(repo.fullName ?? "")}
          </button>
        `,
          )
          .join("")}
      </div>
    `;
  }

  function renderProjectGitPanel(gitData) {
    if (!gitData.available) {
      return '<div class="manager-empty">Activate a named project from the sidebar before connecting GitHub.</div>';
    }
    if (gitData.error) {
      return `<div class="manager-empty">GitHub panel failed to load: ${escapeHtml(gitData.error)}</div>`;
    }
    const status = gitData.status;
    const oauth = gitData.oauth ?? {};
    let oauthBanner = "";
    if (oauth.connected && oauth.user) {
      oauthBanner = `
        <div class="manager-note github-oauth-banner github-oauth-connected">
          <div class="github-oauth-user">
            ${
              oauth.user.avatarUrl
                ? `<img src="${escapeHtml(oauth.user.avatarUrl)}" alt="" width="24" height="24" />`
                : ""
            }
            <div>
              <strong>${escapeHtml(oauth.user.name ?? oauth.user.login ?? "GitHub user")}</strong>
              <span class="manager-meta">@${escapeHtml(oauth.user.login ?? "?")}${oauth.scopes?.length ? ` · ${escapeHtml(oauth.scopes.join(", "))}` : ""}</span>
            </div>
          </div>
          <button id="github-oauth-logout" type="button" class="ghost">Disconnect</button>
        </div>
      `;
    } else if (oauth.configured) {
      oauthBanner = `
        <div class="manager-note github-oauth-banner">
          <div>
            <strong>Sign in with GitHub</strong>
            <span class="manager-meta">Skip the token — authorize once and every project gets repo access, PR creation, and clone for your account.</span>
          </div>
          <button id="github-oauth-signin" type="button" class="primary">Sign in with GitHub</button>
        </div>
      `;
    }
    return `
      ${oauthBanner}
      <p class="settings-copy">Clone a repo into this project, inspect the working tree, commit, push, and open a pull request. Private GitHub actions use your signed-in GitHub account, or a <code>GITHUB_TOKEN</code> from the project Secrets tab.</p>
      ${
        gitData.githubConfigured
          ? '<div class="manager-note">GitHub repo suggestions are live.</div>'
          : oauth.connected
            ? ""
            : '<div class="manager-note">Sign in with GitHub above, or add <code>GITHUB_TOKEN</code> in Secrets, to unlock private repo access and PR creation.</div>'
      }
      <div class="modal-row">
        <label>Clone from GitHub</label>
        <input id="project-git-repo" placeholder="owner/repo or https://github.com/owner/repo" />
      </div>
      <div class="modal-row">
        <label>Branch</label>
        <input id="project-git-branch" placeholder="main" />
      </div>
      ${renderRepoSuggestions(gitData.repos)}
      <div class="modal-actions modal-actions-left">
        <button id="project-git-clone" type="button" class="primary">Clone repo</button>
        <button id="project-git-refresh" type="button">Refresh status</button>
      </div>
      ${
        !status?.connected
          ? '<div class="manager-empty">This project is not a git checkout yet.</div>'
          : `
          <div class="manager-list">
            <article class="manager-card">
              <div class="manager-card-head">
                <div>
                  <h3>${escapeHtml(status.repoFullName ?? "Git repository")}</h3>
                  <div class="manager-meta">${escapeHtml(status.branch ?? "detached HEAD")} · ${escapeHtml(status.tracking ?? "no upstream")}</div>
                </div>
                <div class="manager-meta">${status.dirty ? "dirty" : "clean"}${status.ahead ? ` · ahead ${status.ahead}` : ""}${status.behind ? ` · behind ${status.behind}` : ""}</div>
              </div>
              ${
                status.lastCommit
                  ? `<div class="manager-blurb">Last commit: ${escapeHtml(status.lastCommit)}</div>`
                  : ""
              }
              ${
                status.remoteUrl
                  ? `<div class="manager-meta">${escapeHtml(status.remoteUrl)}</div>`
                  : ""
              }
              ${renderGitChangedFiles(status)}
            </article>
          </div>
          <div class="hook-grid">
            <div class="modal-row">
              <label>Commit message</label>
              <input id="project-git-commit-message" placeholder="Ship project update" />
            </div>
            <div class="modal-row">
              <label>Pull request title</label>
              <input id="project-git-pr-title" placeholder="Ship project update" />
            </div>
          </div>
          <div class="modal-row">
            <label>Pull request body</label>
            <textarea id="project-git-pr-body" rows="5" placeholder="What changed and how you verified it"></textarea>
          </div>
          <div class="modal-actions modal-actions-left">
            <button id="project-git-commit" type="button">Commit staged work</button>
            <button id="project-git-push" type="button">Push branch</button>
            <button id="project-git-pr" type="button">Open pull request</button>
          </div>
        `
      }
      <div id="project-git-feedback" class="manager-note" hidden></div>
    `;
  }

  function isDeployActive(deployData) {
    if (!deployData?.available) return false;
    const busyStates = new Set(["building", "queued"]);
    const recent = [
      ...(deployData.vercel?.recent ?? []).map((d) => (d.state ?? "").toLowerCase()),
      ...(deployData.netlify?.recent ?? []).map((d) =>
        mapNetlifyState((d.state ?? "").toLowerCase()),
      ),
      ...(deployData.cloudflare?.recent ?? []).map((d) =>
        mapCloudflareState((d.state ?? "").toLowerCase()),
      ),
    ];
    return recent.some((state) => busyStates.has(state));
  }

  function renderProjectDeployPanel(deployData) {
    if (!deployData.available) {
      return '<div class="manager-empty">Activate a named project from the sidebar before configuring deploy hooks.</div>';
    }
    const render = deployData.render ?? {};
    const vercel = deployData.vercel ?? {};
    const netlify = deployData.netlify ?? {};
    const cloudflare = deployData.cloudflare ?? {};
    const deployActiveBanner = isDeployActive(deployData)
      ? '<div class="manager-note deploy-active-note"><span class="deploy-pulse"></span>A deploy is in progress — refreshing every 10 seconds.</div>'
      : "";
    const renderLast = render.lastDeploy ?? {};
    const renderLastTime = renderLast.lastTriggeredAt
      ? new Date(renderLast.lastTriggeredAt).toLocaleString()
      : "Never";
    const vercelLast = vercel.lastDeploy ?? {};
    const vercelLastTime = vercelLast.lastTriggeredAt
      ? new Date(vercelLast.lastTriggeredAt).toLocaleString()
      : "Never";
    const netlifyLast = netlify.lastDeploy ?? {};
    const netlifyLastTime = netlifyLast.lastTriggeredAt
      ? new Date(netlifyLast.lastTriggeredAt).toLocaleString()
      : "Never";
    const cloudflareLast = cloudflare.lastDeploy ?? {};
    const cloudflareLastTime = cloudflareLast.lastTriggeredAt
      ? new Date(cloudflareLast.lastTriggeredAt).toLocaleString()
      : "Never";
    const renderError = render.error
      ? `<div class="manager-note manager-note-error">Render panel: ${escapeHtml(render.error)}</div>`
      : "";
    const vercelError = vercel.error
      ? `<div class="manager-note manager-note-error">Vercel panel: ${escapeHtml(vercel.error)}</div>`
      : "";
    const netlifyError = netlify.error
      ? `<div class="manager-note manager-note-error">Netlify panel: ${escapeHtml(netlify.error)}</div>`
      : "";
    const cloudflareError = cloudflare.error
      ? `<div class="manager-note manager-note-error">Cloudflare panel: ${escapeHtml(cloudflare.error)}</div>`
      : "";
    return `
      ${deployActiveBanner}
      ${renderError}
      ${vercelError}
      ${netlifyError}
      ${cloudflareError}

      <section class="deploy-provider">
        <header class="deploy-provider-head">
          <h3>Render</h3>
          <div class="manager-meta">${render.configured ? escapeHtml(render.hookLabel ?? "configured") : "not configured"}</div>
        </header>
        <p class="settings-copy">Triggers a Render sync hook. Hook URL is stored as <code>RENDER_SYNC_HOOK_URL</code>.</p>
        <div class="modal-row">
          <label>Render sync hook URL</label>
          <input id="render-hook-url" placeholder="https://api.render.com/sync/..." />
        </div>
        <div class="modal-actions modal-actions-left">
          <button id="render-hook-save" type="button">Save hook</button>
          <button id="render-hook-refresh" type="button">Refresh</button>
          <button id="render-hook-trigger" type="button" class="primary" ${render.configured ? "" : "disabled"}>Trigger deploy</button>
        </div>
        <div class="manager-card">
          <div class="manager-card-head">
            <div>
              <h4>Last trigger</h4>
              <div class="manager-meta">${escapeHtml(renderLastTime)}${renderLast.lastStatus ? ` · status ${renderLast.lastStatus}` : ""}</div>
            </div>
          </div>
          ${
            renderLast.lastResponseText
              ? `<pre>${escapeHtml(renderLast.lastResponseText)}</pre>`
              : '<div class="manager-blurb">No deploys have been triggered from this project yet.</div>'
          }
        </div>
      </section>

      <section class="deploy-provider">
        <header class="deploy-provider-head">
          <h3>Vercel</h3>
          <div class="manager-meta">${vercel.configured ? escapeHtml(vercel.hookLabel ?? "configured") : "not configured"}</div>
        </header>
        <p class="settings-copy">Triggers a Vercel deploy hook. Optionally add <code>VERCEL_TOKEN</code> + <code>VERCEL_PROJECT_ID</code> to show recent deployment status.</p>
        <div class="modal-row">
          <label>Vercel deploy hook URL</label>
          <input id="vercel-hook-url" placeholder="https://api.vercel.com/v1/integrations/deploy/..." />
        </div>
        <div class="modal-row modal-row-split">
          <div>
            <label>Vercel API token (optional)</label>
            <input id="vercel-token" type="password" placeholder="vercel_xxx…" autocomplete="off" ${vercel.hasToken ? 'data-has="true"' : ""} />
            ${vercel.hasToken ? '<div class="manager-meta">Saved. Leave blank to keep; enter a new value to rotate.</div>' : ""}
          </div>
          <div>
            <label>Project ID</label>
            <input id="vercel-project-id" placeholder="prj_…" ${vercel.hasProjectId ? 'data-has="true"' : ""} />
            ${vercel.hasProjectId ? '<div class="manager-meta">Saved.</div>' : ""}
          </div>
        </div>
        <div class="modal-row">
          <label>Team ID (optional, for team projects)</label>
          <input id="vercel-team-id" placeholder="team_…" ${vercel.hasTeamId ? 'data-has="true"' : ""} />
          ${vercel.hasTeamId ? '<div class="manager-meta">Saved.</div>' : ""}
        </div>
        <div class="modal-actions modal-actions-left">
          <button id="vercel-save" type="button">Save config</button>
          <button id="vercel-refresh" type="button">Refresh</button>
          <button id="vercel-trigger" type="button" class="primary" ${vercel.configured ? "" : "disabled"}>Trigger deploy</button>
        </div>
        <div class="manager-card">
          <div class="manager-card-head">
            <div>
              <h4>Last trigger</h4>
              <div class="manager-meta">${escapeHtml(vercelLastTime)}${vercelLast.lastStatus ? ` · status ${vercelLast.lastStatus}` : ""}</div>
            </div>
          </div>
          ${
            vercelLast.lastResponseText
              ? `<pre>${escapeHtml(vercelLast.lastResponseText)}</pre>`
              : '<div class="manager-blurb">No deploys triggered from this project yet.</div>'
          }
        </div>
        ${renderVercelRecent(vercel)}
      </section>

      <section class="deploy-provider">
        <header class="deploy-provider-head">
          <h3>Netlify</h3>
          <div class="manager-meta">${netlify.configured ? escapeHtml(netlify.hookLabel ?? "configured") : "not configured"}</div>
        </header>
        <p class="settings-copy">Triggers a Netlify build hook. Optionally add <code>NETLIFY_TOKEN</code> + <code>NETLIFY_SITE_ID</code> to show recent deployment status.</p>
        <div class="modal-row">
          <label>Netlify build hook URL</label>
          <input id="netlify-hook-url" placeholder="https://api.netlify.com/build_hooks/..." />
        </div>
        <div class="modal-row modal-row-split">
          <div>
            <label>Netlify API token (optional)</label>
            <input id="netlify-token" type="password" placeholder="nfp_…" autocomplete="off" ${netlify.hasToken ? 'data-has="true"' : ""} />
            ${netlify.hasToken ? '<div class="manager-meta">Saved. Leave blank to keep; enter a new value to rotate.</div>' : ""}
          </div>
          <div>
            <label>Site ID</label>
            <input id="netlify-site-id" placeholder="abc123-…" ${netlify.hasSiteId ? 'data-has="true"' : ""} />
            ${netlify.hasSiteId ? '<div class="manager-meta">Saved.</div>' : ""}
          </div>
        </div>
        <div class="modal-actions modal-actions-left">
          <button id="netlify-save" type="button">Save config</button>
          <button id="netlify-refresh" type="button">Refresh</button>
          <button id="netlify-trigger" type="button" class="primary" ${netlify.configured ? "" : "disabled"}>Trigger deploy</button>
        </div>
        <div class="manager-card">
          <div class="manager-card-head">
            <div>
              <h4>Last trigger</h4>
              <div class="manager-meta">${escapeHtml(netlifyLastTime)}${netlifyLast.lastStatus ? ` · status ${netlifyLast.lastStatus}` : ""}</div>
            </div>
          </div>
          ${
            netlifyLast.lastResponseText
              ? `<pre>${escapeHtml(netlifyLast.lastResponseText)}</pre>`
              : '<div class="manager-blurb">No deploys triggered from this project yet.</div>'
          }
        </div>
        ${renderNetlifyRecent(netlify)}
      </section>

      <section class="deploy-provider">
        <header class="deploy-provider-head">
          <h3>Cloudflare Pages</h3>
          <div class="manager-meta">${cloudflare.configured ? escapeHtml(cloudflare.hookLabel ?? "configured") : "not configured"}</div>
        </header>
        <p class="settings-copy">Triggers a Cloudflare Pages deploy hook. Optionally add <code>CLOUDFLARE_API_TOKEN</code> + <code>CLOUDFLARE_ACCOUNT_ID</code> + <code>CLOUDFLARE_PAGES_PROJECT_NAME</code> to show recent deployment status.</p>
        <div class="modal-row">
          <label>Deploy hook URL</label>
          <input id="cf-hook-url" placeholder="https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/..." />
        </div>
        <div class="modal-row modal-row-split">
          <div>
            <label>API token (optional)</label>
            <input id="cf-token" type="password" placeholder="cf_…" autocomplete="off" ${cloudflare.hasToken ? 'data-has="true"' : ""} />
            ${cloudflare.hasToken ? '<div class="manager-meta">Saved. Leave blank to keep; enter a new value to rotate.</div>' : ""}
          </div>
          <div>
            <label>Account ID</label>
            <input id="cf-account-id" placeholder="abcdef…" ${cloudflare.hasAccountId ? 'data-has="true"' : ""} />
            ${cloudflare.hasAccountId ? '<div class="manager-meta">Saved.</div>' : ""}
          </div>
        </div>
        <div class="modal-row">
          <label>Pages project name</label>
          <input id="cf-project-name" placeholder="my-app" ${cloudflare.hasProjectName ? 'data-has="true"' : ""} />
          ${cloudflare.hasProjectName ? '<div class="manager-meta">Saved.</div>' : ""}
        </div>
        <div class="modal-actions modal-actions-left">
          <button id="cf-save" type="button">Save config</button>
          <button id="cf-refresh" type="button">Refresh</button>
          <button id="cf-trigger" type="button" class="primary" ${cloudflare.configured ? "" : "disabled"}>Trigger deploy</button>
        </div>
        <div class="manager-card">
          <div class="manager-card-head">
            <div>
              <h4>Last trigger</h4>
              <div class="manager-meta">${escapeHtml(cloudflareLastTime)}${cloudflareLast.lastStatus ? ` · status ${cloudflareLast.lastStatus}` : ""}</div>
            </div>
          </div>
          ${
            cloudflareLast.lastResponseText
              ? `<pre>${escapeHtml(cloudflareLast.lastResponseText)}</pre>`
              : '<div class="manager-blurb">No deploys triggered from this project yet.</div>'
          }
        </div>
        ${renderCloudflareRecent(cloudflare)}
      </section>

      <div id="project-deploy-feedback" class="manager-note" hidden></div>
    `;
  }

  function renderCloudflareRecent(cloudflare) {
    if (cloudflare.recentError) {
      return `<div class="manager-note manager-note-error">Recent deployments: ${escapeHtml(cloudflare.recentError)}</div>`;
    }
    if (!cloudflare.recent) {
      return "";
    }
    if (!cloudflare.recent.length) {
      return '<div class="manager-blurb">No recent Cloudflare Pages deployments for this project name.</div>';
    }
    return `
      <div class="manager-list vercel-recent">
        ${cloudflare.recent
          .map((deploy) => {
            const ts = deploy.createdAt
              ? new Date(deploy.createdAt).toLocaleString()
              : "";
            const stateClass = mapCloudflareState((deploy.state ?? "").toLowerCase());
            const stageLabel = deploy.stage ? ` · ${escapeHtml(deploy.stage)}` : "";
            return `
              <article class="manager-card vercel-deploy vercel-state-${escapeHtml(stateClass)}">
                <div class="manager-card-head">
                  <div>
                    <h4>${escapeHtml(deploy.target ?? "preview")} · ${escapeHtml(deploy.branch ?? "—")}</h4>
                    <div class="manager-meta">${escapeHtml(ts)}${deploy.state ? ` · ${escapeHtml(deploy.state)}${stageLabel}` : ""}</div>
                  </div>
                  ${
                    deploy.url
                      ? `<a class="button-link" target="_blank" rel="noopener" href="${escapeHtml(deploy.url)}">Open</a>`
                      : ""
                  }
                </div>
                ${
                  deploy.commitMessage
                    ? `<div class="manager-blurb">${escapeHtml(deploy.commitMessage)}</div>`
                    : ""
                }
              </article>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function mapCloudflareState(state) {
    switch (state) {
      case "success":
        return "ready";
      case "active":
      case "building":
      case "running":
      case "initializing":
      case "queued":
        return "building";
      case "idle":
      case "pending":
        return "queued";
      case "failure":
      case "error":
        return "error";
      case "canceled":
      case "cancelled":
        return "canceled";
      default:
        return "unknown";
    }
  }

  function renderNetlifyRecent(netlify) {
    if (netlify.recentError) {
      return `<div class="manager-note manager-note-error">Recent deployments: ${escapeHtml(netlify.recentError)}</div>`;
    }
    if (!netlify.recent) {
      return "";
    }
    if (!netlify.recent.length) {
      return '<div class="manager-blurb">No recent Netlify deployments for this site id.</div>';
    }
    return `
      <div class="manager-list vercel-recent">
        ${netlify.recent
          .map((deploy) => {
            const ts = deploy.createdAt
              ? new Date(deploy.createdAt).toLocaleString()
              : "";
            const stateClass = (deploy.state ?? "").toLowerCase();
            return `
              <article class="manager-card vercel-deploy vercel-state-${escapeHtml(mapNetlifyState(stateClass))}">
                <div class="manager-card-head">
                  <div>
                    <h4>${escapeHtml(deploy.target ?? "deploy")} · ${escapeHtml(deploy.branch ?? "—")}</h4>
                    <div class="manager-meta">${escapeHtml(ts)}${deploy.state ? ` · ${escapeHtml(deploy.state)}` : ""}</div>
                  </div>
                  ${
                    deploy.url
                      ? `<a class="button-link" target="_blank" rel="noopener" href="${escapeHtml(deploy.url)}">Open</a>`
                      : ""
                  }
                </div>
                ${
                  deploy.commitMessage
                    ? `<div class="manager-blurb">${escapeHtml(deploy.commitMessage)}</div>`
                    : ""
                }
              </article>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function mapNetlifyState(state) {
    switch (state) {
      case "ready":
        return "ready";
      case "building":
      case "uploading":
      case "processing":
      case "prepared":
      case "enqueued":
        return "building";
      case "new":
      case "pending":
        return "queued";
      case "error":
      case "rejected":
        return "error";
      case "canceled":
        return "canceled";
      default:
        return "unknown";
    }
  }

  function renderVercelRecent(vercel) {
    if (vercel.recentError) {
      return `<div class="manager-note manager-note-error">Recent deployments: ${escapeHtml(vercel.recentError)}</div>`;
    }
    if (!vercel.recent) {
      return "";
    }
    if (!vercel.recent.length) {
      return '<div class="manager-blurb">No recent Vercel deployments for this project id.</div>';
    }
    return `
      <div class="manager-list vercel-recent">
        ${vercel.recent
          .map((deploy) => {
            const ts = deploy.createdAt
              ? new Date(deploy.createdAt).toLocaleString()
              : "";
            const url = deploy.url ? `https://${deploy.url}` : "";
            const stateClass = (deploy.state ?? "").toLowerCase();
            return `
              <article class="manager-card vercel-deploy vercel-state-${escapeHtml(stateClass || "unknown")}">
                <div class="manager-card-head">
                  <div>
                    <h4>${escapeHtml(deploy.target ?? "preview")} · ${escapeHtml(deploy.branch ?? "—")}</h4>
                    <div class="manager-meta">${escapeHtml(ts)}${deploy.state ? ` · ${escapeHtml(deploy.state)}` : ""}</div>
                  </div>
                  ${
                    url
                      ? `<a class="button-link" target="_blank" rel="noopener" href="${escapeHtml(url)}">Open</a>`
                      : ""
                  }
                </div>
                ${
                  deploy.commitMessage
                    ? `<div class="manager-blurb">${escapeHtml(deploy.commitMessage)}</div>`
                    : ""
                }
              </article>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function renderShipSteps(result) {
    if (!result?.steps?.length) {
      return '<div class="manager-empty">No ship run has started yet.</div>';
    }
    const banner = result.tagCreated
      ? `<div class="manager-note ship-tag-note">Tagged <code>${escapeHtml(result.tagCreated)}</code> and pushed to origin.</div>`
      : "";
    return `
      ${banner}
      <div class="manager-list">
        ${result.steps
          .map(
            (step) => `
          <article class="manager-card">
            <div class="manager-card-head">
              <div>
                <h3>${escapeHtml(step.name ?? "step")}</h3>
                <div class="manager-meta">${escapeHtml(step.command ?? "")}</div>
              </div>
              <div class="manager-meta">${step.ok ? "passed" : "failed"}${step.code != null ? ` · ${step.code}` : ""}</div>
            </div>
            ${
              step.output
                ? `<pre>${escapeHtml(step.output)}</pre>`
                : '<div class="manager-blurb">No output captured.</div>'
            }
          </article>
        `,
          )
          .join("")}
      </div>
    `;
  }

  function renderProjectLogsPanel(logsData) {
    if (!logsData.available) {
      return '<div class="manager-empty">Activate a named project to stream its logs.</div>';
    }
    if (logsData.error) {
      return `<div class="manager-empty">Logs failed to load: ${escapeHtml(logsData.error)}</div>`;
    }
    if (!logsData.configured) {
      const missing = [];
      if (!logsData.hasApiKey) missing.push("<code>RENDER_API_KEY</code>");
      if (!logsData.hasServiceId) missing.push("<code>RENDER_SERVICE_ID</code>");
      return `
        <p class="settings-copy">Stream live logs from your Render service without leaving Codex Web.</p>
        <div class="manager-empty logs-setup">
          <p><strong>Missing secrets:</strong> ${missing.join(" and ")}.</p>
          <p>Add them in the project secrets (Settings → Secrets) or as Render environment variables. <code>RENDER_API_KEY</code> is a personal access token from the Render dashboard; <code>RENDER_SERVICE_ID</code> is the id of the service you want to tail (format <code>srv-...</code>).</p>
        </div>
      `;
    }
    const lines = (logsData.logs ?? [])
      .slice()
      .sort((left, right) => {
        const leftTs = new Date(left.timestamp ?? 0).getTime();
        const rightTs = new Date(right.timestamp ?? 0).getTime();
        return leftTs - rightTs;
      })
      .map((log) => {
        const ts = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : "";
        const level = log.labels?.type ?? log.labels?.level ?? "";
        const message = String(log.message ?? "");
        return `
          <div class="log-line log-level-${escapeHtml(level || "info")}">
            <span class="log-time">${escapeHtml(ts)}</span>
            ${level ? `<span class="log-level">${escapeHtml(level)}</span>` : ""}
            <span class="log-message">${escapeHtml(message)}</span>
          </div>
        `;
      })
      .join("");
    return `
      <p class="settings-copy">Live tail of your Render service (${escapeHtml(logsData.serviceIdLabel ?? "configured")}). Auto-refresh polls every 8 seconds; toggle it off to freeze the view.</p>
      <div class="logs-actions">
        <button id="logs-refresh" type="button" class="ghost">Refresh now</button>
        <label class="logs-autorefresh">
          <input id="logs-autorefresh" type="checkbox" />
          <span>Auto-refresh (8s)</span>
        </label>
      </div>
      <div id="logs-viewer" class="logs-viewer">
        ${lines || '<div class="manager-blurb">No log lines returned yet — try triggering a deploy or hitting the app.</div>'}
      </div>
    `;
  }

  function renderProjectShipPanel(shipData, lastResult) {
    if (!shipData.available) {
      return '<div class="manager-empty">Activate a named project from the sidebar before running Ship it.</div>';
    }
    if (shipData.error) {
      return `<div class="manager-empty">Ship it failed to load: ${escapeHtml(shipData.error)}</div>`;
    }
    return `
      <p class="settings-copy">Run tests, optionally build, commit what changed, push the active branch, and trigger the Render sync hook in one sequence.</p>
      <div class="hook-grid">
        <div class="modal-row">
          <label>Tests command</label>
          <input id="ship-tests-command" value="${escapeHtml(shipData.commands?.testsCommand ?? "")}" placeholder="npm test" />
        </div>
        <div class="modal-row">
          <label>Build command</label>
          <input id="ship-build-command" value="${escapeHtml(shipData.commands?.buildCommand ?? "")}" placeholder="npm run build" />
        </div>
      </div>
      <div class="modal-row">
        <label>Commit message</label>
        <input id="ship-commit-message" placeholder="Ship project update" />
      </div>
      <label class="hook-toggle ship-toggle">
        <input id="ship-deploy-after" type="checkbox" ${shipData.deploy?.configured ? "checked" : ""} ${shipData.deploy?.configured ? "" : "disabled"} />
        <span>Trigger the configured Render deploy after git push</span>
      </label>
      <label class="hook-toggle ship-toggle">
        <input id="ship-generate-changelog" type="checkbox" />
        <span>Generate changelog from commits since last tag</span>
      </label>
      <label class="hook-toggle ship-toggle">
        <input id="ship-create-tag" type="checkbox" />
        <span>Create and push annotated git tag</span>
      </label>
      <div class="modal-row">
        <label>Tag name (blank for auto <code>vYYYY.MM.DD</code>)</label>
        <input id="ship-tag-name" placeholder="v2026.04.20" />
      </div>
      <div class="manager-meta">Detection source: ${escapeHtml(shipData.commands?.source ?? "none")} · Git ${shipData.git?.connected ? "connected" : "not connected"} · Render ${shipData.deploy?.configured ? "configured" : "not configured"}</div>
      <div class="modal-actions modal-actions-left">
        <button id="ship-run" type="button" class="primary">Run Ship it</button>
        <button id="ship-refresh" type="button">Refresh plan</button>
      </div>
      <div id="project-ship-feedback" class="manager-note" hidden></div>
      ${renderShipSteps(lastResult)}
    `;
  }

  async function openProjectToolsModal(initialTab = "git") {
    let currentTab = initialTab;
    let currentGitData = {
      available: false,
      slug: null,
      status: null,
      githubConfigured: false,
      repos: [],
      error: null,
    };
    let currentDeployData = {
      available: false,
      slug: null,
      configured: false,
      hookLabel: null,
      lastDeploy: null,
      error: null,
    };
    let currentShipData = {
      available: false,
      slug: null,
      commands: {
        testsCommand: "",
        buildCommand: "",
        source: "none",
      },
      git: null,
      deploy: null,
      error: null,
    };
    let currentLogsData = {
      available: false,
      slug: null,
      configured: false,
      hasApiKey: false,
      hasServiceId: false,
      logs: [],
      error: null,
    };
    let lastShipResult = null;
    let logsAutoRefresh = false;
    let logsTimer = null;
    let deployTimer = null;

    const panel = (tab, body) => `
      <section class="settings-panel" data-project-panel="${tab}" ${currentTab === tab ? "" : "hidden"}>
        ${body}
      </section>
    `;

    const renderModal = () => `
      <h2>Project tools</h2>
      <p class="settings-copy">${escapeHtml(state.whoami?.activeProjectName ?? "Project")} · ${escapeHtml(state.whoami?.activeProjectSlug ?? "No active project")}</p>
      <div class="settings-tabs">
        <button type="button" class="settings-tab ${currentTab === "git" ? "active" : ""}" data-project-tab="git">GitHub</button>
        <button type="button" class="settings-tab ${currentTab === "deploy" ? "active" : ""}" data-project-tab="deploy">Deploy</button>
        <button type="button" class="settings-tab ${currentTab === "ship" ? "active" : ""}" data-project-tab="ship">Ship it</button>
        <button type="button" class="settings-tab ${currentTab === "logs" ? "active" : ""}" data-project-tab="logs">Logs</button>
      </div>
      ${panel("git", renderProjectGitPanel(currentGitData))}
      ${panel("deploy", renderProjectDeployPanel(currentDeployData))}
      ${panel("ship", renderProjectShipPanel(currentShipData, lastShipResult))}
      ${panel("logs", renderProjectLogsPanel(currentLogsData))}
      <div class="modal-actions">
        <button id="project-tools-close" type="button" class="ghost">Close</button>
      </div>
    `;

    modal(
      renderModal(),
      (mount) => {
        const rerender = () => {
          mount.innerHTML = renderModal();
          bind();
        };

        const setFeedback = (selector, message, kind = "info") => {
          const node = mount.querySelector(selector);
          if (!node) return;
          node.hidden = !message;
          node.textContent = message ?? "";
          node.dataset.kind = kind;
        };

        const refreshGit = async () => {
          currentGitData = await loadProjectGitData();
          rerender();
        };

        const refreshDeploy = async () => {
          currentDeployData = await loadProjectDeployData();
          rerender();
          if (currentTab === "deploy" && isDeployActive(currentDeployData)) {
            startDeployTimer();
          } else {
            stopDeployTimer();
          }
        };

        const refreshShip = async () => {
          currentShipData = await loadProjectShipData();
          rerender();
        };

        const refreshLogs = async () => {
          currentLogsData = await loadProjectLogsData();
          rerender();
        };

        const stopLogsTimer = () => {
          if (logsTimer) {
            clearInterval(logsTimer);
            logsTimer = null;
          }
        };

        const startLogsTimer = () => {
          stopLogsTimer();
          logsTimer = setInterval(() => {
            if (!logsAutoRefresh || currentTab !== "logs") {
              stopLogsTimer();
              return;
            }
            void loadProjectLogsData().then((data) => {
              currentLogsData = data;
              // Preserve auto-refresh state across re-renders.
              rerender();
            });
          }, 8000);
        };

        const stopDeployTimer = () => {
          if (deployTimer) {
            clearInterval(deployTimer);
            deployTimer = null;
          }
        };

        const startDeployTimer = () => {
          stopDeployTimer();
          deployTimer = setInterval(() => {
            if (currentTab !== "deploy") {
              stopDeployTimer();
              return;
            }
            void loadProjectDeployData().then((data) => {
              currentDeployData = data;
              rerender();
              if (!isDeployActive(currentDeployData)) {
                stopDeployTimer();
              }
            });
          }, 10000);
        };

        const refreshAll = async () => {
          [currentGitData, currentDeployData, currentShipData] = await Promise.all([
            loadProjectGitData(),
            loadProjectDeployData(),
            loadProjectShipData(),
          ]);
          rerender();
          if (currentTab === "deploy" && isDeployActive(currentDeployData)) {
            startDeployTimer();
          } else {
            stopDeployTimer();
          }
        };

        const bind = () => {
          mount.querySelector("#project-tools-close")?.addEventListener("click", () => {
            stopLogsTimer();
            stopDeployTimer();
            closeModal();
          });
          mount.querySelectorAll("[data-project-tab]").forEach((button) => {
            button.addEventListener("click", () => {
              const nextTab = button.dataset.projectTab ?? "git";
              if (nextTab !== "logs") {
                stopLogsTimer();
              }
              if (nextTab !== "deploy") {
                stopDeployTimer();
              }
              currentTab = nextTab;
              rerender();
              if (currentTab === "logs" && !currentLogsData.available) {
                void refreshLogs();
              }
              if (currentTab === "deploy" && isDeployActive(currentDeployData)) {
                startDeployTimer();
              }
            });
          });

          mount.querySelectorAll("[data-project-repo]").forEach((button) => {
            button.addEventListener("click", () => {
              const repoInput = mount.querySelector("#project-git-repo");
              const branchInput = mount.querySelector("#project-git-branch");
              if (repoInput) repoInput.value = button.dataset.projectRepo ?? "";
              if (branchInput && !branchInput.value.trim()) {
                branchInput.value = button.dataset.projectBranch ?? "";
              }
            });
          });

          mount.querySelector("#project-git-refresh")?.addEventListener("click", () => {
            void refreshGit();
          });
          mount.querySelector("#project-git-clone")?.addEventListener("click", async () => {
            const slug = currentGitData.slug;
            if (!slug) return;
            const button = mount.querySelector("#project-git-clone");
            button.disabled = true;
            try {
              const repo = mount.querySelector("#project-git-repo")?.value.trim() ?? "";
              const branch = mount.querySelector("#project-git-branch")?.value.trim() ?? "";
              await fetchProjectJson(`/api/projects/${encodeURIComponent(slug)}/git/clone`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repo, branch }),
              });
              setFeedback("#project-git-feedback", `Cloned ${repo}.`);
              appendSystem(`Cloned ${repo} into ${state.whoami?.activeProjectName ?? slug}.`);
              await refreshWhoAmI().catch(() => {});
              await refreshAll();
            } catch (error) {
              setFeedback("#project-git-feedback", error.message, "error");
              appendSystem(`git clone failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });
          mount.querySelector("#project-git-commit")?.addEventListener("click", async () => {
            const slug = currentGitData.slug;
            if (!slug) return;
            const button = mount.querySelector("#project-git-commit");
            button.disabled = true;
            try {
              const message =
                mount.querySelector("#project-git-commit-message")?.value.trim() ?? "";
              const data = await fetchProjectJson(
                `/api/projects/${encodeURIComponent(slug)}/git/commit`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ message }),
                },
              );
              setFeedback(
                "#project-git-feedback",
                data.noChanges ? "Nothing to commit." : "Commit created.",
              );
              await refreshAll();
            } catch (error) {
              setFeedback("#project-git-feedback", error.message, "error");
              appendSystem(`git commit failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });
          mount.querySelector("#project-git-push")?.addEventListener("click", async () => {
            const slug = currentGitData.slug;
            if (!slug) return;
            const button = mount.querySelector("#project-git-push");
            button.disabled = true;
            try {
              await fetchProjectJson(`/api/projects/${encodeURIComponent(slug)}/git/push`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
              });
              setFeedback("#project-git-feedback", "Branch pushed.");
              await refreshAll();
            } catch (error) {
              setFeedback("#project-git-feedback", error.message, "error");
              appendSystem(`git push failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });
          mount.querySelector("#project-git-pr")?.addEventListener("click", async () => {
            const slug = currentGitData.slug;
            if (!slug) return;
            const button = mount.querySelector("#project-git-pr");
            button.disabled = true;
            try {
              const title =
                mount.querySelector("#project-git-pr-title")?.value.trim() ?? "";
              const body =
                mount.querySelector("#project-git-pr-body")?.value.trim() ?? "";
              const data = await fetchProjectJson(`/api/projects/${encodeURIComponent(slug)}/git/pr`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title, body }),
              });
              setFeedback(
                "#project-git-feedback",
                `PR #${data.pullRequest?.number ?? "?"} created.`,
              );
              if (data.pullRequest?.url) {
                window.open(data.pullRequest.url, "_blank", "noopener");
              }
            } catch (error) {
              setFeedback("#project-git-feedback", error.message, "error");
              appendSystem(`pull request failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });

          mount.querySelector("#github-oauth-signin")?.addEventListener("click", async () => {
            const button = mount.querySelector("#github-oauth-signin");
            button.disabled = true;
            try {
              const data = await fetchProjectJson("/api/oauth/github/start");
              if (!data.authorizeUrl) {
                throw new Error("GitHub OAuth is not configured on this server.");
              }
              const popup = window.open(
                data.authorizeUrl,
                "codex-github-oauth",
                "width=640,height=760,noopener=no,noreferrer=no",
              );
              if (!popup) {
                throw new Error("Popup blocked — allow popups for this site and retry.");
              }
              setFeedback(
                "#project-git-feedback",
                "Complete the GitHub authorization in the popup…",
              );
              await new Promise((resolve, reject) => {
                let settled = false;
                const onMessage = (event) => {
                  if (event.origin !== window.location.origin) return;
                  const payload = event?.data;
                  if (!payload || typeof payload !== "object") return;
                  if (payload.type === "codex:github-connected") {
                    settled = true;
                    window.removeEventListener("message", onMessage);
                    clearInterval(watcher);
                    resolve();
                  } else if (payload.type === "codex:github-oauth-error") {
                    settled = true;
                    window.removeEventListener("message", onMessage);
                    clearInterval(watcher);
                    reject(new Error(payload.message ?? "GitHub sign-in failed."));
                  }
                };
                window.addEventListener("message", onMessage);
                const watcher = setInterval(() => {
                  if (settled) return;
                  if (popup.closed) {
                    settled = true;
                    window.removeEventListener("message", onMessage);
                    clearInterval(watcher);
                    reject(new Error("GitHub sign-in window was closed."));
                  }
                }, 800);
              });
              setFeedback("#project-git-feedback", "GitHub account connected.");
              showToast("Signed in with GitHub.", "success");
              await refreshAll();
            } catch (error) {
              setFeedback("#project-git-feedback", error.message, "error");
              appendSystem(`github sign-in failed: ${error.message}`, "error");
            } finally {
              if (button && !button.isConnected) return;
              if (button) button.disabled = false;
            }
          });
          mount.querySelector("#github-oauth-logout")?.addEventListener("click", async () => {
            const button = mount.querySelector("#github-oauth-logout");
            button.disabled = true;
            try {
              await fetchProjectJson("/api/oauth/github/logout", { method: "POST" });
              setFeedback("#project-git-feedback", "GitHub account disconnected.");
              showToast("GitHub account disconnected.", "success");
              await refreshAll();
            } catch (error) {
              setFeedback("#project-git-feedback", error.message, "error");
              appendSystem(`github disconnect failed: ${error.message}`, "error");
            } finally {
              if (button && !button.isConnected) return;
              if (button) button.disabled = false;
            }
          });

          mount.querySelector("#render-hook-refresh")?.addEventListener("click", () => {
            void refreshDeploy();
          });
          mount.querySelector("#render-hook-save")?.addEventListener("click", async () => {
            const slug = currentDeployData.slug;
            if (!slug) return;
            const button = mount.querySelector("#render-hook-save");
            button.disabled = true;
            try {
              const syncHookUrl =
                mount.querySelector("#render-hook-url")?.value.trim() ?? "";
              await fetchProjectJson(
                `/api/projects/${encodeURIComponent(slug)}/deploy/render/config`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ syncHookUrl }),
                },
              );
              setFeedback("#project-deploy-feedback", syncHookUrl ? "Render hook saved." : "Render hook cleared.");
              await refreshDeploy();
            } catch (error) {
              setFeedback("#project-deploy-feedback", error.message, "error");
              appendSystem(`render hook save failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });
          mount.querySelector("#render-hook-trigger")?.addEventListener("click", async () => {
            const slug = currentDeployData.slug;
            if (!slug) return;
            const button = mount.querySelector("#render-hook-trigger");
            button.disabled = true;
            try {
              const data = await fetchProjectJson(
                `/api/projects/${encodeURIComponent(slug)}/deploy/render/trigger`,
                { method: "POST" },
              );
              setFeedback("#project-deploy-feedback", data.deploy?.responseText ?? "Render deploy triggered.");
              showToast("Render sync hook triggered.", "success");
              await refreshDeploy();
            } catch (error) {
              setFeedback("#project-deploy-feedback", error.message, "error");
              appendSystem(`render deploy failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });

          mount.querySelector("#vercel-refresh")?.addEventListener("click", () => {
            void refreshDeploy();
          });
          mount.querySelector("#vercel-save")?.addEventListener("click", async () => {
            const slug = currentDeployData.slug;
            if (!slug) return;
            const button = mount.querySelector("#vercel-save");
            button.disabled = true;
            try {
              const payload = {
                deployHookUrl:
                  mount.querySelector("#vercel-hook-url")?.value.trim() ?? "",
              };
              const tokenInput = mount.querySelector("#vercel-token");
              if (tokenInput && tokenInput.value !== "") {
                payload.token = tokenInput.value;
              }
              const projectIdInput = mount.querySelector("#vercel-project-id");
              if (projectIdInput && projectIdInput.value !== "") {
                payload.projectId = projectIdInput.value;
              }
              const teamIdInput = mount.querySelector("#vercel-team-id");
              if (teamIdInput && teamIdInput.value !== "") {
                payload.teamId = teamIdInput.value;
              }
              await fetchProjectJson(
                `/api/projects/${encodeURIComponent(slug)}/deploy/vercel/config`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                },
              );
              setFeedback("#project-deploy-feedback", "Vercel config saved.");
              await refreshDeploy();
            } catch (error) {
              setFeedback("#project-deploy-feedback", error.message, "error");
              appendSystem(`vercel config save failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });
          mount.querySelector("#vercel-trigger")?.addEventListener("click", async () => {
            const slug = currentDeployData.slug;
            if (!slug) return;
            const button = mount.querySelector("#vercel-trigger");
            button.disabled = true;
            try {
              const data = await fetchProjectJson(
                `/api/projects/${encodeURIComponent(slug)}/deploy/vercel/trigger`,
                { method: "POST" },
              );
              setFeedback(
                "#project-deploy-feedback",
                data.deploy?.responseText ?? "Vercel deploy triggered.",
              );
              showToast("Vercel deploy hook triggered.", "success");
              await refreshDeploy();
            } catch (error) {
              setFeedback("#project-deploy-feedback", error.message, "error");
              appendSystem(`vercel deploy failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });

          mount.querySelector("#netlify-refresh")?.addEventListener("click", () => {
            void refreshDeploy();
          });
          mount.querySelector("#netlify-save")?.addEventListener("click", async () => {
            const slug = currentDeployData.slug;
            if (!slug) return;
            const button = mount.querySelector("#netlify-save");
            button.disabled = true;
            try {
              const payload = {
                buildHookUrl:
                  mount.querySelector("#netlify-hook-url")?.value.trim() ?? "",
              };
              const tokenInput = mount.querySelector("#netlify-token");
              if (tokenInput && tokenInput.value !== "") {
                payload.token = tokenInput.value;
              }
              const siteIdInput = mount.querySelector("#netlify-site-id");
              if (siteIdInput && siteIdInput.value !== "") {
                payload.siteId = siteIdInput.value;
              }
              await fetchProjectJson(
                `/api/projects/${encodeURIComponent(slug)}/deploy/netlify/config`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                },
              );
              setFeedback("#project-deploy-feedback", "Netlify config saved.");
              await refreshDeploy();
            } catch (error) {
              setFeedback("#project-deploy-feedback", error.message, "error");
              appendSystem(`netlify config save failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });
          mount.querySelector("#netlify-trigger")?.addEventListener("click", async () => {
            const slug = currentDeployData.slug;
            if (!slug) return;
            const button = mount.querySelector("#netlify-trigger");
            button.disabled = true;
            try {
              const data = await fetchProjectJson(
                `/api/projects/${encodeURIComponent(slug)}/deploy/netlify/trigger`,
                { method: "POST" },
              );
              setFeedback(
                "#project-deploy-feedback",
                data.deploy?.responseText ?? "Netlify deploy triggered.",
              );
              showToast("Netlify build hook triggered.", "success");
              await refreshDeploy();
            } catch (error) {
              setFeedback("#project-deploy-feedback", error.message, "error");
              appendSystem(`netlify deploy failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });

          mount.querySelector("#cf-refresh")?.addEventListener("click", () => {
            void refreshDeploy();
          });
          mount.querySelector("#cf-save")?.addEventListener("click", async () => {
            const slug = currentDeployData.slug;
            if (!slug) return;
            const button = mount.querySelector("#cf-save");
            button.disabled = true;
            try {
              const payload = {
                deployHookUrl:
                  mount.querySelector("#cf-hook-url")?.value.trim() ?? "",
              };
              const tokenInput = mount.querySelector("#cf-token");
              if (tokenInput && tokenInput.value !== "") {
                payload.token = tokenInput.value;
              }
              const accountIdInput = mount.querySelector("#cf-account-id");
              if (accountIdInput && accountIdInput.value !== "") {
                payload.accountId = accountIdInput.value;
              }
              const projectNameInput = mount.querySelector("#cf-project-name");
              if (projectNameInput && projectNameInput.value !== "") {
                payload.projectName = projectNameInput.value;
              }
              await fetchProjectJson(
                `/api/projects/${encodeURIComponent(slug)}/deploy/cloudflare/config`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                },
              );
              setFeedback("#project-deploy-feedback", "Cloudflare config saved.");
              await refreshDeploy();
            } catch (error) {
              setFeedback("#project-deploy-feedback", error.message, "error");
              appendSystem(`cloudflare config save failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });
          mount.querySelector("#cf-trigger")?.addEventListener("click", async () => {
            const slug = currentDeployData.slug;
            if (!slug) return;
            const button = mount.querySelector("#cf-trigger");
            button.disabled = true;
            try {
              const data = await fetchProjectJson(
                `/api/projects/${encodeURIComponent(slug)}/deploy/cloudflare/trigger`,
                { method: "POST" },
              );
              setFeedback(
                "#project-deploy-feedback",
                data.deploy?.responseText ?? "Cloudflare deploy triggered.",
              );
              showToast("Cloudflare deploy hook triggered.", "success");
              await refreshDeploy();
            } catch (error) {
              setFeedback("#project-deploy-feedback", error.message, "error");
              appendSystem(`cloudflare deploy failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });

          mount.querySelector("#ship-refresh")?.addEventListener("click", () => {
            void refreshShip();
          });
          mount.querySelector("#ship-run")?.addEventListener("click", async () => {
            const slug = currentShipData.slug;
            if (!slug) return;
            const button = mount.querySelector("#ship-run");
            button.disabled = true;
            try {
              lastShipResult = await fetchProjectJson(`/api/projects/${encodeURIComponent(slug)}/ship`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  testsCommand:
                    mount.querySelector("#ship-tests-command")?.value.trim() ?? "",
                  buildCommand:
                    mount.querySelector("#ship-build-command")?.value.trim() ?? "",
                  commitMessage:
                    mount.querySelector("#ship-commit-message")?.value.trim() ?? "",
                  deployAfter:
                    mount.querySelector("#ship-deploy-after")?.checked ?? false,
                  createTag:
                    mount.querySelector("#ship-create-tag")?.checked ?? false,
                  tagName:
                    mount.querySelector("#ship-tag-name")?.value.trim() ?? "",
                  generateChangelog:
                    mount.querySelector("#ship-generate-changelog")?.checked ?? false,
                }),
              });
              setFeedback(
                "#project-ship-feedback",
                lastShipResult.ok ? "Ship it completed." : "Ship it stopped on a failing step.",
                lastShipResult.ok ? "info" : "error",
              );
              showToast(
                lastShipResult.ok ? "Ship it completed." : "Ship it stopped on a failing step.",
                lastShipResult.ok ? "success" : "warn",
              );
              await refreshWhoAmI().catch(() => {});
              await refreshAll();
            } catch (error) {
              setFeedback("#project-ship-feedback", error.message, "error");
              appendSystem(`ship it failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });

          mount.querySelector("#logs-refresh")?.addEventListener("click", () => {
            void refreshLogs();
          });
          const autoRefreshInput = mount.querySelector("#logs-autorefresh");
          if (autoRefreshInput) {
            autoRefreshInput.checked = logsAutoRefresh;
            autoRefreshInput.addEventListener("change", () => {
              logsAutoRefresh = autoRefreshInput.checked;
              if (logsAutoRefresh) {
                startLogsTimer();
                void refreshLogs();
              } else {
                stopLogsTimer();
              }
            });
          }
        };

        bind();
        void refreshAll();
        if (currentTab === "logs") {
          void refreshLogs();
        }
      },
      { className: "modal-wide" },
    );
  }

  function renderMemoryItems(items) {
    if (!items?.length) {
      return `<div class="manager-empty">No AGENTS.md or CLAUDE.md files were discovered for this session.</div>`;
    }
    return items
      .map(
        (item, index) => `
        <article class="manager-card" data-memory-index="${index}">
          <div class="manager-card-head">
            <div>
              <h3>${escapeHtml(item.fileName ?? "memory file")}</h3>
              <div class="manager-meta">${escapeHtml(item.scope ?? "memory")} · ${escapeHtml(item.path ?? "")}</div>
            </div>
            <button type="button" class="ghost" data-action="preview-memory" data-memory-index="${index}">Preview</button>
          </div>
          ${
            item.preview
              ? `<div class="manager-blurb">${escapeHtml(item.preview)}</div>`
              : '<div class="manager-blurb muted">Empty file</div>'
          }
        </article>
      `,
      )
      .join("");
  }

  function renderProjectSecrets(secretsData) {
    if (!secretsData.available) {
      return '<div class="manager-empty">Activate a named project from the sidebar to manage project secrets.</div>';
    }
    if (secretsData.error) {
      return `<div class="manager-empty">Secrets failed to load: ${escapeHtml(secretsData.error)}</div>`;
    }
    if (!secretsData.keys?.length) {
      return '<div class="manager-empty">No secrets stored for this project yet.</div>';
    }
    return secretsData.keys
      .map(
        (key) => `
        <article class="manager-card">
          <div class="manager-card-head">
            <div>
              <h3>${escapeHtml(key)}</h3>
              <div class="manager-meta">Stored for ${escapeHtml(state.whoami?.activeProjectName ?? secretsData.slug ?? "project")}</div>
            </div>
            <button type="button" class="ghost" data-action="delete-secret" data-secret-key="${escapeHtml(key)}">Delete</button>
          </div>
          <div class="manager-blurb">Values stay encrypted at rest and are only injected into the backend environment when this project workspace is active.</div>
        </article>
      `,
      )
      .join("");
  }

  function renderHookRows(rows) {
    return rows
      .map(
        (row) => `
        <div class="hook-row" data-hook-row-id="${escapeHtml(row.id)}">
          <div class="hook-row-top">
            <label class="hook-toggle">
              <input type="checkbox" data-hook-field="enabled" ${row.enabled ? "checked" : ""} />
              <span>Enabled</span>
            </label>
            <button type="button" class="ghost" data-action="remove-hook" data-hook-row-id="${escapeHtml(row.id)}">Remove</button>
          </div>
          <div class="hook-grid">
            <div class="modal-row">
              <label>Event</label>
              <select data-hook-field="eventName">
                ${hookEvents
                  .map(
                    (eventName) =>
                      `<option value="${eventName}" ${row.eventName === eventName ? "selected" : ""}>${eventName}</option>`,
                  )
                  .join("")}
              </select>
            </div>
            <div class="modal-row">
              <label>Matcher regex</label>
              <input data-hook-field="matcher" value="${escapeHtml(row.matcher)}" placeholder="*, ^Bash$, Edit|Write" />
            </div>
            <div class="modal-row">
              <label>Status message</label>
              <input data-hook-field="statusMessage" value="${escapeHtml(row.statusMessage)}" placeholder="running pre tool use hook" />
            </div>
            <div class="modal-row">
              <label>Timeout (seconds)</label>
              <input data-hook-field="timeoutSec" value="${escapeHtml(row.timeoutSec)}" type="number" min="1" step="1" placeholder="600" />
            </div>
          </div>
          <div class="modal-row">
            <label>Command</label>
            <textarea data-hook-field="command" rows="2" placeholder="python3 /path/to/check.py">${escapeHtml(row.command)}</textarea>
          </div>
        </div>
      `,
      )
      .join("");
  }

  function collectHookRows(mount) {
    return [...mount.querySelectorAll(".hook-row")].map((row) => ({
      id: row.dataset.hookRowId,
      enabled: row.querySelector('[data-hook-field="enabled"]')?.checked ?? false,
      eventName:
        row.querySelector('[data-hook-field="eventName"]')?.value ?? "PreToolUse",
      matcher: row.querySelector('[data-hook-field="matcher"]')?.value ?? "",
      statusMessage:
        row.querySelector('[data-hook-field="statusMessage"]')?.value ?? "",
      timeoutSec: row.querySelector('[data-hook-field="timeoutSec"]')?.value ?? "",
      command: row.querySelector('[data-hook-field="command"]')?.value ?? "",
    }));
  }

  function currentThreadMemoryMode() {
    if (!state.activeThreadId) return "enabled";
    return threadMemoryModes[state.activeThreadId] ?? "enabled";
  }

  function persistThreadMemoryMode(mode) {
    if (!state.activeThreadId) return;
    threadMemoryModes[state.activeThreadId] = mode;
    save("threadMemoryModes", threadMemoryModes);
  }

  function openUserInputModal(message) {
    const questions = message.params?.questions ?? [];
    modal(
      `
      <h2>Tool needs more input</h2>
      <p>Answer the questions below to continue this tool call.</p>
      <form id="tool-user-input-form">
        ${questions
          .map((question) => {
            const choiceButtons = (question.options ?? [])
              .map(
                (option) => `
            <button type="button" class="choice-chip" data-choice-for="${escapeHtml(question.id)}" data-choice-value="${escapeHtml(option.label ?? option.value ?? "")}">
              ${escapeHtml(option.label ?? option.value ?? "")}
            </button>
          `,
              )
              .join("");
            return `
            <div class="modal-row">
              <label>${escapeHtml(question.question ?? question.header ?? question.id ?? "Question")}</label>
              ${choiceButtons ? `<div class="choice-row">${choiceButtons}</div>` : ""}
              <input name="${escapeHtml(question.id)}" value="" ${question.isSecret ? 'type="password"' : ""} />
            </div>
          `;
          })
          .join("")}
      </form>
      <div class="modal-actions">
        <button id="cancel" class="ghost">Cancel</button>
        <button id="submit" class="primary">Submit</button>
      </div>
    `,
      (mount) => {
        mount.querySelectorAll("[data-choice-for]").forEach((button) => {
          button.addEventListener("click", () => {
            const input = mount.querySelector(
              `[name="${CSS.escape(button.dataset.choiceFor)}"]`,
            );
            if (input) input.value = button.dataset.choiceValue ?? "";
          });
        });
        mount.querySelector("#cancel").addEventListener("click", () => {
          closeModal();
          rpcReply(message.id, { answers: {} });
        });
        mount.querySelector("#submit").addEventListener("click", () => {
          const answers = Object.fromEntries(
            questions.map((question) => {
              const value =
                mount.querySelector(`[name="${CSS.escape(question.id)}"]`)
                  ?.value ?? "";
              return [question.id, { answers: value ? [value] : [] }];
            }),
          );
          closeModal();
          rpcReply(message.id, { answers });
        });
      },
    );
  }

  function openElicitationModal(message) {
    const params = message.params ?? {};
    if (params.mode === "url") {
      modal(
        `
        <h2>MCP server needs confirmation</h2>
        <p>${escapeHtml(params.message ?? "Open the linked page and continue when ready.")}</p>
        <div class="modal-actions">
          <a href="${escapeHtml(params.url)}" target="_blank" rel="noopener"><button class="primary">Open URL</button></a>
          <button id="accept">Continue</button>
          <button id="decline" class="ghost">Decline</button>
        </div>
      `,
        (mount) => {
          mount.querySelector("#accept").addEventListener("click", () => {
            closeModal();
            rpcReply(message.id, {
              action: "accept",
              content: null,
              _meta: params._meta ?? null,
            });
          });
          mount.querySelector("#decline").addEventListener("click", () => {
            closeModal();
            rpcReply(message.id, {
              action: "decline",
              content: null,
              _meta: params._meta ?? null,
            });
          });
        },
      );
      return;
    }
    const properties = params.requestedSchema?.properties ?? {};
    modal(
      `
      <h2>MCP server needs input</h2>
      <p>${escapeHtml(params.message ?? "Provide the requested values.")}</p>
      <form id="elicitation-form">
        ${Object.entries(properties)
          .map(
            ([key, value]) => `
          <div class="modal-row">
            <label>${escapeHtml(value.title ?? key)}</label>
            <input name="${escapeHtml(key)}" value="" />
          </div>
        `,
          )
          .join("")}
      </form>
      <div class="modal-actions">
        <button id="cancel" class="ghost">Cancel</button>
        <button id="submit" class="primary">Submit</button>
      </div>
    `,
      (mount) => {
        mount.querySelector("#cancel").addEventListener("click", () => {
          closeModal();
          rpcReply(message.id, {
            action: "cancel",
            content: null,
            _meta: params._meta ?? null,
          });
        });
        mount.querySelector("#submit").addEventListener("click", () => {
          const content = Object.fromEntries(
            Object.keys(properties).map((key) => [
              key,
              mount.querySelector(`[name="${CSS.escape(key)}"]`)?.value ?? "",
            ]),
          );
          closeModal();
          rpcReply(message.id, {
            action: "accept",
            content,
            _meta: params._meta ?? null,
          });
        });
      },
    );
  }

  function openPermissionsModal(message) {
    const permissions = message.params?.permissions ?? {};
    modal(
      `
      <h2>Additional permissions requested</h2>
      <p>${escapeHtml(message.params?.reason ?? "The backend needs broader permissions to continue.")}</p>
      <pre>${escapeHtml(JSON.stringify(permissions, null, 2))}</pre>
      <div class="modal-actions">
        <button id="cancel" class="ghost">Decline</button>
        <button id="session">Grant for session</button>
        <button id="allow" class="primary">Grant once</button>
      </div>
    `,
      (mount) => {
        mount.querySelector("#cancel").addEventListener("click", () => {
          closeModal();
          rpcRaw({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32002, message: "permission request declined" },
          });
        });
        mount.querySelector("#session").addEventListener("click", () => {
          closeModal();
          rpcReply(message.id, { permissions, scope: "session" });
        });
        mount.querySelector("#allow").addEventListener("click", () => {
          closeModal();
          rpcReply(message.id, { permissions, scope: "turn" });
        });
      },
    );
  }

  function openLogin() {
    modal(
      `
      <h2>Sign in to Codex</h2>
      <p>Choose a sign-in method. On localhost, ChatGPT opens a browser callback. On public deployments, you’ll get a device code. Credentials stay tied to your session cookie.</p>
      <div class="modal-row">
        <button id="chatgpt" class="primary" style="width:100%">Sign in with ChatGPT</button>
      </div>
      <div class="modal-row modal-divider">— or —</div>
      <div class="modal-row"><label>OpenAI API key</label><input id="apikey" type="password" placeholder="sk-…" autofocus /></div>
      <div class="modal-actions">
        <button id="cancel" class="ghost">Cancel</button>
        <button id="save" class="primary">Use API key</button>
      </div>
      <div id="oauth-status" class="muted modal-status"></div>
    `,
      (mount) => {
        mount.querySelector("#cancel").addEventListener("click", closeModal);
        mount.querySelector("#chatgpt").addEventListener("click", async () => {
          const status = mount.querySelector("#oauth-status");
          status.textContent = "Starting ChatGPT sign-in…";
          try {
            if (isLocalBrowserFlowSupported()) {
              const result = await rpcCall("account/login/start", {
                type: "chatgpt",
              });
              if (result?.type !== "chatgpt" || !result.authUrl) {
                throw new Error("browser auth URL was not returned");
              }
              state.whoami = {
                ...(state.whoami ?? {}),
                oauthPending: true,
                oauthError: null,
              };
              status.innerHTML = `Open <a href="${escapeHtml(result.authUrl)}" target="_blank" rel="noopener">${escapeHtml(result.authUrl)}</a> and finish sign-in in the new tab.`;
              window.open(result.authUrl, "_blank", "noopener,noreferrer");
              const onSignedIn = async () => {
                window.removeEventListener("codex:signedIn", onSignedIn);
                clearAuthRequiredCard();
                closeModal();
                await refreshAccount().catch(() => {});
                await refreshModels().catch(() => {});
              };
              window.addEventListener("codex:signedIn", onSignedIn, {
                once: true,
              });
              return;
            }

            const response = await fetch("/api/oauth/chatgpt/start", {
              method: "POST",
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok)
              throw new Error(
                data.error ?? `start failed (${response.status})`,
              );
            const verificationUrl = data?.verificationUrl;
            const userCode = data?.userCode;
            if (userCode) {
              const safeUrl = escapeHtml(verificationUrl);
              const safeCode = escapeHtml(userCode);
              status.innerHTML = `
                <div class="device-code-flow">
                  <div class="device-code-steps">
                    <div>1. A new tab just opened at <a href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a></div>
                    <div>2. Paste this code and click <strong>Continue</strong>:</div>
                  </div>
                  <div class="device-code-row">
                    <code class="device-code-value" id="device-code-value">${safeCode}</code>
                    <button type="button" class="ghost" id="device-code-copy">Copy</button>
                  </div>
                  <div class="device-code-steps">
                    <div>3. Approve the sign-in on ChatGPT.</div>
                    <div>4. Come back here — you'll be signed in automatically.</div>
                  </div>
                  <div id="device-code-hint" class="muted modal-status">Waiting for you to approve in the other tab…</div>
                </div>
              `;
              const openedTab = window.open(
                verificationUrl,
                "_blank",
                "noopener,noreferrer",
              );
              const hintEl = mount.querySelector("#device-code-hint");
              const copyCodeToClipboard = async (showToast = false) => {
                try {
                  await navigator.clipboard.writeText(userCode);
                  if (showToast && hintEl) {
                    hintEl.textContent = "Code copied. Paste it in the new tab to continue.";
                  }
                  return true;
                } catch {
                  return false;
                }
              };
              void copyCodeToClipboard(false);
              if (!openedTab && hintEl) {
                hintEl.textContent =
                  "Your browser blocked the popup — click the link above to open the sign-in page manually.";
              }
              const copyBtn = mount.querySelector("#device-code-copy");
              copyBtn?.addEventListener("click", async () => {
                const ok = await copyCodeToClipboard(true);
                copyBtn.textContent = ok ? "Copied" : "Copy failed";
                setTimeout(() => {
                  copyBtn.textContent = "Copy";
                }, 1500);
              });
            } else {
              status.innerHTML = `Open <a href="${escapeHtml(verificationUrl)}" target="_blank" rel="noopener">${escapeHtml(verificationUrl)}</a> to continue.`;
              window.open(verificationUrl, "_blank", "noopener,noreferrer");
            }
            const startedAt = Date.now();
            const poll = async () => {
              await refreshWhoAmI();
              if (state.whoami?.hasOauth) {
                clearAuthRequiredCard();
                closeModal();
                await refreshAccount().catch(() => {});
                await refreshModels().catch(() => {});
                appendSystem("Signed in with ChatGPT.");
                return;
              }
              if (state.whoami?.oauthError) {
                status.textContent = `OAuth failed: ${state.whoami.oauthError}`;
                return;
              }
              if (Date.now() - startedAt > 16 * 60 * 1000) {
                status.textContent =
                  "Sign-in timed out. Start again if you still need ChatGPT auth.";
                return;
              }
              setTimeout(poll, 2000);
            };
            setTimeout(poll, 1500);
          } catch (error) {
            status.textContent = `OAuth failed: ${error.message}`;
          }
        });
        mount.querySelector("#save").addEventListener("click", async () => {
          const apiKey = mount.querySelector("#apikey").value.trim();
          if (!apiKey) return;
          const response = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ apiKey }),
          });
          if (response.ok) {
            await refreshWhoAmI();
            await refreshAccount().catch(() => {});
            await refreshModels().catch(() => {});
            updateStatusBar();
            clearAuthRequiredCard();
            appendSystem("Signed in with API key.");
            closeModal();
          } else {
            const data = await response.json().catch(() => ({}));
            appendSystem(
              `Login failed: ${data.error ?? response.status}`,
              "error",
            );
          }
        });
      },
    );
  }

  async function openMcpModal() {
    modal(
      `
      <h2>MCP servers</h2>
      <p>Servers configured via <code>~/.codex/config.toml</code> and added here for this session.</p>
      <div id="mcp-list"><div class="muted">Loading…</div></div>
      <div class="modal-row modal-section">
        <label>Add a new server</label>
        <input id="mcp-name" placeholder="server name" />
        <input id="mcp-cmd" placeholder="command (for example: npx -y @modelcontextprotocol/server-filesystem /tmp)" style="margin-top:6px" />
      </div>
      <div class="modal-actions">
        <button id="add" class="primary">Add</button>
        <button id="reload">Reload</button>
        <button id="close" class="ghost">Close</button>
      </div>
    `,
      async (mount) => {
        const refresh = async () => {
          try {
            const result = await rpcCall("mcpServerStatus/list", {});
            const list = mount.querySelector("#mcp-list");
            const servers = result?.data ?? result?.servers ?? [];
            if (servers.length === 0) {
              list.innerHTML = `<div class="muted">No MCP servers configured. Add one below.</div>`;
            } else {
              list.innerHTML = servers
                .map((server) => {
                  const startup =
                    server._startupState ?? server.startupState ?? "ready";
                  const enabled = server._enabled !== false;
                  const okay =
                    enabled &&
                    (startup === "ready" ||
                      startup === "running" ||
                      startup === "connected");
                  const tools =
                    server.tools && typeof server.tools === "object"
                      ? Array.isArray(server.tools)
                        ? server.tools.map((tool) => tool?.name ?? tool)
                        : Object.keys(server.tools)
                      : [];
                  const command = server._command
                    ? `${server._command}${(server._args ?? []).length ? ` ${server._args.join(" ")}` : ""}`
                    : "";
                  return `
                <div class="tool-card" data-server="${escapeHtml(server.name)}" style="margin-bottom:8px">
                  <div class="tc-head">
                    <span class="status-dot ${okay ? "completed" : enabled ? "failed" : "inProgress"}"></span>
                    <strong>${escapeHtml(server.name)}</strong>
                    <span class="muted">${escapeHtml(enabled ? startup : "disabled")}</span>
                    <span class="mcp-row-actions">
                      <button class="ghost" data-action="toggle" data-enabled="${enabled ? "1" : "0"}">${enabled ? "Disable" : "Enable"}</button>
                      <button class="ghost" data-action="remove">Remove</button>
                    </span>
                  </div>
                  ${command ? `<div class="tc-meta"><code>${escapeHtml(command)}</code></div>` : ""}
                  ${tools.length ? `<div class="tc-meta">tools: ${escapeHtml(tools.join(", "))}</div>` : ""}
                </div>
              `;
                })
                .join("");
            }
          } catch (error) {
            mount.querySelector("#mcp-list").innerHTML =
              `<div class="muted">Error: ${escapeHtml(error.message)}</div>`;
          }
        };
        mount
          .querySelector("#mcp-list")
          .addEventListener("click", async (event) => {
            const button = event.target.closest("button[data-action]");
            if (!button) return;
            const card = button.closest("[data-server]");
            const name = card?.dataset?.server;
            if (!name) return;
            const action = button.dataset.action;
            button.disabled = true;
            try {
              if (action === "toggle") {
                const wasEnabled = button.dataset.enabled === "1";
                await rpcCall("config/value/write", {
                  keyPath: `mcp_servers.${name}.enabled`,
                  value: !wasEnabled,
                  mergeStrategy: "upsert",
                });
              } else if (action === "remove") {
                if (!confirm(`Remove MCP server "${name}"?`)) {
                  button.disabled = false;
                  return;
                }
                await rpcCall("config/value/write", {
                  keyPath: `mcp_servers.${name}`,
                  value: null,
                  mergeStrategy: "replace",
                });
              }
              await rpcCall("config/mcpServer/reload", {}).catch(() => {});
            } finally {
              await refresh();
            }
          });

        mount.querySelector("#close").addEventListener("click", () => {
          window.__mcpRefresh = null;
          closeModal();
        });
        mount.querySelector("#reload").addEventListener("click", async () => {
          await rpcCall("config/mcpServer/reload", {}).catch(() => {});
          await refresh();
        });
        mount.querySelector("#add").addEventListener("click", async () => {
          const name = mount.querySelector("#mcp-name").value.trim();
          const command = mount.querySelector("#mcp-cmd").value.trim();
          if (!name || !command) {
            mount
              .querySelector("#mcp-list")
              .insertAdjacentHTML(
                "afterbegin",
                `<div class="muted" style="color:var(--danger);margin-bottom:6px">Name and command are required.</div>`,
              );
            return;
          }
          const parts = command.split(/\s+/);
          await rpcCall("config/value/write", {
            keyPath: `mcp_servers.${name}`,
            value: { command: parts[0], args: parts.slice(1), enabled: true },
            mergeStrategy: "upsert",
          }).catch((error) => {
            console.error("add mcp failed", error);
          });
          await rpcCall("config/mcpServer/reload", {}).catch(() => {});
          mount.querySelector("#mcp-name").value = "";
          mount.querySelector("#mcp-cmd").value = "";
          await refresh();
        });
        window.__mcpRefresh = refresh;
        await refresh();
      },
    );
  }

  async function openSkillsModal() {
    modal(
      `
      <h2>Skills</h2>
      <p>Live skills discovered for the current workspace. Toggle any skill here and the backend will hot-reload it for future turns.</p>
      <div class="modal-actions modal-actions-left">
        <button id="reload-skills" type="button">Reload</button>
        <button id="close" class="ghost" type="button">Close</button>
      </div>
      <div id="skills-list"><div class="muted">Loading…</div></div>
    `,
      async (mount) => {
        let currentSkills = [];
        const refresh = async () => {
          try {
            const result = await rpcCall("skills/list", {
              cwds: state.whoami?.workdir ? [state.whoami.workdir] : null,
              forceReload: true,
            });
            const entries = result?.data ?? [];
            currentSkills = entries.flatMap((entry) =>
              (entry.skills ?? []).map((skill) => ({
                ...skill,
                cwd: entry.cwd,
              })),
            );
            const errors = entries.flatMap((entry) =>
              (entry.errors ?? []).map((error) => ({
                ...error,
                cwd: entry.cwd,
              })),
            );
            const list = mount.querySelector("#skills-list");
            if (!currentSkills.length && !errors.length) {
              list.innerHTML =
                '<div class="manager-empty">No skills were discovered for this workspace.</div>';
              return;
            }
            list.innerHTML = `
              ${
                errors.length
                  ? `<div class="manager-note">${errors
                      .map(
                        (error) =>
                          `${escapeHtml(error.cwd ?? "workspace")}: ${escapeHtml(error.message ?? "skill load error")}`,
                      )
                      .join("<br />")}</div>`
                  : ""
              }
              ${currentSkills
                .map(
                  (skill, index) => `
                <article class="manager-card">
                  <div class="manager-card-head">
                    <div>
                      <h3>${escapeHtml(skill.interface?.displayName ?? skill.name)}</h3>
                      <div class="manager-meta">${escapeHtml(skill.scope ?? "skill")} · ${escapeHtml(skill.cwd ?? "")}</div>
                    </div>
                    <button
                      type="button"
                      class="${skill.enabled ? "" : "primary"}"
                      data-action="toggle-skill"
                      data-skill-index="${index}"
                    >
                      ${skill.enabled ? "Disable" : "Enable"}
                    </button>
                  </div>
                  <div class="manager-blurb">${escapeHtml(skill.interface?.shortDescription ?? skill.description ?? "No description")}</div>
                  <div class="manager-meta">${escapeHtml(skill.path ?? "")}</div>
                  ${
                    skill.dependencies?.tools?.length
                      ? `<div class="manager-tags">${skill.dependencies.tools
                          .map(
                            (dependency) =>
                              `<span class="manager-tag">${escapeHtml(`${dependency.type}:${dependency.value}`)}</span>`,
                          )
                          .join("")}</div>`
                      : ""
                  }
                </article>
              `,
                )
                .join("")}
            `;
          } catch (error) {
            mount.querySelector("#skills-list").innerHTML = `
              <div class="manager-empty">Skills failed to load: ${escapeHtml(error.message)}</div>
            `;
          }
        };

        mount
          .querySelector("#skills-list")
          .addEventListener("click", async (event) => {
            const button = event.target.closest("[data-action='toggle-skill']");
            if (!button) return;
            const skill = currentSkills[Number(button.dataset.skillIndex)];
            if (!skill) return;
            button.disabled = true;
            try {
              await rpcCall("skills/config/write", {
                path: skill.path ?? null,
                name: skill.path ? null : skill.name ?? null,
                enabled: !skill.enabled,
              });
              await refresh();
            } catch (error) {
              appendSystem(`skill update failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });

        mount
          .querySelector("#reload-skills")
          .addEventListener("click", () => void refresh());
        mount.querySelector("#close").addEventListener("click", () => {
          window.__skillsRefresh = null;
          closeModal();
        });
        window.__skillsRefresh = refresh;
        await refresh();
      },
      { className: "modal-wide" },
    );
  }

  async function openPluginsModal() {
    modal(
      `
      <h2>Plugins</h2>
      <p>Browse the configured plugin marketplaces for this workspace, add a marketplace, and install or uninstall plugins directly.</p>
      <div class="modal-row modal-section">
        <label>Add marketplace</label>
        <input id="marketplace-source" placeholder="owner/repo, git URL, or SSH URL" />
      </div>
      <div class="modal-actions modal-actions-left">
        <button id="add-marketplace" class="primary" type="button">Add marketplace</button>
        <button id="reload-plugins" type="button">Reload</button>
        <button id="close" class="ghost" type="button">Close</button>
      </div>
      <div id="plugins-list"><div class="muted">Loading…</div></div>
    `,
      async (mount) => {
        let currentPlugins = [];
        const refresh = async () => {
          try {
            const result = await rpcCall("plugin/list", {
              cwds: state.whoami?.workdir ? [state.whoami.workdir] : null,
            });
            const marketplaces = result?.marketplaces ?? [];
            currentPlugins = marketplaces.flatMap((marketplace) =>
              (marketplace.plugins ?? []).map((plugin) => ({
                ...plugin,
                marketplaceName:
                  marketplace.interface?.displayName ?? marketplace.name,
                marketplacePath: marketplace.path,
              })),
            );
            const featured = new Set(result?.featuredPluginIds ?? []);
            const list = mount.querySelector("#plugins-list");
            if (!marketplaces.length) {
              list.innerHTML =
                '<div class="manager-empty">No plugin marketplaces are configured yet.</div>';
              return;
            }
            list.innerHTML = `
              ${
                result?.marketplaceLoadErrors?.length
                  ? `<div class="manager-note">${result.marketplaceLoadErrors
                      .map(
                        (error) =>
                          `${escapeHtml(error.marketplacePath ?? "marketplace")}: ${escapeHtml(error.message ?? "load error")}`,
                      )
                      .join("<br />")}</div>`
                  : ""
              }
              ${marketplaces
                .map(
                  (marketplace) => `
                  <section class="manager-section">
                    <div class="manager-section-head">
                      <h3>${escapeHtml(marketplace.interface?.displayName ?? marketplace.name)}</h3>
                      <span class="manager-meta">${escapeHtml(marketplace.path ?? "")}</span>
                    </div>
                    ${
                      marketplace.plugins?.length
                        ? marketplace.plugins
                            .map((plugin) => {
                              const index = currentPlugins.findIndex(
                                (entry) =>
                                  entry.id === plugin.id &&
                                  entry.marketplacePath === marketplace.path,
                              );
                              const installable =
                                plugin.installPolicy !== "NOT_AVAILABLE";
                              return `
                                <article class="manager-card">
                                  <div class="manager-card-head">
                                    <div>
                                      <h3>${escapeHtml(plugin.interface?.displayName ?? plugin.name)}</h3>
                                      <div class="manager-meta">${escapeHtml(plugin.interface?.category ?? "plugin")} · ${escapeHtml(marketplace.interface?.displayName ?? marketplace.name)}</div>
                                    </div>
                                    ${
                                      plugin.installed
                                        ? `<button type="button" data-action="uninstall-plugin" data-plugin-index="${index}">Uninstall</button>`
                                        : `<button type="button" class="primary" data-action="install-plugin" data-plugin-index="${index}" ${installable ? "" : "disabled"}>${installable ? "Install" : "Unavailable"}</button>`
                                    }
                                  </div>
                                  <div class="manager-blurb">${escapeHtml(plugin.interface?.shortDescription ?? plugin.interface?.longDescription ?? "No description")}</div>
                                  <div class="manager-tags">
                                    <span class="manager-tag">${plugin.installed ? "installed" : "not installed"}</span>
                                    <span class="manager-tag">${plugin.enabled ? "enabled" : "disabled"}</span>
                                    <span class="manager-tag">${escapeHtml(plugin.authPolicy ?? "ON_USE")}</span>
                                    ${featured.has(plugin.id) ? '<span class="manager-tag">featured</span>' : ""}
                                  </div>
                                </article>
                              `;
                            })
                            .join("")
                        : '<div class="manager-empty">This marketplace has no plugins.</div>'
                    }
                  </section>
                `,
                )
                .join("")}
            `;
          } catch (error) {
            mount.querySelector("#plugins-list").innerHTML = `
              <div class="manager-empty">Plugins failed to load: ${escapeHtml(error.message)}</div>
            `;
          }
        };

        mount
          .querySelector("#plugins-list")
          .addEventListener("click", async (event) => {
            const button = event.target.closest("button[data-plugin-index]");
            if (!button) return;
            const plugin = currentPlugins[Number(button.dataset.pluginIndex)];
            if (!plugin) return;
            button.disabled = true;
            try {
              if (button.dataset.action === "install-plugin") {
                await rpcCall("plugin/install", {
                  marketplacePath: plugin.marketplacePath,
                  pluginName: plugin.name,
                  forceRemoteSync: false,
                });
              } else if (button.dataset.action === "uninstall-plugin") {
                await rpcCall("plugin/uninstall", {
                  pluginId: plugin.id,
                  forceRemoteSync: false,
                });
              }
              await refresh();
            } catch (error) {
              appendSystem(`plugin update failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });

        mount
          .querySelector("#add-marketplace")
          .addEventListener("click", async () => {
            const input = mount.querySelector("#marketplace-source");
            const source = input.value.trim();
            if (!source) return;
            try {
              await rpcCall("marketplace/add", { source, refName: null });
              input.value = "";
              await refresh();
            } catch (error) {
              appendSystem(`marketplace add failed: ${error.message}`, "error");
            }
          });
        mount
          .querySelector("#reload-plugins")
          .addEventListener("click", () => void refresh());
        mount.querySelector("#close").addEventListener("click", closeModal);
        await refresh();
      },
      { className: "modal-wide" },
    );
  }

  async function openAppsModal() {
    modal(
      `
      <h2>Apps</h2>
      <p>Connectors available to this thread. Connected apps appear as accessible; others can be opened on ChatGPT for installation or auth.</p>
      <div class="modal-actions modal-actions-left">
        <button id="reload-apps" type="button">Reload</button>
        <button id="close" class="ghost" type="button">Close</button>
      </div>
      <div id="apps-list"><div class="muted">Loading…</div></div>
    `,
      async (mount) => {
        let currentApps = [];
        const refresh = async () => {
          try {
            const result = await rpcCall("app/list", {
              limit: 100,
              threadId: state.activeThreadId ?? null,
              forceRefetch: false,
            });
            currentApps = result?.data ?? [];
            const list = mount.querySelector("#apps-list");
            if (!currentApps.length) {
              list.innerHTML =
                '<div class="manager-empty">No apps were returned by the backend.</div>';
              return;
            }
            list.innerHTML = currentApps
              .map(
                (app) => `
                  <article class="manager-card">
                    <div class="manager-card-head">
                      <div>
                        <h3>${escapeHtml(app.name ?? app.id)}</h3>
                        <div class="manager-meta">${escapeHtml(app.id ?? "")}</div>
                      </div>
                      ${
                        app.installUrl
                          ? `<a class="button-link ${app.isAccessible ? "ghost" : "primary"}" href="${escapeHtml(app.installUrl)}" target="_blank" rel="noopener">${app.isAccessible ? "Open" : "Install"}</a>`
                          : ""
                      }
                    </div>
                    <div class="manager-blurb">${escapeHtml(app.description ?? "No description")}</div>
                    <div class="manager-tags">
                      <span class="manager-tag">${app.isAccessible ? "connected" : "not connected"}</span>
                      <span class="manager-tag">${app.isEnabled ? "enabled" : "disabled"}</span>
                      ${
                        (app.labels ?? [])
                          .map(
                            (label) =>
                              `<span class="manager-tag">${escapeHtml(label)}</span>`,
                          )
                          .join("")
                      }
                    </div>
                  </article>
                `,
              )
              .join("");
          } catch (error) {
            mount.querySelector("#apps-list").innerHTML = `
              <div class="manager-empty">Apps failed to load: ${escapeHtml(error.message)}</div>
            `;
          }
        };

        mount
          .querySelector("#reload-apps")
          .addEventListener("click", () => void refresh());
        mount.querySelector("#close").addEventListener("click", () => {
          window.__appsRefresh = null;
          closeModal();
        });
        window.__appsRefresh = refresh;
        await refresh();
      },
      { className: "modal-wide" },
    );
  }

  function settingsTabButton(name, label, active) {
    return `<button type="button" class="settings-tab${active ? " active" : ""}" data-tab="${name}">${escapeHtml(label)}</button>`;
  }

  function panel(title, body, hidden = false) {
    return `<div class="settings-panel" data-panel="${title}" ${hidden ? "hidden" : ""}>${body}</div>`;
  }

  function summaryBlock(title, value) {
    return `
      <div class="modal-row">
        <label>${escapeHtml(title)}</label>
        <pre>${escapeHtml(typeof value === "string" ? value : JSON.stringify(value, null, 2))}</pre>
      </div>
    `;
  }

  async function openSettings(focus) {
    if (state.initialized && !state.models.length) {
      await refreshModels().catch(() => {});
    }

    const [hooksState, memoriesData, secretsData] = await Promise.all([
      loadHooksEditorState(),
      loadMemoriesData(),
      loadProjectSecretsData(),
    ]);
    const settings = state.settings;
    const config = state.configSnapshot?.config ?? {};
    const configLayers = state.configSnapshot?.layers ?? [];
    const requirements = state.configRequirements?.requirements ?? null;
    const models = [...state.models];
    if (
      settings.model &&
      !models.some((model) => {
        const id = model.id ?? model.slug ?? model.model;
        return id === settings.model;
      })
    ) {
      models.unshift({ id: settings.model });
    }
    const modelOptions = (models.length
      ? models.map((model) => {
          const id = model.id ?? model.slug ?? model.model;
          return `<option value="${escapeHtml(id)}" ${settings.model === id ? "selected" : ""}>${escapeHtml(id)}</option>`;
        })
      : ['<option value="">No models available</option>']
    ).join("");
    const select = (name, options) =>
      `<select name="${name}">${options.map((option) => `<option value="${option}" ${settings[name] === option ? "selected" : ""}>${option}</option>`).join("")}</select>`;
    const tabs = [
      ["model", "Model"],
      ["approvals", "Approvals"],
      ["reasoning", "Reasoning"],
      ["web", "Web Search"],
      ["personality", "Personality"],
      ["service", "Service Tier"],
      ["memories", "Memories"],
      ["secrets", "Secrets"],
      ["experimental", "Experimental"],
      ["mcp", "MCP"],
      ["skills", "Skills"],
      ["plugins", "Plugins"],
      ["apps", "Apps"],
      ["hooks", "Hooks"],
      ["analytics", "Analytics"],
      ["appearance", "Appearance"],
      ["advanced", "Advanced"],
    ];
    const tabForFocus =
      {
        model: "model",
        approvalPolicy: "approvals",
        sandboxMode: "approvals",
        modelReasoningEffort: "reasoning",
        webSearchMode: "web",
        appearance: "appearance",
      }[focus] ?? "model";
    modal(
      `
      <h2>Settings</h2>
      <p>Live session controls plus advanced raw config inspection for the full schema.</p>
      <div class="settings-tabs">
        ${tabs.map(([name, label]) => settingsTabButton(name, label, name === tabForFocus)).join("")}
      </div>
      ${panel(
        "model",
        `
        <div class="modal-row"><label>Model</label><select name="model" ${models.length ? "" : "disabled"}>${modelOptions}</select></div>
        <div class="modal-row"><label>Server working directory</label><input value="${escapeHtml(state.whoami?.workdir ?? "")}" disabled /></div>
      `,
        tabForFocus !== "model",
      )}
      ${panel(
        "approvals",
        `
        <div class="modal-row"><label>Approval policy</label>${select("approvalPolicy", ["never", "on-request", "on-failure", "untrusted"])}</div>
        <div class="modal-row"><label>Sandbox</label>${select("sandboxMode", ["read-only", "workspace-write", "danger-full-access"])}</div>
        <div class="modal-row"><label><input type="checkbox" name="networkAccessEnabled" ${settings.networkAccessEnabled ? "checked" : ""} /> Allow network access in sandbox</label></div>
      `,
        tabForFocus !== "approvals",
      )}
      ${panel(
        "reasoning",
        `
        <div class="modal-row"><label>Reasoning effort</label>${select("modelReasoningEffort", ["minimal", "low", "medium", "high", "xhigh"])}</div>
      `,
        tabForFocus !== "reasoning",
      )}
      ${panel(
        "web",
        `
        <div class="modal-row"><label>Web search</label>${select("webSearchMode", ["disabled", "cached", "live"])}</div>
      `,
        tabForFocus !== "web",
      )}
      ${panel(
        "personality",
        `
        <p class="settings-copy">Use the advanced config pane for full personality editing. This tab gives a live snapshot of the current config values.</p>
        ${summaryBlock("Personality-related config", {
          base_instructions: config.base_instructions ?? null,
          developer_instructions: config.developer_instructions ?? null,
          personality: config.personality ?? null,
        })}
      `,
        tabForFocus !== "personality",
      )}
      ${panel(
        "service",
        `
        <p class="settings-copy">Service tier values are surfaced from the live config snapshot.</p>
        ${summaryBlock("Service tier", config.service_tier ?? null)}
      `,
        tabForFocus !== "service",
      )}
      ${panel(
        "memories",
        `
        <p class="settings-copy">Discovered instruction files come from the workspace path chain plus the session Codex home. Resetting the memory store clears generated memories, while thread memory mode controls whether the active thread stays eligible for future memory generation.</p>
        ${
          memoriesData.error
            ? `<div class="manager-note">${escapeHtml(memoriesData.error)}</div>`
            : ""
        }
        <div class="modal-row">
          <label>Thread memory mode</label>
          <div class="memory-toolbar">
            <select id="thread-memory-mode" ${state.activeThreadId ? "" : "disabled"}>
              <option value="enabled" ${currentThreadMemoryMode() === "enabled" ? "selected" : ""}>Enabled</option>
              <option value="disabled" ${currentThreadMemoryMode() === "disabled" ? "selected" : ""}>Disabled</option>
            </select>
            <button id="apply-memory-mode" type="button" ${state.activeThreadId ? "" : "disabled"}>Apply to active thread</button>
            <button id="refresh-memories" type="button">Refresh</button>
            <button id="reset-memories" type="button">Reset memory store</button>
          </div>
          <div class="settings-copy">
            ${
              state.activeThreadId
                ? `Active thread: ${escapeHtml(state.activeThreadId)}. The backend does not expose the current saved mode yet, so the selector reflects the most recent web-set value for this thread.`
                : "Start or resume a thread to update its memory mode."
            }
          </div>
        </div>
        <div class="manager-meta">${escapeHtml(memoriesData.codexHome ?? getSessionCodexHome() ?? "")}</div>
        <div id="memory-list" class="manager-list">${renderMemoryItems(memoriesData.items ?? [])}</div>
      `,
        tabForFocus !== "memories",
      )}
      ${panel(
        "secrets",
        `
        <p class="settings-copy">Secrets are stored per named project in an encrypted file on disk and injected into the backend environment whenever that project workspace is active.</p>
        ${
          !secretsData.available
            ? '<div class="manager-note">Activate a named project from the sidebar before managing secrets.</div>'
            : ""
        }
        ${
          secretsData.available && !secretsData.configured
            ? '<div class="manager-note">Secret storage is disabled until <code>CODEX_WEB_SECRETS_KEY</code> is configured on the server.</div>'
            : ""
        }
        ${
          secretsData.error
            ? `<div class="manager-note">${escapeHtml(secretsData.error)}</div>`
            : ""
        }
        <div class="hook-grid">
          <div class="modal-row">
            <label>Secret key</label>
            <input id="secret-key" placeholder="OPENAI_API_KEY" ${secretsData.available && secretsData.configured ? "" : "disabled"} />
          </div>
          <div class="modal-row">
            <label>Secret value</label>
            <input id="secret-value" type="password" placeholder="Paste a value to add or replace" ${secretsData.available && secretsData.configured ? "" : "disabled"} />
          </div>
        </div>
        <div class="modal-actions modal-actions-left">
          <button id="save-secret" class="primary" type="button" ${secretsData.available && secretsData.configured ? "" : "disabled"}>Save secret</button>
          <button id="refresh-secrets" type="button" ${secretsData.available ? "" : "disabled"}>Refresh</button>
        </div>
        <div class="settings-copy">Saving the same key again replaces its value. Deleting a secret removes it and restarts the backend for this active project workspace.</div>
        <div id="secrets-list" class="manager-list">${renderProjectSecrets(secretsData)}</div>
      `,
        tabForFocus !== "secrets",
      )}
      ${panel(
        "experimental",
        `
        <p class="settings-copy">Experimental feature flags come from <code>experimentalFeature/list</code>.</p>
        <div class="settings-list">
          ${
            (state.experimentalFeatures ?? [])
              .map(
                (feature) => `
            <label class="settings-check">
              <input
                type="checkbox"
                data-experimental-toggle="${escapeHtml(feature.name)}"
                data-original-enabled="${feature.enabled ? "1" : "0"}"
                ${feature.enabled ? "checked" : ""}
              />
              <span><strong>${escapeHtml(feature.displayName ?? feature.name)}</strong> · ${escapeHtml(feature.stage)}</span>
              ${feature.description ? `<span class="muted">${escapeHtml(feature.description)}</span>` : ""}
            </label>
          `,
              )
              .join("") ||
            '<div class="muted">No experimental features reported by the backend.</div>'
          }
        </div>
      `,
        tabForFocus !== "experimental",
      )}
      ${panel(
        "mcp",
        `
        <p class="settings-copy">MCP is managed through its own live modal.</p>
        <div class="modal-actions modal-actions-left">
          <button id="open-mcp" type="button">Open MCP manager…</button>
        </div>
      `,
        tabForFocus !== "mcp",
      )}
      ${panel(
        "skills",
        `
        <p class="settings-copy">Skills are discovered live from the backend and can be enabled or disabled per user config.</p>
        <div class="modal-actions modal-actions-left">
          <button id="open-skills" type="button">Open skills manager…</button>
        </div>
      `,
        tabForFocus !== "skills",
      )}
      ${panel(
        "plugins",
        `
        <p class="settings-copy">Plugin marketplaces and install state come from <code>plugin/list</code> and can be changed directly from the manager.</p>
        <div class="modal-actions modal-actions-left">
          <button id="open-plugins" type="button">Open plugins manager…</button>
        </div>
      `,
        tabForFocus !== "plugins",
      )}
      ${panel(
        "apps",
        `
        <p class="settings-copy">Apps are listed from <code>app/list</code> and reflect whether the current thread can already access each connector.</p>
        <div class="modal-actions modal-actions-left">
          <button id="open-apps" type="button">Open apps manager…</button>
        </div>
      `,
        tabForFocus !== "apps",
      )}
      ${panel(
        "hooks",
        `
        <p class="settings-copy">Command hooks are stored in the session config folder as <code>hooks.json</code>. Each enabled row below becomes one command hook entry; unsupported hook types are preserved when you save.</p>
        ${
          hooksState.loadError
            ? `<div class="manager-note">${escapeHtml(hooksState.loadError)}</div>`
            : ""
        }
        ${
          hooksState.unsupportedCount
            ? `<div class="manager-note">${hooksState.unsupportedCount} unsupported hook entr${hooksState.unsupportedCount === 1 ? "y" : "ies"} will be preserved on save.</div>`
            : ""
        }
        <div class="manager-meta">${escapeHtml(getHooksFilePath() || "session .codex/hooks.json")}</div>
        <div class="modal-actions modal-actions-left">
          <button id="add-hook-row" type="button">Add hook</button>
          <button id="reload-hooks" type="button">Reload</button>
          <button id="save-hooks" class="primary" type="button">Save hooks</button>
        </div>
        <div id="hooks-editor" class="hooks-editor">${renderHookRows(hooksState.rows)}</div>
      `,
        tabForFocus !== "hooks",
      )}
      ${panel(
        "analytics",
        `
        <p class="settings-copy">Analytics and telemetry are surfaced from live config.</p>
        ${summaryBlock("Analytics / telemetry", {
          analytics: config.analytics ?? null,
          telemetry: config.telemetry ?? null,
        })}
      `,
        tabForFocus !== "analytics",
      )}
      ${panel(
        "appearance",
        `
        <p class="settings-copy">Appearance is currently a lightweight web-only setting.</p>
        ${summaryBlock("Theme / appearance", {
          theme: config.theme ?? null,
          appearance: config.appearance ?? null,
        })}
      `,
        tabForFocus !== "appearance",
      )}
      ${panel(
        "advanced",
        `
        ${summaryBlock("Config snapshot", config)}
        ${summaryBlock("Config layers / origins", configLayers)}
        ${summaryBlock("Config requirements", requirements ?? "No requirements configured.")}
      `,
        tabForFocus !== "advanced",
      )}
      <div class="modal-actions">
        <button id="cancel" class="ghost">Cancel</button>
        <button id="save" class="primary">Save</button>
      </div>
    `,
      (mount) => {
        let currentHooksState = hooksState;
        let currentMemoriesData = memoriesData;
        let currentSecretsData = secretsData;
        const setTab = (tab) => {
          mount.querySelectorAll(".settings-tab").forEach((node) => {
            node.classList.toggle("active", node.dataset.tab === tab);
          });
          mount.querySelectorAll(".settings-panel").forEach((node) => {
            node.hidden = node.dataset.panel !== tab;
          });
        };
        const hooksEditor = mount.querySelector("#hooks-editor");
        const memoryList = mount.querySelector("#memory-list");
        const secretsList = mount.querySelector("#secrets-list");
        const memoryModeSelect = mount.querySelector("#thread-memory-mode");
        const renderHooksEditor = () => {
          if (hooksEditor) hooksEditor.innerHTML = renderHookRows(currentHooksState.rows);
        };
        const renderMemoryList = () => {
          if (memoryList) {
            memoryList.innerHTML = renderMemoryItems(currentMemoriesData.items ?? []);
          }
        };
        const renderSecretsList = () => {
          if (secretsList) {
            secretsList.innerHTML = renderProjectSecrets(currentSecretsData);
          }
        };
        mount.querySelectorAll(".settings-tab").forEach((node) => {
          node.addEventListener("click", () => setTab(node.dataset.tab));
        });
        mount.querySelector("#cancel").addEventListener("click", closeModal);
        mount.querySelector("#open-mcp")?.addEventListener("click", () => {
          closeModal();
          void openMcpModal();
        });
        mount
          .querySelector("#open-skills")
          ?.addEventListener("click", () => void openSkillsModal());
        mount
          .querySelector("#open-plugins")
          ?.addEventListener("click", () => void openPluginsModal());
        mount
          .querySelector("#open-apps")
          ?.addEventListener("click", () => void openAppsModal());
        mount.querySelector("#add-hook-row")?.addEventListener("click", () => {
          currentHooksState.rows.push(createEmptyHookRow());
          renderHooksEditor();
        });
        hooksEditor?.addEventListener("click", (event) => {
          const button = event.target.closest("[data-action='remove-hook']");
          if (!button) return;
          currentHooksState.rows = currentHooksState.rows.filter(
            (row) => row.id !== button.dataset.hookRowId,
          );
          if (!currentHooksState.rows.length) {
            currentHooksState.rows = [createEmptyHookRow()];
          }
          renderHooksEditor();
        });
        mount.querySelector("#reload-hooks")?.addEventListener("click", async () => {
          currentHooksState = await loadHooksEditorState();
          renderHooksEditor();
          appendSystem("Hooks reloaded from hooks.json.");
        });
        mount.querySelector("#save-hooks")?.addEventListener("click", async () => {
          const button = mount.querySelector("#save-hooks");
          button.disabled = true;
          try {
            currentHooksState.rows = collectHookRows(mount);
            await writeHooksFile(currentHooksState.rows, currentHooksState.preserved);
            await refreshConfigState().catch(() => {});
            appendSystem("Hooks saved.");
          } catch (error) {
            appendSystem(`hooks save failed: ${error.message}`, "error");
          } finally {
            button.disabled = false;
          }
        });
        mount
          .querySelector("#apply-memory-mode")
          ?.addEventListener("click", async () => {
            if (!state.activeThreadId || !memoryModeSelect) return;
            const button = mount.querySelector("#apply-memory-mode");
            button.disabled = true;
            try {
              await rpcCall("thread/memoryMode/set", {
                threadId: state.activeThreadId,
                mode: memoryModeSelect.value,
              });
              persistThreadMemoryMode(memoryModeSelect.value);
              appendSystem(`thread memory mode → ${memoryModeSelect.value}`);
            } catch (error) {
              appendSystem(`memory mode update failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });
        mount
          .querySelector("#refresh-memories")
          ?.addEventListener("click", async () => {
            currentMemoriesData = await loadMemoriesData();
            renderMemoryList();
            appendSystem("Memory discovery refreshed.");
          });
        mount
          .querySelector("#reset-memories")
          ?.addEventListener("click", async () => {
            if (!confirm("Reset the session memory store? Generated memories will be deleted.")) {
              return;
            }
            const button = mount.querySelector("#reset-memories");
            button.disabled = true;
            try {
              await rpcCall("memory/reset", {});
              currentMemoriesData = await loadMemoriesData();
              renderMemoryList();
              appendSystem("Memory store reset.");
            } catch (error) {
              appendSystem(`memory reset failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });
        mount
          .querySelector("#refresh-secrets")
          ?.addEventListener("click", async () => {
            currentSecretsData = await loadProjectSecretsData();
            renderSecretsList();
            appendSystem("Project secrets refreshed.");
          });
        mount
          .querySelector("#save-secret")
          ?.addEventListener("click", async () => {
            const keyInput = mount.querySelector("#secret-key");
            const valueInput = mount.querySelector("#secret-value");
            const key = keyInput?.value.trim() ?? "";
            if (!key || !currentSecretsData.slug) return;
            const button = mount.querySelector("#save-secret");
            button.disabled = true;
            try {
              const response = await fetch(
                `/api/projects/${encodeURIComponent(currentSecretsData.slug)}/secrets`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    key,
                    value: valueInput?.value ?? "",
                  }),
                },
              );
              const data = await response.json().catch(() => ({}));
              if (!response.ok) {
                throw new Error(
                  data.error ?? `secret save failed (${response.status})`,
                );
              }
              currentSecretsData = {
                ...currentSecretsData,
                configured: true,
                keys: data.keys ?? [],
                error: null,
              };
              renderSecretsList();
              if (keyInput) keyInput.value = "";
              if (valueInput) valueInput.value = "";
              appendSystem(`Saved secret ${key}.`);
            } catch (error) {
              appendSystem(`secret save failed: ${error.message}`, "error");
            } finally {
              button.disabled = false;
            }
          });
        secretsList?.addEventListener("click", async (event) => {
          const button = event.target.closest("[data-action='delete-secret']");
          if (!button || !currentSecretsData.slug) return;
          const key = button.dataset.secretKey ?? "";
          if (!key) return;
          if (!confirm(`Delete secret "${key}"?`)) return;
          button.disabled = true;
          try {
            const response = await fetch(
              `/api/projects/${encodeURIComponent(currentSecretsData.slug)}/secrets`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key, value: "" }),
              },
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(
                data.error ?? `secret delete failed (${response.status})`,
              );
            }
            currentSecretsData = {
              ...currentSecretsData,
              keys: data.keys ?? [],
              error: null,
            };
            renderSecretsList();
            appendSystem(`Deleted secret ${key}.`);
          } catch (error) {
            appendSystem(`secret delete failed: ${error.message}`, "error");
          } finally {
            button.disabled = false;
          }
        });
        memoryList?.addEventListener("click", async (event) => {
          const button = event.target.closest("[data-action='preview-memory']");
          if (!button) return;
          const item = currentMemoriesData.items?.[Number(button.dataset.memoryIndex)];
          if (!item?.path) return;
          try {
            const response = await rpcCall("fs/readFile", { path: item.path });
            openTextModal(item.fileName ?? "Memory file", decodeBase64(response?.dataBase64 ?? ""), {
              className: "modal-wide",
            });
          } catch (error) {
            appendSystem(`memory preview failed: ${error.message}`, "error");
          }
        });
        if (focus) {
          const field = mount.querySelector(`[name="${focus}"]`);
          if (field) field.focus();
        }
        mount.querySelector("#save").addEventListener("click", async () => {
          for (const key of [
            "model",
            "approvalPolicy",
            "sandboxMode",
            "modelReasoningEffort",
            "webSearchMode",
          ]) {
            const node = mount.querySelector(`[name="${key}"]`);
            if (node) state.settings[key] = node.value;
          }
          state.settings.networkAccessEnabled =
            mount.querySelector(`[name="networkAccessEnabled"]`)?.checked ??
            false;
          save("settings", state.settings);
          updateStatusBar();
          await pushSettingsToBackend();
          const enablement = {};
          mount
            .querySelectorAll("[data-experimental-toggle]")
            .forEach((node) => {
              const original = node.dataset.originalEnabled === "1";
              if (node.checked !== original) {
                enablement[node.dataset.experimentalToggle] = node.checked;
              }
            });
          if (Object.keys(enablement).length) {
            await rpcCall("experimentalFeature/enablement/set", {
              enablement,
            }).catch((error) => {
              appendSystem(
                `experimental feature update failed: ${error.message}`,
                "error",
              );
            });
          }
          await refreshExperimentalFeatures().catch(() => {});
          await refreshConfigState().catch(() => {});
          closeModal();
        });
      },
    );
  }

  return {
    closeModal,
    modal,
    openElicitationModal,
    openJsonModal,
    openListModal,
    openLogin,
    openAppsModal,
    openMcpModal,
    openPermissionsModal,
    openModelPickerModal,
    openPluginsModal,
    openProjectToolsModal,
    openSettings,
    openShortcutsModal,
    openSkillsModal,
    openUserInputModal,
  };
}
