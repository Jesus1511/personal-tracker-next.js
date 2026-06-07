import { NextRequest, NextResponse } from "next/server";

import { runWithTools } from "@/lib/gemini/client";
import { parseClaudeModelFromBody } from "@/lib/gemini/claude-models";
import { PLANNER_TOOLS, executeDbTool } from "@/lib/gemini/db-tools";
import { buildToolSystemPrompt } from "@/lib/gemini/prompts";
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
    const system = buildToolSystemPrompt(
      { start: dateStart, end: dateEnd },
      tables,
      customPrompt,
    );

    let responseText: string | null = null;
    let status: "completed" | "failed" = "completed";
    let failureReason: string | null = null;

    try {
      const result = await runWithTools({
        system,
        messages: [
          {
            role: "user",
            content:
              customPrompt ||
              "Analiza estos datos y ofrece un resumen breve en español con los hallazgos más relevantes y, si aplica, 2–3 recomendaciones concretas.",
          },
        ],
        tools: PLANNER_TOOLS,
        toolExecutor: (name, input) => executeDbTool(supabase, tables, name, input),
        model,
      });
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
        prompt_text: system,
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
