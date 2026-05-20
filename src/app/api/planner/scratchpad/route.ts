import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const SINGLETON_ID = "singleton";

/** GET /api/planner/scratchpad */
export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("scratchpad")
      .select("content, updated_at")
      .eq("id", SINGLETON_ID)
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

/** PUT /api/planner/scratchpad  body: { content: string } */
export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as { content?: unknown };
    if (typeof body.content !== "string") {
      throw new Error("content must be a string");
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("scratchpad")
      .upsert(
        {
          id: SINGLETON_ID,
          content: body.content,
          updated_at: new Date().toISOString(),
        },
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
