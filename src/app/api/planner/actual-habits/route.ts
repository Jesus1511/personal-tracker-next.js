import { NextRequest, NextResponse } from "next/server";

import { ensureNoActualHabitOverlap } from "@/lib/planner/actual-habits";
import { assertIsoDateTime, normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const SELECT_WITH_RELATIONS = "*, habit_type:habit_types(*)";

export async function GET(request: NextRequest) {
  try {
    const date = normalizeDate(request.nextUrl.searchParams.get("date"));
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("actual_habit_blocks")
      .select(SELECT_WITH_RELATIONS)
      .eq("scheduled_date", date)
      .order("start_at", { ascending: true });

    if (error) throw new Error(error.message);
    return NextResponse.json({ actualHabitBlocks: data ?? [], date });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      scheduledDate?: string;
      startAt?: string;
      endAt?: string;
      habitTypeId?: string;
      description?: string;
      plannedBlockId?: string | null;
    };

    const scheduledDate = normalizeDate(body.scheduledDate);
    if (!body.startAt || !body.endAt || !body.habitTypeId) {
      throw new Error("scheduledDate, startAt, endAt and habitTypeId are required.");
    }
    assertIsoDateTime(body.startAt, "startAt");
    assertIsoDateTime(body.endAt, "endAt");
    if (new Date(body.endAt) <= new Date(body.startAt)) {
      throw new Error("endAt must be greater than startAt.");
    }

    const description = (body.description ?? "").trim();
    if (!description) {
      throw new Error("description is required.");
    }

    await ensureNoActualHabitOverlap({
      scheduledDate,
      startAt: body.startAt,
      endAt: body.endAt,
    });

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("actual_habit_blocks")
      .insert({
        scheduled_date: scheduledDate,
        start_at: body.startAt,
        end_at: body.endAt,
        habit_type_id: body.habitTypeId,
        description,
        planned_block_id: body.plannedBlockId ?? null,
      })
      .select(SELECT_WITH_RELATIONS)
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ actualHabitBlock: data }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
