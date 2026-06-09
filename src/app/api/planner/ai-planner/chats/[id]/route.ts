import { NextRequest, NextResponse } from "next/server";

import { isAllowedClaudeModelId } from "@/lib/gemini/claude-models";
import type { PlanAction } from "@/lib/gemini/planner-tools";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

import type { PlannerChatMessage, PlannerChatRecord } from "../route";

type RouteContext = { params: Promise<{ id: string }> };

function titleFromMessages(messages: PlannerChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first?.content.trim()) return "Nueva conversación";
  const line = first.content.trim().split("\n")[0] ?? "";
  const clean = line.replace(/^#+\s*/, "");
  return clean.length > 56 ? `${clean.slice(0, 54)}…` : clean;
}

/** GET /api/planner/ai-planner/chats/[id] */
export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("planner_chats")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: "Chat no encontrado" }, { status: 404 });
    return NextResponse.json({ chat: data as PlannerChatRecord });
  } catch (error) {
    return apiError(error);
  }
}

/** PATCH /api/planner/ai-planner/chats/[id] */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      title?: string;
      mode?: string;
      model?: string;
      messages?: PlannerChatMessage[];
      plan_actions?: PlanAction[];
    };

    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (typeof body.title === "string" && body.title.trim()) {
      payload.title = body.title.trim();
    }
    if (body.mode === "plan" || body.mode === "agent") payload.mode = body.mode;
    if (typeof body.model === "string" && isAllowedClaudeModelId(body.model)) {
      payload.model = body.model;
    }
    if (Array.isArray(body.messages)) {
      payload.messages = body.messages;
      if (!body.title) payload.title = titleFromMessages(body.messages);
    }
    if (Array.isArray(body.plan_actions)) payload.plan_actions = body.plan_actions;

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("planner_chats")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ chat: data as PlannerChatRecord });
  } catch (error) {
    return apiError(error);
  }
}

/** DELETE /api/planner/ai-planner/chats/[id] */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.from("planner_chats").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
