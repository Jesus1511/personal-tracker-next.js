import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { replaceRoutineFromDay } from "@/lib/planner/daily-routines";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** PUT body: { date } — overwrite template from this day's planned tasks + blocks */
export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { date?: string };
    const date = normalizeDate(body.date);
    const supabase = getSupabaseAdminClient();

    const { data: exists, error: exErr } = await supabase
      .from("daily_routines")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (exErr) throw new Error(exErr.message);
    if (!exists) return NextResponse.json({ error: "Routine not found." }, { status: 404 });

    await replaceRoutineFromDay(id, date);

    const { data: routine, error } = await supabase
      .from("daily_routines")
      .select("id, name, description, created_at, updated_at")
      .eq("id", id)
      .single();
    if (error) throw new Error(error.message);

    return NextResponse.json({ routine });
  } catch (error) {
    return apiError(error);
  }
}
