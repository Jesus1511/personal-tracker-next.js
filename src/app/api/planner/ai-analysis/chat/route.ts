import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

import { streamWithToolsAgentic } from "@/lib/gemini/client";
import { parseClaudeModelFromBody } from "@/lib/gemini/claude-models";
import { PLANNER_TOOLS, executeDbTool } from "@/lib/gemini/db-tools";
import { buildToolSystemPrompt } from "@/lib/gemini/prompts";
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
      messages?: unknown;
      model?: string;
    };

    const messages = sanitizeMessages(body.messages);
    const model = parseClaudeModelFromBody(body.model);

    const supabase = getSupabaseAdminClient();
    const system = buildToolSystemPrompt();

    const stream = streamWithToolsAgentic({
      system,
      messages,
      tools: PLANNER_TOOLS,
      toolExecutor: (name, input) => executeDbTool(supabase, name, input),
      model,
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
