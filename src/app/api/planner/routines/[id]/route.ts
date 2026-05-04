import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdminClient();

    const { data: routine, error: rErr } = await supabase
      .from("daily_routines")
      .select("id, name, description, created_at, updated_at")
      .eq("id", id)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    if (!routine) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const { data: tasks, error: tErr } = await supabase
      .from("daily_routine_tasks")
      .select("id, title, notes, points, task_type_id, sort_order")
      .eq("routine_id", id)
      .order("sort_order", { ascending: true });
    if (tErr) throw new Error(tErr.message);

    const { data: blocks, error: bErr } = await supabase
      .from("daily_routine_time_blocks")
      .select(
        "id, entry_type, start_time, end_time, routine_task_id, habit_type_id, notes, sort_order",
      )
      .eq("routine_id", id)
      .order("sort_order", { ascending: true });
    if (bErr) throw new Error(bErr.message);

    return NextResponse.json({
      routine: {
        ...routine,
        tasks: tasks ?? [],
        time_blocks: blocks ?? [],
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      name?: string;
      description?: string | null;
    };

    const payload: {
      name?: string;
      description?: string | null;
      updated_at: string;
    } = {
      updated_at: new Date().toISOString(),
    };
    if (typeof body.name === "string") {
      const n = body.name.trim();
      if (!n) throw new Error("Name cannot be empty.");
      payload.name = n;
    }
    if ("description" in body) payload.description = body.description ?? null;

    const dataKeys = Object.keys(payload).filter((k) => k !== "updated_at");
    if (dataKeys.length === 0) throw new Error("No fields provided.");

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("daily_routines")
      .update(payload)
      .eq("id", id)
      .select("id, name, description, created_at, updated_at")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ routine: data });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.from("daily_routines").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
