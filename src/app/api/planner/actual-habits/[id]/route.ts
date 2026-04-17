import { NextRequest, NextResponse } from "next/server";

import { ensureNoActualHabitOverlap } from "@/lib/planner/actual-habits";
import { assertIsoDateTime, normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const SELECT_WITH_RELATIONS = "*, habit_type:habit_types(*)";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      scheduledDate?: string;
      startAt?: string;
      endAt?: string;
      habitTypeId?: string;
      description?: string;
    };

    const supabase = getSupabaseAdminClient();
    const { data: current, error: currentError } = await supabase
      .from("actual_habit_blocks")
      .select("*")
      .eq("id", id)
      .single();

    if (currentError) throw new Error(currentError.message);
    if (!current) throw new Error("Actual habit block not found.");

    const scheduledDate = normalizeDate(body.scheduledDate ?? current.scheduled_date);
    const startAt = body.startAt ?? current.start_at;
    const endAt = body.endAt ?? current.end_at;
    const habitTypeId = body.habitTypeId ?? current.habit_type_id;

    assertIsoDateTime(startAt, "startAt");
    assertIsoDateTime(endAt, "endAt");
    if (new Date(endAt) <= new Date(startAt)) {
      throw new Error("endAt must be greater than startAt.");
    }

    await ensureNoActualHabitOverlap({
      scheduledDate,
      startAt,
      endAt,
      excludeId: id,
    });

    const updates: Record<string, unknown> = {
      scheduled_date: scheduledDate,
      start_at: startAt,
      end_at: endAt,
      habit_type_id: habitTypeId,
    };
    if ("description" in body) {
      updates.description = (body.description ?? "").trim();
    }

    const { data, error } = await supabase
      .from("actual_habit_blocks")
      .update(updates)
      .eq("id", id)
      .select(SELECT_WITH_RELATIONS)
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ actualHabitBlock: data });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.from("actual_habit_blocks").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
