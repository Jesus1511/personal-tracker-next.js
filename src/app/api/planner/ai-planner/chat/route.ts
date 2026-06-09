import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

import { streamWithToolsAgentic } from "@/lib/gemini/client";
import { parseClaudeModelFromBody } from "@/lib/gemini/claude-models";
import { PLANNER_TOOLS, executeDbTool } from "@/lib/gemini/db-tools";
import {
  PLANNER_WRITE_TOOLS,
  executePlannerWriteTool,
  isPlanActionResult,
  type WriteMode,
} from "@/lib/gemini/planner-tools";
import { ANALYZABLE_TABLES } from "@/lib/gemini/types";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type ChatRole = "user" | "assistant";

function sanitizeMessages(raw: unknown): Anthropic.MessageParam[] {
  if (!Array.isArray(raw)) throw new Error("messages debe ser un array.");
  const out: Anthropic.MessageParam[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || !content.trim()) continue;
    out.push({ role: role as ChatRole, content: content.trim() });
  }
  if (out.length === 0) throw new Error("Escribe al menos un mensaje.");
  const last = out[out.length - 1];
  if (!last || last.role !== "user") throw new Error("El último mensaje debe ser del usuario.");
  return out;
}

function buildPlannerSystemPrompt(mode: WriteMode, aiContext?: string): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Caracas" });
  const tableList = ANALYZABLE_TABLES.map(({ key, label }) => `- \`${key}\` (${label})`).join("\n");
  const writeToolList = PLANNER_WRITE_TOOLS.map(
    (t) => `- \`${t.name}\`: ${(t.description as string).split(".")[0]}`,
  ).join("\n");

  const modeInstructions =
    mode === "plan"
      ? "Estás en **MODO PLAN**. Usa las herramientas de escritura para proponer acciones — " +
        "el usuario las revisará y ejecutará cuando confirme. Agrupa varias acciones coherentes. " +
        "Explica brevemente tu plan antes de usar las herramientas."
      : "Estás en **MODO AGENTE**. Ejecuta las acciones directamente con las herramientas de escritura " +
        "sin pedir confirmación. Informa qué hiciste después de cada acción.";

  const contextSection =
    aiContext?.trim()
      ? `\n\n## Tu contexto personal\n${aiContext.trim()}\n` +
        "_Puedes reescribir este documento con `update_ai_context` si aprendes algo fundamental o cambian actividades o proyectos habituales. Haz cambios mínimos y concisos, y avisa brevemente cuando lo actualices._"
      : "\n\n## Tu contexto personal\n_(vacío — usa `update_ai_context` para guardar información relevante sobre el usuario)_";

  return (
    "Eres un asistente de planificación personal. Responde siempre en español. " +
    "Usa Markdown para formatear. Sé conciso pero completo.\n\n" +
    `## Contexto\nHoy es ${today} (zona America/Caracas).\n\n` +
    `## Herramientas de lectura\nTablas disponibles:\n${tableList}\n` +
    "Usa `query_table` y `query_lookup_catalogs` para leer datos antes de actuar.\n\n" +
    `## Herramientas de escritura\n${writeToolList}\n\n` +
    `## Modo actual\n${modeInstructions}` +
    contextSection
  );
}

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      messages?: unknown;
      mode?: string;
      model?: string;
      aiContext?: string;
    };

    const messages = sanitizeMessages(body.messages);
    const mode: WriteMode = body.mode === "agent" ? "agent" : "plan";
    const model = parseClaudeModelFromBody(body.model);
    const aiContext = typeof body.aiContext === "string" ? body.aiContext : undefined;
    const supabase = getSupabaseAdminClient();
    const system = buildPlannerSystemPrompt(mode, aiContext);
    const allTools = [...PLANNER_TOOLS, ...PLANNER_WRITE_TOOLS];
    const encoder = new TextEncoder();

    // Collect PLAN/EXEC events produced by the tool executor so we can inject
    // them into the output stream right after the corresponding \x01TOOL: chunk.
    const sideChannel: Uint8Array[] = [];

    const agentStream = streamWithToolsAgentic({
      system,
      messages,
      tools: allTools,
      model,
      toolExecutor: async (toolName, input) => {
        if (toolName === "query_table" || toolName === "query_lookup_catalogs") {
          return executeDbTool(supabase, toolName, input);
        }

        const result = await executePlannerWriteTool(supabase, mode, toolName, input);

        if (isPlanActionResult(result)) {
          sideChannel.push(encoder.encode(`\x01PLAN:${JSON.stringify(result.__planAction)}\n`));
          return {
            status: "queued",
            label: result.__planAction.label,
            message: "Acción agregada al plan. El usuario decidirá cuándo ejecutarla.",
          };
        }

        // update_ai_context always executes — notify client to reload context
        if (toolName === "update_ai_context") {
          sideChannel.push(encoder.encode(`\x01CTX_UPDATED\n`));
        } else {
          // Agent mode: emit EXEC event for UI feedback
          const execPayload = { toolName, result };
          sideChannel.push(encoder.encode(`\x01EXEC:${JSON.stringify(execPayload)}\n`));
        }
        return result;
      },
    });

    // Merge agentStream with sideChannel events.
    // sideChannel is populated inside the tool executor, which runs synchronously
    // within streamWithToolsAgentic's pump between chunks. By flushing sideChannel
    // BEFORE writing each new chunk, the PLAN/EXEC events appear immediately after
    // the corresponding \x01TOOL: marker.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    void (async () => {
      const reader = agentStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Flush any side-channel events that arrived while awaiting this chunk
          while (sideChannel.length > 0) {
            await writer.write(sideChannel.shift()!);
          }
          await writer.write(value);
        }
        while (sideChannel.length > 0) {
          await writer.write(sideChannel.shift()!);
        }
      } finally {
        await writer.close().catch(() => { /* already closed */ });
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        Vary: "Accept-Encoding",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
