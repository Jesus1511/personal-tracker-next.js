import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

/** GET ?date=YYYY-MM-DD — which routine (if any) is linked to this calendar day */
export async function GET(request: NextRequest) {
  try {
    const date = normalizeDate(request.nextUrl.searchParams.get("date"));
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase
      .from("daily_routine_applications")
      .select("date, routine_id")
      .eq("date", date)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) {
      return NextResponse.json({ application: null });
    }

    if (!data.routine_id) {
      return NextResponse.json({
        application: { date: data.date, routineId: null, routine: null },
      });
    }

    const { data: routine, error: rErr } = await supabase
      .from("daily_routines")
      .select("id, name")
      .eq("id", data.routine_id)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);

    return NextResponse.json({
      application: {
        date: data.date,
        routineId: data.routine_id,
        routine: routine ?? null,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
