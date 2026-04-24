import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export type DailyGoal = {
  id: string;
  date: string;
  title: string;
  done: boolean;
};

const SELECT_FIELDS = "id, date, title, done, task_type_id, task_type:task_types(id, name, color, contributes_to_main)";

/** GET /api/planner/daily-goals?date=YYYY-MM-DD
 *  GET /api/planner/daily-goals?from=YYYY-MM-DD&to=YYYY-MM-DD  (range, inclusive) */
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabaseAdminClient();
    const { searchParams } = request.nextUrl;

    if (searchParams.has("from") && searchParams.has("to")) {
      const from = normalizeDate(searchParams.get("from"));
      const to = normalizeDate(searchParams.get("to"));
      const { data, error } = await supabase
        .from("daily_goals")
        .select(SELECT_FIELDS)
        .gte("date", from)
        .lte("date", to)
        .order("date", { ascending: true });
      if (error) throw new Error(error.message);
      return NextResponse.json({ dailyGoals: data ?? [] });
    }

    const date = normalizeDate(searchParams.get("date"));
    const { data, error } = await supabase
      .from("daily_goals")
      .select(SELECT_FIELDS)
      .eq("date", date)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return NextResponse.json({ dailyGoal: data ?? null });
  } catch (error) {
    return apiError(error);
  }
}

/** PUT /api/planner/daily-goals  body: { date, title?, done?, taskTypeId? } — upsert */
export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      date?: string;
      title?: string;
      done?: boolean;
      taskTypeId?: string | null;
    };

    const date = normalizeDate(body.date);
    const supabase = getSupabaseAdminClient();

    const { data: existing } = await supabase
      .from("daily_goals")
      .select("id")
      .eq("date", date)
      .maybeSingle();

    if (existing) {
      const payload: {
        title?: string;
        done?: boolean;
        task_type_id?: string | null;
        updated_at: string;
      } = { updated_at: new Date().toISOString() };
      if (typeof body.title === "string") payload.title = body.title;
      if (typeof body.done === "boolean") payload.done = body.done;
      if ("taskTypeId" in body) payload.task_type_id = body.taskTypeId ?? null;

      const { data, error } = await supabase
        .from("daily_goals")
        .update(payload)
        .eq("id", existing.id)
        .select(SELECT_FIELDS)
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ dailyGoal: data });
    }

    const { data, error } = await supabase
      .from("daily_goals")
      .insert({
        date,
        title: typeof body.title === "string" ? body.title : "",
        done: typeof body.done === "boolean" ? body.done : false,
        task_type_id: body.taskTypeId ?? null,
      })
      .select(SELECT_FIELDS)
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ dailyGoal: data }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
