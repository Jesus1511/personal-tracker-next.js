/** Modelos permitidos en UI + API (ids oficiales Messages API). */
export const CLAUDE_MODEL_OPTIONS: readonly { id: string; label: string }[] = [
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
] as const;

export const DEFAULT_CLAUDE_MODEL_ID = "claude-sonnet-4-6";

export const CLAUDE_MODEL_FALLBACK_CHAIN: readonly string[] = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

const ALLOWED_CLAUDE_MODEL_IDS = new Set(
  CLAUDE_MODEL_OPTIONS.map((o) => o.id),
);

export function isAllowedClaudeModelId(id: string): boolean {
  return ALLOWED_CLAUDE_MODEL_IDS.has(id);
}

/** `undefined` si no viene o vacío; lanza si viene algo no listado. */
export function parseClaudeModelFromBody(
  raw: string | undefined,
): string | undefined {
  if (raw == null || String(raw).trim() === "") return undefined;
  const id = String(raw).trim();
  if (!isAllowedClaudeModelId(id)) {
    throw new Error(`Modelo no permitido: ${id}`);
  }
  return id;
}
