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
  | "task_types"
  | "habit_types";

export const ANALYZABLE_TABLES: {
  key: AnalyzableTable;
  label: string;
}[] = [
  { key: "tasks", label: "Tareas" },
  { key: "time_blocks", label: "Bloques de tiempo" },
  { key: "actual_task_blocks", label: "Bloques reales de tareas" },
  { key: "actual_habit_blocks", label: "Bloques reales de hábitos" },
  { key: "task_types", label: "Tipos de tarea" },
  { key: "habit_types", label: "Tipos de hábito" },
];

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
