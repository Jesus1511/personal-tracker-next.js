import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { name?: string; color?: string | null };

    const payload: { name?: string; color?: string | null } = {};
    if (typeof body.name === "string") {
      const normalized = body.name.trim();
      if (!normalized) throw new Error("Task type name cannot be empty.");
      payload.name = normalized;
    }
    if ("color" in body) {
      payload.color = body.color ?? null;
    }

    if (Object.keys(payload).length === 0) {
      throw new Error("No fields provided.");
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("task_types")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ taskType: data });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.from("task_types").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
