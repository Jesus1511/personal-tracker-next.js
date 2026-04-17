import { NextRequest, NextResponse } from "next/server";

import { generateContent } from "@/lib/gemini/client";
import { buildCustomPrompt } from "@/lib/gemini/prompts";
import type { AnalyzableTable } from "@/lib/gemini/types";
import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const DATE_FILTERABLE: Set<string> = new Set([
  "tasks",
  "time_blocks",
  "actual_task_blocks",
  "actual_habit_blocks",
]);

async function fetchTableData(
  table: AnalyzableTable,
  dateStart: string,
  dateEnd: string,
) {
  const supabase = getSupabaseAdminClient();

  if (DATE_FILTERABLE.has(table)) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .gte("scheduled_date", dateStart)
      .lte("scheduled_date", dateEnd);
    if (error) throw new Error(`Error querying ${table}: ${error.message}`);
    return data ?? [];
  }

  const { data, error } = await supabase.from(table).select("*");
  if (error) throw new Error(`Error querying ${table}: ${error.message}`);
  return data ?? [];
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      dateStart?: string;
      dateEnd?: string;
      tables?: string[];
      promptType?: string;
      customPrompt?: string;
    };

    const dateStart = normalizeDate(body.dateStart);
    const dateEnd = normalizeDate(body.dateEnd);
    const tables = (body.tables ?? []) as AnalyzableTable[];
    const customPrompt = body.customPrompt?.trim() ?? "";

    if (tables.length === 0) {
      throw new Error("Selecciona al menos una tabla para analizar.");
    }

    const tableData: Record<string, unknown[]> = {};
    await Promise.all(
      tables.map(async (t) => {
        tableData[t] = await fetchTableData(t, dateStart, dateEnd);
      }),
    );

    const range = { start: dateStart, end: dateEnd };
    const prompt = buildCustomPrompt(tableData, range, customPrompt);

    const supabase = getSupabaseAdminClient();
    let responseText: string | null = null;
    let status: "completed" | "failed" = "completed";
    let failureReason: string | null = null;

    try {
      const result = await generateContent({ prompt });
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
