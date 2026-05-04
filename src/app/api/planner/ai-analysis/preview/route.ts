import { NextRequest, NextResponse } from "next/server";

import {
  attachAnalysisLookupCatalogs,
  expandTablesForFetch,
  fetchAnalysisTableRows,
  resolveAppliedRoutineIdsForAnalysis,
} from "@/lib/gemini/fetch-analysis-table-rows";
import { buildDayKeyedData } from "@/lib/gemini/prompts";
import {
  filterAnalyzableTableKeys,
  type AnalyzableTable,
} from "@/lib/gemini/types";
import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

function parseTablesParam(raw: string | null): AnalyzableTable[] {
  if (!raw?.trim()) {
    throw new Error("Indica tablas para la vista previa (CSV en ?tables).");
  }
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const filtered = filterAnalyzableTableKeys(tokens);
  if (filtered.length === 0) {
    throw new Error(
      "Ninguna tabla válida en ?tables (nombres desactualizados o vacíos tras filtrar).",
    );
  }
  return filtered;
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const dateStart = normalizeDate(sp.get("dateStart"));
    const dateEnd = normalizeDate(sp.get("dateEnd"));
    const tables = parseTablesParam(sp.get("tables"));

    const supabase = getSupabaseAdminClient();
    const appliedRoutineIds = await resolveAppliedRoutineIdsForAnalysis(
      supabase,
      tables,
      dateStart,
      dateEnd,
    );
    const fetchKeys = expandTablesForFetch(tables);
    const tableData: Record<string, unknown[]> = {};
    await Promise.all(
      fetchKeys.map(async (t) => {
        tableData[t] = await fetchAnalysisTableRows(
          supabase,
          t,
          dateStart,
          dateEnd,
          { appliedRoutineIds },
        );
      }),
    );
    await attachAnalysisLookupCatalogs(supabase, tableData);

    const range = { start: dateStart, end: dateEnd };
    const payload = buildDayKeyedData(tableData, range);
    const rowsFetched: Record<string, number> = {};
    for (const t of tables) {
      if (t === "routines") {
        rowsFetched.routines = tableData.daily_routine_applications?.length ?? 0;
      } else {
        rowsFetched[t] = tableData[t]?.length ?? 0;
      }
    }

    return NextResponse.json(
      {
        dateStart,
        dateEnd,
        tables,
        rowsFetched,
        payload,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
