import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

import { runWithTools } from "@/lib/gemini/client";
import { parseClaudeModelFromBody } from "@/lib/gemini/claude-models";
import { PLANNER_TOOLS, executeDbTool } from "@/lib/gemini/db-tools";
import { buildToolSystemPrompt } from "@/lib/gemini/prompts";
import { filterAnalyzableTableKeys } from "@/lib/gemini/types";
import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type ChatRole = "user" | "assistant";

function sanitizeMessages(raw: unknown): Anthropic.MessageParam[] {
  if (!Array.isArray(raw)) {
    throw new Error("messages debe ser un array.");
  }
  const out: Anthropic.MessageParam[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || !content.trim()) continue;
    out.push({ role: role as ChatRole, content: content.trim() });
  }
  if (out.length === 0) {
    throw new Error("Escribe al menos un mensaje de usuario.");
  }
  const last = out[out.length - 1];
  if (!last || last.role !== "user") {
    throw new Error("El último mensaje debe ser del usuario.");
  }
  return out;
}

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      dateStart?: string;
      dateEnd?: string;
      tables?: string[];
      messages?: unknown;
      model?: string;
      sendJson?: boolean; // kept for backward compat, ignored
    };

    const dateStart = normalizeDate(body.dateStart);
    const dateEnd = normalizeDate(body.dateEnd);
    const tables = filterAnalyzableTableKeys(body.tables ?? []);
    const messages = sanitizeMessages(body.messages);
    const model = parseClaudeModelFromBody(body.model);

    if (tables.length === 0) {
      throw new Error("Selecciona al menos una tabla para analizar.");
    }

    const supabase = getSupabaseAdminClient();
    const system = buildToolSystemPrompt({ start: dateStart, end: dateEnd }, tables);

    const result = await runWithTools({
      system,
      messages,
      tools: PLANNER_TOOLS,
      toolExecutor: (name, input) => executeDbTool(supabase, tables, name, input),
      model,
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(result.text));
        controller.close();
      },
    });

    return new Response(stream, {
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
