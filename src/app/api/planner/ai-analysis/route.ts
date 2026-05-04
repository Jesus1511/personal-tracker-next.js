import { NextRequest, NextResponse } from "next/server";

import {
  attachAnalysisLookupCatalogs,
  expandTablesForFetch,
  fetchAnalysisTableRows,
  resolveAppliedRoutineIdsForAnalysis,
} from "@/lib/gemini/fetch-analysis-table-rows";
import { generateContent } from "@/lib/gemini/client";
import { parseClaudeModelFromBody } from "@/lib/gemini/claude-models";
import { buildCustomPrompt } from "@/lib/gemini/prompts";
import { filterAnalyzableTableKeys } from "@/lib/gemini/types";
import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      dateStart?: string;
      dateEnd?: string;
      tables?: string[];
      promptType?: string;
      customPrompt?: string;
      model?: string;
    };

    const dateStart = normalizeDate(body.dateStart);
    const dateEnd = normalizeDate(body.dateEnd);
    const tables = filterAnalyzableTableKeys(body.tables ?? []);
    const customPrompt = body.customPrompt?.trim() ?? "";
    const model = parseClaudeModelFromBody(body.model);

    if (tables.length === 0) {
      throw new Error("Selecciona al menos una tabla para analizar.");
    }

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
    const prompt = buildCustomPrompt(tableData, range, customPrompt);

    let responseText: string | null = null;
    let status: "completed" | "failed" = "completed";
    let failureReason: string | null = null;

    try {
      const result = await generateContent({ prompt, model });
      responseText = result.text;
    } catch (err) {
      status = "failed";
      failureReason =
        err instanceof Error ? err.message : "Unknown Claude error";
    }

    const { data, error } = await supabase
      .from("ai_analyses")
      .insert({
        date_start: dateStart,
        date_end: dateEnd,
        tables_analyzed: tables,
        prompt_type: "custom",
        prompt_text: prompt,
        response_text: responseText,
        status,
        failure_reason: failureReason,
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ analysis: data }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const limit = Math.min(Number(sp.get("limit")) || 20, 100);
    const offset = Number(sp.get("offset")) || 0;

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("ai_analyses")
      .select("*")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(error.message);
    return NextResponse.json({ analyses: data ?? [] });
  } catch (error) {
    return apiError(error);
  }
}
