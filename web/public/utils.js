export function el(tag, attrs = {}) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  return node;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

export function renderMarkdownish(text) {
  let out = escapeHtml(text);
  out = out.replace(
    /```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)```/g,
    (_match, lang, code) => {
      const trimmed = code.replace(/\n$/, "");
      const langLabel = lang ? escapeHtml(lang) : "text";
      return (
        `<figure class="code-block" data-lang="${langLabel}">` +
        `<figcaption class="code-block-head">` +
        `<span class="code-block-lang">${langLabel}</span>` +
        `<button type="button" class="code-copy ghost" data-copy-code>Copy</button>` +
        `</figcaption>` +
        `<pre><code>${trimmed}</code></pre>` +
        `</figure>`
      );
    },
  );
  out = out.replace(/`([^`\n]+)`/g, (_match, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  return out;
}
