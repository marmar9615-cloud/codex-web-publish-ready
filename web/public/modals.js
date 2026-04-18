import { $, state, save } from "./state.js";
import { escapeHtml } from "./utils.js";

export function createModals({
  rpcCall,
  rpcRaw,
  rpcReply,
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

  function modal(html, onMount) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
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
            status.innerHTML = userCode
              ? `Open <a href="${escapeHtml(verificationUrl)}" target="_blank" rel="noopener">${escapeHtml(verificationUrl)}</a> and enter code <code>${escapeHtml(userCode)}</code>.`
              : `Open <a href="${escapeHtml(verificationUrl)}" target="_blank" rel="noopener">${escapeHtml(verificationUrl)}</a> to continue.`;
            const startedAt = Date.now();
            const poll = async () => {
              await refreshWhoAmI();
              if (state.whoami?.hasOauth) {
                clearAuthRequiredCard();
                closeModal();
                await refreshAccount().catch(() => {});
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
        window.__mcpRefresh = refresh;
        await refresh();

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
      },
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

  function openSettings(focus) {
    const settings = state.settings;
    const config = state.configSnapshot?.config ?? {};
    const configLayers = state.configSnapshot?.layers ?? [];
    const requirements = state.configRequirements?.requirements ?? null;
    const modelOptions = state.models
      .map((model) => {
        const id = model.id ?? model.slug ?? model.model;
        return `<option value="${escapeHtml(id)}" ${settings.model === id ? "selected" : ""}>${escapeHtml(id)}</option>`;
      })
      .join("");
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
        <div class="modal-row"><label>Model</label><select name="model">${modelOptions}</select></div>
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
        <p class="settings-copy">Memories remain config-driven in the web build for now.</p>
        ${summaryBlock("Memories config", config.memories ?? config.memory ?? null)}
      `,
        tabForFocus !== "memories",
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
        <p class="settings-copy">Skills are discovered live from the backend.</p>
        <div class="modal-actions modal-actions-left">
          <button id="open-skills" type="button">Open skills list…</button>
        </div>
      `,
        tabForFocus !== "skills",
      )}
      ${panel(
        "plugins",
        `
        <p class="settings-copy">Plugins are listed from <code>plugin/list</code>.</p>
        <div class="modal-actions modal-actions-left">
          <button id="open-plugins" type="button">Open plugins list…</button>
        </div>
      `,
        tabForFocus !== "plugins",
      )}
      ${panel(
        "apps",
        `
        <p class="settings-copy">Apps are listed from <code>app/list</code>.</p>
        <div class="modal-actions modal-actions-left">
          <button id="open-apps" type="button">Open apps list…</button>
        </div>
      `,
        tabForFocus !== "apps",
      )}
      ${panel(
        "hooks",
        `
        <p class="settings-copy">Hooks remain raw-config driven in the web build.</p>
        ${summaryBlock("Hooks config", config.hooks ?? null)}
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
        const setTab = (tab) => {
          mount.querySelectorAll(".settings-tab").forEach((node) => {
            node.classList.toggle("active", node.dataset.tab === tab);
          });
          mount.querySelectorAll(".settings-panel").forEach((node) => {
            node.hidden = node.dataset.panel !== tab;
          });
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
          ?.addEventListener(
            "click",
            () => void openListModal("Skills", "skills/list", { limit: 100 }),
          );
        mount
          .querySelector("#open-plugins")
          ?.addEventListener(
            "click",
            () => void openListModal("Plugins", "plugin/list", { limit: 100 }),
          );
        mount
          .querySelector("#open-apps")
          ?.addEventListener(
            "click",
            () => void openListModal("Apps", "app/list", { limit: 100 }),
          );
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
    openMcpModal,
    openPermissionsModal,
    openSettings,
    openUserInputModal,
  };
}
