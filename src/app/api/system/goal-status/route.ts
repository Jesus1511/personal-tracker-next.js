import { NextRequest, NextResponse } from "next/server";

import { plannerDate } from "@/lib/cron/venezuela-time";
import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/system/goal-status?date=YYYY-MM-DD
 *
 * Fallback endpoint for the bootguard watcher when Supabase Realtime is
 * unavailable. Returns whether today's daily goal is completed.
 *
 * Auth: Authorization: Bearer <BOOTGUARD_API_KEY> (env var on the server).
 */
export async function GET(request: NextRequest) {
  try {
    const apiKey = process.env.BOOTGUARD_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Not configured" }, { status: 503 });
    }

    const authHeader = request.headers.get("authorization") ?? "";
    if (authHeader !== `Bearer ${apiKey}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = request.nextUrl;
    const date = searchParams.get("date")
      ? normalizeDate(searchParams.get("date"))
      : plannerDate(new Date());

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("daily_goals")
      .select("done")
      .eq("date", date)
      .maybeSingle();

    if (error) throw new Error(error.message);

    return NextResponse.json({
      date,
      completed: data?.done ?? false,
    });
  } catch (error) {
    return apiError(error);
  }
}
