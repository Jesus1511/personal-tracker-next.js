import { addCalendarDays } from "@/lib/planner/date";

import {
  calendarDayForRow,
  isDayBucketTableListedSeparately,
} from "./analysis-table-config";
import type { AnalyzableTable, DateRange } from "./types";
import { ANALYZABLE_TABLES } from "./types";

type TableData = Record<string, unknown[]>;
type Row = Record<string, unknown>;

// ── Lookup maps ──────────────────────────────────────────────────────────────

function buildIdMap(rows: Row[], nameKey: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    const id = r.id;
    const name = r[nameKey];
    if (typeof id === "string" && typeof name === "string") {
      m.set(id, name);
    }
  }
  return m;
}

interface Lookups {
  habitTypes: Map<string, string>;   // id → name
  taskTypes: Map<string, string>;    // id → name
  tasks: Map<string, string>;        // id → title
  routineTasks: Map<string, string>; // id → title
}

function buildLookups(data: TableData): Lookups {
  return {
    habitTypes: buildIdMap((data.habit_types ?? []) as Row[], "name"),
    taskTypes: buildIdMap((data.task_types ?? []) as Row[], "name"),
    tasks: buildIdMap((data.tasks ?? []) as Row[], "title"),
    routineTasks: buildIdMap((data.daily_routine_tasks ?? []) as Row[], "title"),
  };
}

// ── Noise stripping ───────────────────────────────────────────────────────────

const NOISE_KEYS = new Set(["created_at", "updated_at", "rize_entry_id", "user_completion_link"]);

function stripRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (NOISE_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

const CARACAS_TZ = "America/Caracas";

/** `HH:MM` en Caracas para instantes ISO; `time` Postgres sin fecha se deja como HH:MM. */
function formatPlannerTimeForJson(v: unknown): unknown {
  if (v == null || typeof v !== "string") return v;
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: CARACAS_TZ,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const parts = fmt.formatToParts(d);
      const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
      const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
      return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
    }
  }
  const tm = v.match(/^(\d{2}):(\d{2})(?::\d{2})?/);
  if (tm) return `${tm[1]}:${tm[2]}`;
  return v;
}

// ── Per-table enrichment + ID removal ────────────────────────────────────────

function sortBySortOrder(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const sa =
      typeof a.sort_order === "number" ? a.sort_order : Number(a.sort_order) || 0;
    const sb =
      typeof b.sort_order === "number" ? b.sort_order : Number(b.sort_order) || 0;
    return sa - sb;
  });
}

function enrichAndStrip(table: string, row: Row, lu: Lookups): Row | null {
  const r = stripRow(row);

  switch (table) {
    case "time_blocks": {
      const out: Row = {};
      out.start_at = formatPlannerTimeForJson(r.start_at);
      out.end_at = formatPlannerTimeForJson(r.end_at);
      out.entry_type = r.entry_type;
      if (r.notes) out.notes = r.notes;
      const hid = typeof r.habit_type_id === "string" ? r.habit_type_id : null;
      const tid = typeof r.task_id === "string" ? r.task_id : null;
      if (hid) out.habit = lu.habitTypes.get(hid) ?? hid;
      if (tid) out.task = lu.tasks.get(tid) ?? tid;
      return out;
    }
    case "actual_task_blocks": {
      const out: Row = {};
      out.start_at = formatPlannerTimeForJson(r.start_at);
      out.end_at = formatPlannerTimeForJson(r.end_at);
      const tid = typeof r.task_id === "string" ? r.task_id : null;
      if (tid) out.task = lu.tasks.get(tid) ?? tid;
      if (r.rize_title) out.rize_title = r.rize_title;
      if (r.points_completed !== undefined) out.points_completed = r.points_completed;
      if (r.source) out.source = r.source;
      return out;
    }
    case "actual_habit_blocks": {
      const out: Row = {};
      out.start_at = formatPlannerTimeForJson(r.start_at);
      out.end_at = formatPlannerTimeForJson(r.end_at);
      const hid = typeof r.habit_type_id === "string" ? r.habit_type_id : null;
      if (hid) out.habit = lu.habitTypes.get(hid) ?? hid;
      if (r.description) out.description = r.description;
      return out;
    }
    case "tasks": {
      const out: Row = {};
      out.title = r.title;
      out.done = r.done;
      out.points = r.points;
      if (r.notes) out.notes = r.notes;
      const ttid = typeof r.task_type_id === "string" ? r.task_type_id : null;
      if (ttid) out.task_type = lu.taskTypes.get(ttid) ?? ttid;
      return out;
    }
    case "daily_goals": {
      const out: Row = {};
      out.title = r.title;
      out.done = r.done;
      const ttid = typeof r.task_type_id === "string" ? r.task_type_id : null;
      if (ttid) out.task_type = lu.taskTypes.get(ttid) ?? ttid;
      return out;
    }
    case "daily_summaries": {
      const out: Row = {};
      if (typeof r.text === "string") out.text = r.text;
      return out;
    }
    case "daily_routine_applications":
      return null;
    case "daily_routine_tasks": {
      if (typeof r.title === "string" && !r.title.trim()) return null; // basura
      const out: Row = {};
      out.title = r.title;
      if (r.notes) out.notes = r.notes;
      out.points = r.points;
      out.sort_order = r.sort_order;
      const ttid = typeof r.task_type_id === "string" ? r.task_type_id : null;
      if (ttid) out.task_type = lu.taskTypes.get(ttid) ?? ttid;
      return out;
    }
    case "daily_routine_time_blocks": {
      const out: Row = {};
      out.entry_type = r.entry_type;
      out.start_time = formatPlannerTimeForJson(r.start_time);
      out.end_time = formatPlannerTimeForJson(r.end_time);
      out.sort_order = r.sort_order;
      if (r.notes) out.notes = r.notes;
      const hid = typeof r.habit_type_id === "string" ? r.habit_type_id : null;
      const rtid = typeof r.routine_task_id === "string" ? r.routine_task_id : null;
      if (hid) out.habit = lu.habitTypes.get(hid) ?? hid;
      if (rtid) out.task = lu.routineTasks.get(rtid) ?? rtid;
      return out;
    }
    case "daily_routines": {
      const out: Row = { name: r.name };
      if (r.description) out.description = r.description;
      return out;
    }
    default:
      return stripRow(row);
  }
}

function buildRoutinesForDay(data: TableData, lu: Lookups, dateStr: string): unknown {
  const applications = (data.daily_routine_applications ?? []) as Row[];
  const app = applications.find((r) => r.date === dateStr);
  const routineId = typeof app?.routine_id === "string" ? app.routine_id : null;
  if (!routineId) return null;

  const routines = (data.daily_routines ?? []) as Row[];
  const routine = routines.find((r) => r.id === routineId);
  if (!routine) {
    return { applied_routine_id: routineId, note: "plantilla no encontrada" };
  }

  const enrichedRoutine = enrichAndStrip("daily_routines", routine, lu);
  const tasksRaw = sortBySortOrder(
    (data.daily_routine_tasks ?? []).filter(
      (row) => (row as Row).routine_id === routineId,
    ) as Row[],
  );
  const blocksRaw = sortBySortOrder(
    (data.daily_routine_time_blocks ?? []).filter(
      (row) => (row as Row).routine_id === routineId,
    ) as Row[],
  );

  const tasks = tasksRaw
    .map((row) => enrichAndStrip("daily_routine_tasks", row, lu))
    .filter((r): r is Row => r !== null);
  const time_blocks = blocksRaw
    .map((row) => enrichAndStrip("daily_routine_time_blocks", row, lu))
    .filter((r): r is Row => r !== null);

  return {
    ...(enrichedRoutine ?? {}),
    tasks,
    time_blocks,
  };
}

// ── Main builder ──────────────────────────────────────────────────────────────

function enumerateDatesInclusive(range: DateRange): string[] {
  const out: string[] = [];
  let d = range.start;
  while (true) {
    out.push(d);
    if (d >= range.end) break;
    d = addCalendarDays(d, 1);
    if (out.length > 4000) break;
  }
  return out;
}

export function buildDayKeyedData(data: TableData, range: DateRange): Record<string, unknown> {
  const lu = buildLookups(data);
  const dates = enumerateDatesInclusive(range);
  const selectedDayBucketTables = Object.keys(data).filter(
    isDayBucketTableListedSeparately,
  );
  const dateSet = new Set(selectedDayBucketTables.length > 0 ? dates : []);

  const routineSourceKeys = new Set([
    "daily_routine_applications",
    "daily_routines",
    "daily_routine_tasks",
    "daily_routine_time_blocks",
  ]);
  const hasRoutinesPayload = data.daily_routine_applications !== undefined;

  const result: Record<string, unknown> = {};

  if (selectedDayBucketTables.length > 0 || hasRoutinesPayload) {
    for (const dt of dates) {
      const day: Record<string, unknown> = {};
      for (const t of selectedDayBucketTables) {
        day[t] = [];
      }
      if (hasRoutinesPayload) {
        day.routines = buildRoutinesForDay(data, lu, dt);
      }
      result[dt] = day;
    }
  }

  for (const [table, rows] of Object.entries(data)) {
    if (routineSourceKeys.has(table)) continue;

    if (!isDayBucketTableListedSeparately(table)) continue;
    if (selectedDayBucketTables.length === 0) continue;

    for (const row of rows) {
      const r = row as Row;
      const sd = calendarDayForRow(table, r);
      if (!sd || !dateSet.has(sd)) continue;
      const enriched = enrichAndStrip(table, r, lu);
      if (!enriched) continue;
      const dayObj = result[sd] as Record<string, unknown>;
      if (!Array.isArray(dayObj[table])) dayObj[table] = [];
      (dayObj[table] as unknown[]).push(enriched);
    }
  }

  return result;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

export function buildDataContext(data: TableData, range: DateRange): string {
  const payload = buildDayKeyedData(data, range);
  const header =
    `## Datos del ${range.start} al ${range.end} ` +
    `(JSON agrupado por día; IDs reemplazados por nombres; sin ruido)\n`;
  return `${header}\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

export const AI_CHAT_SYSTEM_SUFFIX =
  "Los datos están en JSON: claves `YYYY-MM-DD` para días del rango (sin repetir la fecha en cada fila). " +
  "Horarios de bloques como `HH:MM` en zona America/Caracas (instantes ISO convertidos; `time` de rutina sin TZ se copia tal cual). " +
  "IDs reemplazados por nombres legibles (habit, task, task_type). " +
  "En cada día, `routines` es la rutina aplicada ese día (nombre, tareas y bloques) o null si no hubo.\n\n";

export function buildChatSystemPromptFromData(data: TableData, range: DateRange): string {
  return (
    AI_CHAT_SYSTEM_SUFFIX +
    `\`\`\`json\n${JSON.stringify(buildDayKeyedData(data, range), null, 2)}\n\`\`\``
  );
}

const DEFAULT_CUSTOM_WHEN_EMPTY =
  "Analiza estos datos y ofrece un resumen breve en español con los hallazgos más relevantes y, si aplica, 2–3 recomendaciones concretas.";

export function buildCustomPrompt(data: TableData, range: DateRange, userPrompt: string): string {
  const instructions = userPrompt.trim() || DEFAULT_CUSTOM_WHEN_EMPTY;
  return (
    `## Instrucciones del usuario\n${instructions}\n\n` +
    buildDataContext(data, range)
  );
}

/**
 * System prompt for tool-based flow. Claude queries the DB on demand instead
 * of receiving a pre-built JSON blob.
 */
export function buildToolSystemPrompt(
  range: DateRange,
  tables: AnalyzableTable[],
  userInstructions?: string,
): string {
  const tableList = tables
    .map((k) => {
      const label = ANALYZABLE_TABLES.find((t) => t.key === k)?.label ?? k;
      return `- \`${k}\` (${label})`;
    })
    .join("\n");

  const instructions = userInstructions?.trim()
    ? `\n\n## Instrucciones del usuario\n${userInstructions.trim()}`
    : "";

  return (
    "Eres un asistente de productividad personal. Responde siempre en español. " +
    "Usa Markdown para formatear tu respuesta. Sé conciso pero completo.\n\n" +
    `## Contexto\n` +
    `Rango de fechas: ${range.start} al ${range.end}.\n` +
    `Tablas disponibles para consultar:\n${tableList}\n\n` +
    "Usa las herramientas `query_table` y `query_lookup_catalogs` para obtener los datos " +
    "que necesites antes de responder. Los horarios de bloques están en zona America/Caracas. " +
    "IDs de tipos se resuelven con `query_lookup_catalogs`." +
    instructions
  );
}

