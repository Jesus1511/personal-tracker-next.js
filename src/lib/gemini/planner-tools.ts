import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";

import { applyRoutineToDay } from "@/lib/planner/daily-routines";

// ── Public types ─────────────────────────────────────────────────────────────

export type WriteMode = "plan" | "agent";

export type PlanAction = {
  id: string;
  label: string;
  method: string;
  endpoint: string;
  body: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  error?: string;
};

// Used internally to signal plan mode to the route handler
export type PlanActionResult = { __planAction: PlanAction };

export function isPlanActionResult(v: unknown): v is PlanActionResult {
  return (
    typeof v === "object" &&
    v !== null &&
    "__planAction" in (v as object)
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function planId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `p-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** HH:MM + YYYY-MM-DD → ISO datetime in Caracas (-04:00) */
function toCaracasIso(date: string, time: string): string {
  const t = time.length === 5 ? time : time.slice(0, 5);
  return `${date}T${t}:00-04:00`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function strOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

// ── Tool definitions (Anthropic format) ──────────────────────────────────────

export const PLANNER_WRITE_TOOLS: Anthropic.Tool[] = [
  {
    name: "create_task",
    description:
      "Create a new task for a specific date. Use query_lookup_catalogs first if you need to know available task_type IDs.",
    input_schema: {
      type: "object" as const,
      properties: {
        scheduled_date: { type: "string", description: "Date in YYYY-MM-DD format." },
        title: { type: "string", description: "Task title." },
        task_type_id: { type: "string", description: "Optional task type UUID." },
        notes: { type: "string", description: "Optional notes." },
        points: { type: "number", description: "Optional effort points (0–10)." },
      },
      required: ["scheduled_date", "title"],
    },
  },
  {
    name: "update_task",
    description: "Update an existing task. Use query_table('tasks', ...) first to get the task ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task UUID." },
        title: { type: "string", description: "New title." },
        notes: { type: "string", description: "New notes." },
        points: { type: "number", description: "New points (0–10)." },
        done: { type: "boolean", description: "Mark as done/undone." },
        task_type_id: { type: "string", description: "New task type UUID." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "delete_task",
    description: "Delete an existing task by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task UUID." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "create_time_block",
    description:
      "Create a planned time block for a date. Times are HH:MM in America/Caracas. " +
      "entry_type must be 'task' or 'habit'. For task blocks, task_id is optional (unassigned placeholder). " +
      "For habit blocks, habit_type_id is required (get IDs via query_lookup_catalogs).",
    input_schema: {
      type: "object" as const,
      properties: {
        scheduled_date: { type: "string", description: "Date in YYYY-MM-DD." },
        start_time: { type: "string", description: "Start time HH:MM (Caracas tz)." },
        end_time: { type: "string", description: "End time HH:MM (Caracas tz)." },
        entry_type: { type: "string", enum: ["task", "habit"], description: "'task' or 'habit'." },
        task_id: { type: "string", description: "Optional task UUID (for task blocks)." },
        habit_type_id: { type: "string", description: "Habit type UUID (required for habit blocks)." },
        notes: { type: "string", description: "Optional notes." },
      },
      required: ["scheduled_date", "start_time", "end_time", "entry_type"],
    },
  },
  {
    name: "delete_time_block",
    description: "Delete an existing planned time block by ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        time_block_id: { type: "string", description: "Time block UUID." },
      },
      required: ["time_block_id"],
    },
  },
  {
    name: "apply_routine",
    description:
      "Apply a saved routine to a specific date, replacing any existing planned tasks and blocks for that day. " +
      "Use query_table('routines', ...) to get available routine IDs first.",
    input_schema: {
      type: "object" as const,
      properties: {
        routine_id: { type: "string", description: "Routine UUID." },
        target_date: { type: "string", description: "Target date YYYY-MM-DD." },
      },
      required: ["routine_id", "target_date"],
    },
  },
  {
    name: "set_daily_goal",
    description: "Upsert the daily goal (headline intention) for a specific date.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Date YYYY-MM-DD." },
        title: { type: "string", description: "Goal text." },
      },
      required: ["date", "title"],
    },
  },
  {
    name: "update_ai_context",
    description:
      "Rewrite your own context document. Call this whenever you learn important new information " +
      "about the user (preferences, patterns, goals, constraints) that should persist across conversations. " +
      "Write the full updated document — previous content will be replaced. " +
      "This tool always executes immediately regardless of plan/agent mode.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "Full new content for the AI context document (markdown).",
        },
      },
      required: ["content"],
    },
  },
];

// ── Executor ──────────────────────────────────────────────────────────────────

export async function executePlannerWriteTool(
  supabase: SupabaseClient,
  mode: WriteMode,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PlanActionResult | { success: boolean; data?: unknown; error?: string }> {
  switch (toolName) {
    case "create_task":
      return handleCreateTask(supabase, mode, input);
    case "update_task":
      return handleUpdateTask(supabase, mode, input);
    case "delete_task":
      return handleDeleteTask(supabase, mode, input);
    case "create_time_block":
      return handleCreateTimeBlock(supabase, mode, input);
    case "delete_time_block":
      return handleDeleteTimeBlock(supabase, mode, input);
    case "apply_routine":
      return handleApplyRoutine(supabase, mode, input);
    case "set_daily_goal":
      return handleSetDailyGoal(supabase, mode, input);
    case "update_ai_context":
      // Always executes immediately — context is meta, not a planner action
      return handleUpdateAiContext(supabase, input);
    default:
      return { success: false, error: `Unknown write tool: ${toolName}` };
  }
}

// ── Per-tool handlers ────────────────────────────────────────────────────────

async function handleCreateTask(
  supabase: SupabaseClient,
  mode: WriteMode,
  input: Record<string, unknown>,
) {
  const scheduledDate = str(input.scheduled_date);
  const title = str(input.title);
  const label = `Crear tarea "${title}" para el ${scheduledDate}`;

  if (mode === "plan") {
    return makePlan(label, "POST", "/api/planner/tasks", {
      title,
      scheduledDate,
      notes: input.notes ?? null,
      taskTypeId: input.task_type_id ?? null,
    });
  }

  const { data: maxRow } = await supabase
    .from("tasks")
    .select("sort_order")
    .eq("scheduled_date", scheduledDate)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      title,
      notes: input.notes ?? null,
      task_type_id: input.task_type_id ?? null,
      points: typeof input.points === "number" ? input.points : null,
      scheduled_date: scheduledDate,
      sort_order: ((maxRow?.sort_order ?? 0) as number) + 1,
    })
    .select("id, title, scheduled_date")
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data };
}

async function handleUpdateTask(
  supabase: SupabaseClient,
  mode: WriteMode,
  input: Record<string, unknown>,
) {
  const taskId = str(input.task_id);
  const changes: string[] = [];
  if (input.title) changes.push(`título→"${str(input.title)}"`);
  if (typeof input.done === "boolean") changes.push(input.done ? "completada" : "pendiente");
  const label = `Actualizar tarea ${taskId.slice(0, 8)} (${changes.join(", ") || "sin cambios"})`;

  if (mode === "plan") {
    const body: Record<string, unknown> = {};
    if (typeof input.title === "string") body.title = input.title;
    if ("notes" in input) body.notes = input.notes;
    if (typeof input.points === "number") body.points = input.points;
    if (typeof input.done === "boolean") body.done = input.done;
    if (input.task_type_id) body.taskTypeId = input.task_type_id;
    return makePlan(label, "PATCH", `/api/planner/tasks/${taskId}`, body);
  }

  const payload: Record<string, unknown> = {};
  if (typeof input.title === "string") payload.title = input.title.trim();
  if ("notes" in input) payload.notes = input.notes ?? null;
  if (typeof input.points === "number") payload.points = input.points;
  if (typeof input.done === "boolean") payload.done = input.done;
  if (input.task_type_id) payload.task_type_id = str(input.task_type_id);

  if (Object.keys(payload).length === 0) return { success: false, error: "No fields provided." };

  const { data, error } = await supabase
    .from("tasks")
    .update(payload)
    .eq("id", taskId)
    .select("id, title, done")
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data };
}

async function handleDeleteTask(
  supabase: SupabaseClient,
  mode: WriteMode,
  input: Record<string, unknown>,
) {
  const taskId = str(input.task_id);
  const label = `Eliminar tarea ${taskId.slice(0, 8)}`;

  if (mode === "plan") {
    return makePlan(label, "DELETE", `/api/planner/tasks/${taskId}`, {});
  }

  const { error } = await supabase.from("tasks").delete().eq("id", taskId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

async function handleCreateTimeBlock(
  supabase: SupabaseClient,
  mode: WriteMode,
  input: Record<string, unknown>,
) {
  const scheduledDate = str(input.scheduled_date);
  const startTime = str(input.start_time);
  const endTime = str(input.end_time);
  const entryType = strOr(input.entry_type, "task");
  const startAt = toCaracasIso(scheduledDate, startTime);
  const endAt = toCaracasIso(scheduledDate, endTime);
  const label = `Crear bloque ${entryType} ${startTime}–${endTime} el ${scheduledDate}`;

  if (mode === "plan") {
    return makePlan(label, "POST", "/api/planner/time-blocks", {
      scheduledDate,
      startAt,
      endAt,
      entryType,
      taskId: input.task_id ?? null,
      habitTypeId: input.habit_type_id ?? null,
      notes: input.notes ?? null,
    });
  }

  const { data, error } = await supabase
    .from("time_blocks")
    .insert({
      scheduled_date: scheduledDate,
      start_at: startAt,
      end_at: endAt,
      entry_type: entryType,
      task_id: entryType === "task" ? (input.task_id ?? null) : null,
      habit_type_id: entryType === "habit" ? (input.habit_type_id ?? null) : null,
      notes: input.notes ?? null,
    })
    .select("id, scheduled_date, start_at, end_at, entry_type")
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data };
}

async function handleDeleteTimeBlock(
  supabase: SupabaseClient,
  mode: WriteMode,
  input: Record<string, unknown>,
) {
  const blockId = str(input.time_block_id);
  const label = `Eliminar bloque de tiempo ${blockId.slice(0, 8)}`;

  if (mode === "plan") {
    return makePlan(label, "DELETE", `/api/planner/time-blocks/${blockId}`, {});
  }

  const { error } = await supabase.from("time_blocks").delete().eq("id", blockId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

async function handleApplyRoutine(
  supabase: SupabaseClient,
  mode: WriteMode,
  input: Record<string, unknown>,
) {
  const routineId = str(input.routine_id);
  const targetDate = str(input.target_date);
  const label = `Aplicar rutina ${routineId.slice(0, 8)} al ${targetDate}`;

  if (mode === "plan") {
    return makePlan(label, "POST", `/api/planner/routines/${routineId}/apply`, {
      date: targetDate,
    });
  }

  void supabase; // not used; delegate to existing helper
  await applyRoutineToDay(routineId, targetDate);
  return { success: true };
}

async function handleSetDailyGoal(
  supabase: SupabaseClient,
  mode: WriteMode,
  input: Record<string, unknown>,
) {
  const date = str(input.date);
  const title = str(input.title);
  const label = `Meta del día ${date}: "${title}"`;

  if (mode === "plan") {
    return makePlan(label, "PUT", "/api/planner/daily-goals", { date, title });
  }

  const { data: existing } = await supabase
    .from("daily_goals")
    .select("id")
    .eq("date", date)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from("daily_goals")
      .update({ title, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .select("id, date, title")
      .single();
    if (error) return { success: false, error: error.message };
    return { success: true, data };
  }

  const { data, error } = await supabase
    .from("daily_goals")
    .insert({ date, title, done: false })
    .select("id, date, title")
    .single();
  if (error) return { success: false, error: error.message };
  return { success: true, data };
}

async function handleUpdateAiContext(
  supabase: SupabaseClient,
  input: Record<string, unknown>,
) {
  const content = str(input.content);
  const { error } = await supabase
    .from("scratchpad")
    .upsert(
      { id: "ai_context", content, updated_at: new Date().toISOString() },
      { onConflict: "id" },
    );
  if (error) return { success: false, error: error.message };
  return { success: true, message: "Contexto actualizado." };
}

// ── Plan helper ───────────────────────────────────────────────────────────────

function makePlan(
  label: string,
  method: string,
  endpoint: string,
  body: Record<string, unknown>,
): PlanActionResult {
  return {
    __planAction: {
      id: planId(),
      label,
      method,
      endpoint,
      body,
      status: "pending",
    },
  };
}
