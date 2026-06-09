import { NextRequest, NextResponse } from "next/server";

import { streamWithToolsAgentic } from "@/lib/gemini/client";
import { parseClaudeModelFromBody } from "@/lib/gemini/claude-models";
import { PLANNER_TOOLS, executeDbTool } from "@/lib/gemini/db-tools";
import { buildToolSystemPrompt } from "@/lib/gemini/prompts";
import { ANALYZABLE_TABLE_KEYS } from "@/lib/gemini/types";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const TOOL_EVENT_RE = /\x01TOOL:[^\n]*\n/g;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      promptType?: string;
      customPrompt?: string;
      model?: string;
    };

    const customPrompt = body.customPrompt?.trim() ?? "";
    const model = parseClaudeModelFromBody(body.model);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });

    const supabase = getSupabaseAdminClient();
    const system = buildToolSystemPrompt(customPrompt);

    const baseStream = streamWithToolsAgentic({
      system,
      messages: [
        {
          role: "user",
          content:
            customPrompt ||
            "Analiza mis datos de esta semana y ofrece un resumen breve en español con los hallazgos más relevantes y, si aplica, 2–3 recomendaciones concretas.",
        },
      ],
      tools: PLANNER_TOOLS,
      toolExecutor: (name, input) => executeDbTool(supabase, name, input),
      model,
    });

    // Tee: one copy streams to client, one collects text for DB save
    const [clientStream, saveStream] = baseStream.tee();

    void (async () => {
      try {
        const reader = saveStream.getReader();
        const dec = new TextDecoder();
        let raw = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += dec.decode(value, { stream: true });
        }
        raw += dec.decode();
        const responseText = raw.replace(TOOL_EVENT_RE, "").trim();
        await supabase.from("ai_analyses").insert({
          date_start: today,
          date_end: today,
          tables_analyzed: [...ANALYZABLE_TABLE_KEYS],
          prompt_type: "custom",
          prompt_text: system,
          response_text: responseText,
          status: "completed",
          failure_reason: null,
        });
      } catch {
        /* ignore background save errors */
      }
    })();

    return new Response(clientStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Vary: "Accept-Encoding",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
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
