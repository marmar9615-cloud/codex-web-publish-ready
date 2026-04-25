export const DEFAULT_MODEL_ID = "gpt-5.5";
export const MODEL_CATALOG_VERSION = "2026-04-25-codex-gpt-5.5";

const PREFERRED_MODELS = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "gpt-5.5",
    display_name: "gpt-5.5",
    description:
      "Newest frontier model for complex coding, computer use, knowledge work, and research workflows.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    additionalSpeedTiers: ["fast"],
    isDefault: true,
  },
  {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "gpt-5.4",
    display_name: "gpt-5.4",
    description:
      "Frontier model for professional work with strong reasoning, tool use, and coding workflows.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    isDefault: false,
  },
  {
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "gpt-5.4 mini",
    display_name: "gpt-5.4 mini",
    description:
      "Lower-latency model for focused coding, tools, and subagent work.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    isDefault: false,
  },
  {
    id: "gpt-5.3-codex",
    model: "gpt-5.3-codex",
    displayName: "gpt-5.3 codex",
    display_name: "gpt-5.3 codex",
    description:
      "Dedicated coding model for complex software engineering workflows.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    isDefault: false,
  },
  {
    id: "gpt-5.3-codex-spark",
    model: "gpt-5.3-codex-spark",
    displayName: "gpt-5.3 codex spark",
    display_name: "gpt-5.3 codex spark",
    description:
      "Fast research-preview coding model for near-instant iteration.",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    inputModalities: ["text"],
    isDefault: false,
  },
  {
    id: "gpt-5.2",
    model: "gpt-5.2",
    displayName: "gpt-5.2",
    display_name: "gpt-5.2",
    description:
      "Previous general-purpose model for coding and agentic debugging tasks.",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    inputModalities: ["text", "image"],
    isDefault: false,
  },
];

export const LEGACY_DEFAULT_MODEL_IDS = new Set(["gpt-5.3-codex", "gpt-5.4"]);

export function modelSlug(model) {
  if (!model || typeof model !== "object") return "";
  return model.id ?? model.slug ?? model.model ?? "";
}

export function modelDisplayName(model) {
  if (!model || typeof model !== "object") return "";
  return (
    model.displayName ??
    model.display_name ??
    model.name ??
    model.title ??
    modelSlug(model)
  );
}

export function normalizeModels(remoteModels = []) {
  const bySlug = new Map();
  for (const remote of remoteModels) {
    const slug = modelSlug(remote);
    if (!slug) continue;
    bySlug.set(slug, remote);
  }

  const merged = PREFERRED_MODELS.map((preferred) => {
    const remote = bySlug.get(preferred.id);
    bySlug.delete(preferred.id);
    return {
      ...(remote ?? {}),
      ...preferred,
      isDefault: preferred.id === DEFAULT_MODEL_ID,
    };
  });

  for (const model of bySlug.values()) {
    merged.push({ ...model, isDefault: false });
  }

  return merged;
}

export function pickDefaultModel(models = [], current = "") {
  if (
    current &&
    models.some((model) => {
      return modelSlug(model) === current;
    })
  ) {
    return current;
  }
  const currentDefault = models.find(
    (model) => modelSlug(model) === DEFAULT_MODEL_ID,
  );
  const backendDefault = models.find((model) => model.isDefault);
  return (
    modelSlug(currentDefault ?? backendDefault ?? models[0]) || DEFAULT_MODEL_ID
  );
}
