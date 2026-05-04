import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { replaceRoutineFromDay } from "@/lib/planner/daily-routines";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("daily_routines")
      .select("id, name, description, updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return NextResponse.json({ routines: data ?? [] });
  } catch (error) {
    return apiError(error);
  }
}

/** POST body: { name?, description?, sourceDate } — new routine snapshot from planned day */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      name?: string;
      description?: string | null;
      sourceDate?: string;
    };

    const sourceDate = normalizeDate(body.sourceDate);
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : `Rutina ${sourceDate}`;
    const description =
      "description" in body
        ? body.description == null
          ? null
          : String(body.description)
        : null;

    const supabase = getSupabaseAdminClient();
    const now = new Date().toISOString();
    const { data: routine, error } = await supabase
      .from("daily_routines")
      .insert({
        name,
        description: description ?? null,
        updated_at: now,
      })
      .select("id, name, description, created_at, updated_at")
      .single();

    if (error) throw new Error(error.message);

    await replaceRoutineFromDay(routine.id, sourceDate);

    const { data: refreshed, error: refErr } = await supabase
      .from("daily_routines")
      .select("id, name, description, created_at, updated_at")
      .eq("id", routine.id)
      .single();
    if (refErr) throw new Error(refErr.message);

    return NextResponse.json({ routine: refreshed }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
