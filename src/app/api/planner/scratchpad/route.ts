import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const ALLOWED_IDS = new Set(["singleton", "ai_context"]);
const DEFAULT_ID = "singleton";

function resolveId(raw: string | null | undefined): string {
  const id = (raw ?? "").trim() || DEFAULT_ID;
  return ALLOWED_IDS.has(id) ? id : DEFAULT_ID;
}

/** GET /api/planner/scratchpad?id=singleton|ai_context */
export async function GET(request: NextRequest) {
  try {
    const id = resolveId(request.nextUrl.searchParams.get("id"));
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("scratchpad")
      .select("content, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return NextResponse.json({
      content: data?.content ?? "",
      updatedAt: data?.updated_at ?? null,
    });
  } catch (error) {
    return apiError(error);
  }
}

/** PUT /api/planner/scratchpad  body: { content: string, id?: string } */
export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as { content?: unknown; id?: unknown };
    if (typeof body.content !== "string") {
      throw new Error("content must be a string");
    }
    const id = resolveId(typeof body.id === "string" ? body.id : null);

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("scratchpad")
      .upsert(
        { id, content: body.content, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      )
      .select("content, updated_at")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({
      content: data.content,
      updatedAt: data.updated_at,
    });
  } catch (error) {
    return apiError(error);
  }
}
