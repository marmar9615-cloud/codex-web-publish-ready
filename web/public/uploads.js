import { $, state } from "./state.js";
import { escapeHtml } from "./utils.js";

export function rememberPreviewUrl(path, previewUrl) {
  if (!path || !previewUrl) return;
  state.previewUrlCache.set(path, previewUrl);
}

export async function getWorkdirPreviewUrl(path) {
  if (!path) return "";
  const cached = state.previewUrlCache.get(path);
  if (cached) return Promise.resolve(cached);
  const pending = fetch(
    `/api/workdir-file/sign?path=${encodeURIComponent(path)}`,
    {
      credentials: "same-origin",
    },
  )
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.previewUrl) {
        throw new Error(
          data.error ?? `preview signing failed (${response.status})`,
        );
      }
      state.previewUrlCache.set(path, data.previewUrl);
      return data.previewUrl;
    })
    .catch((error) => {
      state.previewUrlCache.delete(path);
      throw error;
    });
  state.previewUrlCache.set(path, pending);
  return pending;
}

export function hydrateWorkdirMedia(root = document) {
  root.querySelectorAll("[data-workdir-path]").forEach((node) => {
    if (node.dataset.previewBound === "1") return;
    node.dataset.previewBound = "1";
    const path = node.dataset.workdirPath ?? "";
    void getWorkdirPreviewUrl(path)
      .then((previewUrl) => {
        if (!node.isConnected) return;
        if (node instanceof HTMLImageElement) {
          node.src = previewUrl;
        } else if (node instanceof HTMLAnchorElement) {
          node.href = previewUrl;
        }
      })
      .catch((error) => {
        if (!node.isConnected) return;
        node.setAttribute("title", error.message);
      });
  });
}

export function createUploads({ appendSystem }) {
  function renderPendingUploads() {
    const host = $("#pending-uploads");
    if (!host) return;
    if (state.pendingUploads.length === 0) {
      host.innerHTML = "";
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.innerHTML = state.pendingUploads
      .map(
        (upload, index) => `
      <div class="upload-chip" data-upload-index="${index}">
        <span>${escapeHtml(upload.name ?? "image")}</span>
        <button type="button" data-remove-upload="${index}" class="ghost">×</button>
      </div>
    `,
      )
      .join("");
    host.querySelectorAll("[data-remove-upload]").forEach((button) => {
      button.addEventListener("click", () => {
        state.pendingUploads.splice(Number(button.dataset.removeUpload), 1);
        renderPendingUploads();
      });
    });
  }

  async function onAttachChange(event) {
    const files = [...(event.target.files ?? [])];
    for (const file of files) {
      await queueUpload(file);
    }
    event.target.value = "";
  }

  async function onComposerPaste(event) {
    const items = [...(event.clipboardData?.items ?? [])];
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) {
        event.preventDefault();
        await queueUpload(file);
      }
    }
  }

  async function queueUpload(file) {
    const dataBase64 = await readFileAsBase64(file);
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        mimeType: file.type,
        dataBase64,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      appendSystem(`Upload failed: ${data.error ?? response.status}`, "error");
      return;
    }
    rememberPreviewUrl(data.path, data.previewUrl);
    state.pendingUploads.push({
      path: data.path,
      previewUrl: data.previewUrl,
      name: file.name,
      mimeType: file.type,
    });
    renderPendingUploads();
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () =>
        reject(reader.error ?? new Error("failed to read file"));
      reader.onload = () => {
        const result = String(reader.result ?? "");
        resolve(result.split(",")[1] ?? "");
      };
      reader.readAsDataURL(file);
    });
  }

  return {
    renderPendingUploads,
    onAttachChange,
    onComposerPaste,
    queueUpload,
  };
}
