import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

import { streamContent } from "@/lib/gemini/client";
import { parseClaudeModelFromBody } from "@/lib/gemini/claude-models";
import {
  attachAnalysisLookupCatalogs,
  expandTablesForFetch,
  fetchAnalysisTableRows,
  resolveAppliedRoutineIdsForAnalysis,
} from "@/lib/gemini/fetch-analysis-table-rows";
import {
  AI_CHAT_SYSTEM_SUFFIX,
  buildChatSystemPromptFromData,
} from "@/lib/gemini/prompts";
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

const SYSTEM_PREFIX =
  "Eres un asistente de productividad personal. Responde siempre en español. " +
  "Usa Markdown para formatear tu respuesta. Sé conciso pero completo.\n\n";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      dateStart?: string;
      dateEnd?: string;
      tables?: string[];
      messages?: unknown;
      model?: string;
      sendJson?: boolean;
    };

    const dateStart = normalizeDate(body.dateStart);
    const dateEnd = normalizeDate(body.dateEnd);
    const tables = filterAnalyzableTableKeys(body.tables ?? []);
    const messages = sanitizeMessages(body.messages);
    const model = parseClaudeModelFromBody(body.model);
    const sendJson = body.sendJson === true;

    let system: string;

    if (sendJson) {
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
      system = buildChatSystemPromptFromData(tableData, range);
    } else {
      system = SYSTEM_PREFIX + AI_CHAT_SYSTEM_SUFFIX;
    }

    const stream = streamContent({ messages, system, model });

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
