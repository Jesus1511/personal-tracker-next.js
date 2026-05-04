import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import {
  PLAIN_DATE_COLUMN_TABLES,
  SCHEDULED_DATE_TABLES,
} from "./analysis-table-config";
import type { AnalyzableTable } from "./types";

export const ROUTINE_FETCH_TABLES = [
  "daily_routine_applications",
  "daily_routines",
  "daily_routine_tasks",
  "daily_routine_time_blocks",
] as const;

export type RoutineFetchTable = (typeof ROUTINE_FETCH_TABLES)[number];

export type FetchableAnalysisTable =
  | Exclude<AnalyzableTable, "routines">
  | RoutineFetchTable;

const ROUTINE_TEMPLATE_TABLES = new Set<string>([
  "daily_routines",
  "daily_routine_tasks",
  "daily_routine_time_blocks",
]);

/** Tabla aún no creada en Supabase (migración pendiente) — no romper preview/chat. */
function isTableNotInSchema(error: PostgrestError): boolean {
  const m = (error.message ?? "").toLowerCase();
  return (
    m.includes("could not find the table") || m.includes("schema cache")
  );
}

function rowsOrThrow(
  table: string,
  data: unknown[] | null,
  error: PostgrestError | null,
): unknown[] {
  if (!error) return data ?? [];
  if (isTableNotInSchema(error)) {
    console.warn(
      `[fetchAnalysisTableRows] tabla "${table}" no existe en el proyecto; se omite (vacío).`,
    );
    return [];
  }
  throw new Error(`Error querying ${table}: ${error.message}`);
}

export function expandTablesForFetch(
  tables: AnalyzableTable[],
): FetchableAnalysisTable[] {
  const seen = new Set<string>();
  const out: FetchableAnalysisTable[] = [];
  for (const t of tables) {
    if (t === "routines") {
      for (const r of ROUTINE_FETCH_TABLES) {
        if (!seen.has(r)) {
          seen.add(r);
          out.push(r);
        }
      }
    } else {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

/** `routine_id` aplicados en al menos un día del rango (excluye null). */
export async function fetchAppliedRoutineIdsInRange(
  supabase: SupabaseClient,
  dateStart: string,
  dateEnd: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("daily_routine_applications")
    .select("routine_id")
    .gte("date", dateStart)
    .lte("date", dateEnd)
    .not("routine_id", "is", null);

  if (error) {
    if (isTableNotInSchema(error)) return [];
    throw new Error(`Error querying daily_routine_applications: ${error.message}`);
  }
  const ids = new Set<string>();
  for (const row of data ?? []) {
    const id = (row as { routine_id?: unknown }).routine_id;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return [...ids];
}

export async function resolveAppliedRoutineIdsForAnalysis(
  supabase: SupabaseClient,
  tables: AnalyzableTable[],
  dateStart: string,
  dateEnd: string,
): Promise<string[]> {
  if (!tables.includes("routines")) return [];
  return fetchAppliedRoutineIdsInRange(supabase, dateStart, dateEnd);
}

export type FetchAnalysisTableRowsOptions = {
  /** Solo plantillas de rutina usadas en el rango; vacío ⇒ sin filas. */
  appliedRoutineIds?: string[];
};

export async function fetchAnalysisTableRows(
  supabase: SupabaseClient,
  table: FetchableAnalysisTable,
  dateStart: string,
  dateEnd: string,
  options?: FetchAnalysisTableRowsOptions,
): Promise<unknown[]> {
  if (SCHEDULED_DATE_TABLES.has(table as AnalyzableTable)) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .gte("scheduled_date", dateStart)
      .lte("scheduled_date", dateEnd);
    return rowsOrThrow(table, data as unknown[] | null, error);
  }

  if (
    PLAIN_DATE_COLUMN_TABLES.has(table as AnalyzableTable) ||
    table === "daily_routine_applications"
  ) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .gte("date", dateStart)
      .lte("date", dateEnd);
    return rowsOrThrow(table, data as unknown[] | null, error);
  }

  if (ROUTINE_TEMPLATE_TABLES.has(table)) {
    const ids = options?.appliedRoutineIds;
    if (!ids?.length) return [];
    if (table === "daily_routines") {
      const { data, error } = await supabase
        .from(table)
        .select("*")
        .in("id", ids);
      return rowsOrThrow(table, data as unknown[] | null, error);
    }
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .in("routine_id", ids);
    return rowsOrThrow(table, data as unknown[] | null, error);
  }

  throw new Error(`Tabla sin reglas de consulta: ${table}`);
}

/** Catálogo interno para resolver nombres; no aparece como tabla seleccionable. */
export async function attachAnalysisLookupCatalogs(
  supabase: SupabaseClient,
  tableData: Record<string, unknown[]>,
): Promise<void> {
  const mapRows = async (t: string) => {
    const { data, error } = await supabase.from(t).select("*");
    if (!error) return data ?? [];
    if (isTableNotInSchema(error)) {
      console.warn(
        `[attachAnalysisLookupCatalogs] tabla "${t}" omitida: ${error.message}`,
      );
      return [];
    }
    throw new Error(`Error querying ${t}: ${error.message}`);
  };
  const [taskTypes, habitTypes] = await Promise.all([
    mapRows("task_types"),
    mapRows("habit_types"),
  ]);
  tableData.task_types = taskTypes;
  tableData.habit_types = habitTypes;
}
