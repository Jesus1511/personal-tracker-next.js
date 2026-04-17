import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const SELECT_WITH_RELATIONS = "*, task:tasks(*, task_type:task_types(*))";

export async function GET(request: NextRequest) {
  try {
    const date = normalizeDate(request.nextUrl.searchParams.get("date"));
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("actual_task_blocks")
      .select(SELECT_WITH_RELATIONS)
      .eq("scheduled_date", date)
      .order("start_at", { ascending: true });

    if (error) throw new Error(error.message);
    return NextResponse.json({ actualTaskBlocks: data ?? [], date });
  } catch (error) {
    return apiError(error);
  }
}
