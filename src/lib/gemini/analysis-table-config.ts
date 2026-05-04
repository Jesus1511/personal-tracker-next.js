import type { AnalyzableTable } from "./types";

/** Filas por `scheduled_date`. */
export const SCHEDULED_DATE_TABLES = new Set<AnalyzableTable>([
  "tasks",
  "time_blocks",
  "actual_task_blocks",
  "actual_habit_blocks",
]);

/** Filas por columna calendario `date`. (`daily_routine_applications` no es AnalyzableTable; se consulta aparte.) */
export const PLAIN_DATE_COLUMN_TABLES = new Set<AnalyzableTable>([
  "daily_goals",
  "daily_summaries",
]);

/** Ya no se vuelcan plantillas sueltas en la raíz del JSON; solo en `routines` por día. */
export function isDayBucketTable(t: string): boolean {
  const plain = t === "daily_goals" || t === "daily_summaries";
  const scheduled = SCHEDULED_DATE_TABLES.has(t as AnalyzableTable);
  const appOnly = t === "daily_routine_applications";
  return scheduled || plain || appOnly;
}

export function isDayBucketTableListedSeparately(t: string): boolean {
  return isDayBucketTable(t) && t !== "daily_routine_applications";
}

export function calendarDayForRow(
  table: string,
  row: Record<string, unknown>,
): string | null {
  if (SCHEDULED_DATE_TABLES.has(table as AnalyzableTable)) {
    const v = row.scheduled_date;
    return typeof v === "string" ? v : null;
  }
  if (
    table === "daily_goals" ||
    table === "daily_summaries" ||
    table === "daily_routine_applications"
  ) {
    const v = row.date;
    return typeof v === "string" ? v : null;
  }
  return null;
}
