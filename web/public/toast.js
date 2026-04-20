// Lightweight toast notifications.
//
// Exports a single `showToast(text, kind?, options?)` helper that spawns an
// auto-dismissing bubble into `#toast-host`. `kind` can be "info" (default),
// "success", "error", or "warn" and drives the color accent.

const DEFAULT_DURATION_MS = 3400;

function host() {
  return document.getElementById("toast-host");
}

export function showToast(text, kind = "info", options = {}) {
  const container = host();
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  toast.textContent = String(text ?? "");
  container.appendChild(toast);
  // Force reflow so the entering transition plays.
  void toast.offsetWidth;
  toast.classList.add("toast-visible");
  const duration = Number.isFinite(options.durationMs)
    ? options.durationMs
    : DEFAULT_DURATION_MS;
  const dismiss = () => {
    toast.classList.remove("toast-visible");
    toast.classList.add("toast-leaving");
    setTimeout(() => toast.remove(), 220);
  };
  const timer = setTimeout(dismiss, duration);
  toast.addEventListener("click", () => {
    clearTimeout(timer);
    dismiss();
  });
}
