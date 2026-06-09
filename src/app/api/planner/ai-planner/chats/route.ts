import { NextRequest, NextResponse } from "next/server";

import { isAllowedClaudeModelId } from "@/lib/gemini/claude-models";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export type PlannerChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type PlannerChatRecord = {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  mode: "plan" | "agent";
  model: string;
  messages: PlannerChatMessage[];
  plan_actions: unknown[];
};

function titleFromText(text: string): string {
  const line = text.trim().split("\n")[0] ?? "Nueva conversación";
  const clean = line.replace(/^#+\s*/, "");
  return clean.length > 56 ? `${clean.slice(0, 54)}…` : clean || "Nueva conversación";
}

/** GET /api/planner/ai-planner/chats?limit=50 */
export async function GET(request: NextRequest) {
  try {
    const limit = Math.min(Number(request.nextUrl.searchParams.get("limit")) || 50, 100);
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("planner_chats")
      .select("id, created_at, updated_at, title, mode, model, messages")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);

    const chats = (data ?? []).map((row) => ({
      id: row.id as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      title: row.title as string,
      mode: row.mode as "plan" | "agent",
      model: row.model as string,
      message_count: Array.isArray(row.messages) ? row.messages.length : 0,
    }));

    return NextResponse.json({ chats });
  } catch (error) {
    return apiError(error);
  }
}

/** POST /api/planner/ai-planner/chats  body: { title?, mode?, model?, messages? } */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      title?: string;
      mode?: string;
      model?: string;
      messages?: unknown;
    };

    const mode = body.mode === "agent" ? "agent" : "plan";
    const model =
      typeof body.model === "string" && isAllowedClaudeModelId(body.model)
        ? body.model
        : "claude-sonnet-4-6";

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const firstUser = messages.find(
      (m) =>
        m &&
        typeof m === "object" &&
        (m as { role?: string }).role === "user" &&
        typeof (m as { content?: string }).content === "string",
    ) as { content: string } | undefined;

    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : firstUser
          ? titleFromText(firstUser.content)
          : "Nueva conversación";

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("planner_chats")
      .insert({
        title,
        mode,
        model,
        messages,
        plan_actions: [],
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ chat: data as PlannerChatRecord }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
