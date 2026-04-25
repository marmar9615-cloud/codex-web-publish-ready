import { $, state } from "./state.js";
import { createRenderers } from "./renderers.js";

function formatTimestamp(seconds) {
  if (!seconds) return "unknown time";
  return new Date(seconds * 1000).toLocaleString();
}

function showStatus(message, kind = "info") {
  const status = $("#share-status");
  if (!status) return;
  status.hidden = false;
  status.textContent = message;
  status.classList.toggle("workspace-error", kind === "error");
}

function hideStatus() {
  const status = $("#share-status");
  if (!status) return;
  status.hidden = true;
  status.textContent = "";
  status.classList.remove("workspace-error");
}

function resetTranscriptState() {
  $("#transcript").innerHTML = "";
  state.itemsById.clear();
  state.itemOrder = [];
  state.itemTurnIndex.clear();
  state.turns = [];
  state.currentTurnRecordId = null;
  state.activeThreadId = null;
}

const renderers = createRenderers({
  openThread: () => {},
  onThreadAction: () => {},
  onProjectAction: () => {},
  onRollbackToItem: () => {},
  onEditItem: null,
  onForkFromItem: null,
  openLogin: () => {},
  scrollToBottom: () => {},
  hydrateWorkdirMedia: () => {},
  afterUpsertItem: () => {},
});

async function loadShare() {
  const token = decodeURIComponent(
    window.location.pathname.split("/").filter(Boolean).at(-1) ?? "",
  );
  if (!token) {
    showStatus("This share link is incomplete.", "error");
    return;
  }
  hideStatus();
  resetTranscriptState();
  const response = await fetch(`/api/shares/${encodeURIComponent(token)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    $("#share-title").textContent = "Shared thread unavailable";
    $("#share-meta").textContent = "";
    showStatus(
      data.error ?? `Could not load share (${response.status}).`,
      "error",
    );
    return;
  }

  const thread = data.thread ?? {};
  document.title = `${thread.name ?? thread.id ?? "Shared thread"} · Codex Web`;
  $("#share-title").textContent =
    thread.name ?? thread.preview ?? thread.id ?? "Shared thread";
  $("#share-meta").textContent =
    `${data.mode ?? "readonly"} view · expires ${formatTimestamp(data.expiresAt)} · updated ${formatTimestamp(thread.updatedAt ?? data.createdAt)}`;

  const turns = thread.turns ?? [];
  if (!turns.length) {
    showStatus("This shared thread does not contain any turns yet.");
    return;
  }
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      renderers.upsertItem(item, true, true);
    }
  }
}

void loadShare().catch((error) => {
  const message =
    error instanceof Error && error.message
      ? error.message
      : "Could not load share.";
  const titleNode = $("#share-title");
  if (titleNode) titleNode.textContent = "Shared thread unavailable";
  const metaNode = $("#share-meta");
  if (metaNode) metaNode.textContent = "";
  showStatus(message, "error");
});
