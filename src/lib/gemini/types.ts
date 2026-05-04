export type ClaudeRequest = {
  prompt: string;
  model?: string;
  maxTokens?: number;
};

export type ClaudeResponse = {
  text: string;
  promptTokens: number;
  responseTokens: number;
};

export type ClaudeError = {
  message: string;
  status?: number;
  raw?: unknown;
};

export type PromptType = "summary" | "recommendations" | "custom";

export type AnalyzableTable =
  | "tasks"
  | "time_blocks"
  | "actual_task_blocks"
  | "actual_habit_blocks"
  | "daily_goals"
  | "daily_summaries"
  | "routines";

export const ANALYZABLE_TABLES: {
  key: AnalyzableTable;
  label: string;
}[] = [
  { key: "tasks", label: "Tareas" },
  { key: "time_blocks", label: "Bloques de tiempo (plan)" },
  { key: "actual_task_blocks", label: "Bloques reales (tareas)" },
  { key: "actual_habit_blocks", label: "Bloques reales (hábitos)" },
  { key: "daily_goals", label: "Meta del día (daily_goals)" },
  { key: "daily_summaries", label: "Resumen del día" },
  { key: "routines", label: "Rutinas" },
];

export const ANALYZABLE_TABLE_KEYS = new Set<AnalyzableTable>(
  ANALYZABLE_TABLES.map((t) => t.key),
);

const LEGACY_ROUTINE_TABLE_KEYS = new Set([
  "daily_routines",
  "daily_routine_tasks",
  "daily_routine_time_blocks",
  "daily_routine_applications",
]);

export function isAnalyzableTableKey(key: string): key is AnalyzableTable {
  return ANALYZABLE_TABLE_KEYS.has(key as AnalyzableTable);
}

/** Nombres antiguos de rutina se mapean a `routines`. */
export function filterAnalyzableTableKeys(keys: string[]): AnalyzableTable[] {
  const seen = new Set<AnalyzableTable>();
  const out: AnalyzableTable[] = [];
  let wantRoutines = false;
  for (const k of keys) {
    if (k === "routines" || LEGACY_ROUTINE_TABLE_KEYS.has(k)) {
      wantRoutines = true;
      continue;
    }
    if (!isAnalyzableTableKey(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  if (wantRoutines && !seen.has("routines")) {
    seen.add("routines");
    out.push("routines");
  }
  return out;
}

/** Etiqueta UI para claves guardadas en historial (incluye legado). */
export function labelAnalyzedTableKey(key: string): string {
  if (key === "routines" || LEGACY_ROUTINE_TABLE_KEYS.has(key)) {
    return "Rutinas";
  }
  return ANALYZABLE_TABLES.find((t) => t.key === key)?.label ?? key;
}

export type DateRange = { start: string; end: string };

export type AnalysisRecord = {
  id: string;
  created_at: string;
  date_start: string;
  date_end: string;
  tables_analyzed: string[];
  prompt_type: PromptType;
  prompt_text: string;
  response_text: string | null;
  status: "completed" | "failed";
  failure_reason: string | null;
  review_status: "pending" | "successful" | "failed";
  review_notes: string | null;
};
