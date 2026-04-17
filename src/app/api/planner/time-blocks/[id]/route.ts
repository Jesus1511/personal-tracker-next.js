import { NextRequest, NextResponse } from "next/server";

import { assertIsoDateTime, normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { ensureNoTimeOverlap } from "@/lib/planner/time-blocks";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type EntryType = "task" | "habit";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function validateTarget(entryType: EntryType, taskId?: string | null, habitTypeId?: string | null) {
  if (entryType === "task" && !taskId) throw new Error("taskId is required for task blocks.");
  if (entryType === "habit" && !habitTypeId) {
    throw new Error("habitTypeId is required for habit blocks.");
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      scheduledDate?: string;
      startAt?: string;
      endAt?: string;
      entryType?: EntryType;
      taskId?: string | null;
      habitTypeId?: string | null;
      notes?: string | null;
    };

    const supabase = getSupabaseAdminClient();
    const { data: current, error: currentError } = await supabase
      .from("time_blocks")
      .select("*")
      .eq("id", id)
      .single();

    if (currentError) throw new Error(currentError.message);
    if (!current) throw new Error("Time block not found.");

    const entryType = body.entryType ?? (current.entry_type as EntryType);
    const scheduledDate = normalizeDate(body.scheduledDate ?? current.scheduled_date);
    const startAt = body.startAt ?? current.start_at;
    const endAt = body.endAt ?? current.end_at;
    const taskId = "taskId" in body ? body.taskId ?? null : current.task_id;
    const habitTypeId = "habitTypeId" in body ? body.habitTypeId ?? null : current.habit_type_id;

    assertIsoDateTime(startAt, "startAt");
    assertIsoDateTime(endAt, "endAt");
    if (new Date(endAt) <= new Date(startAt)) {
      throw new Error("endAt must be greater than startAt.");
    }

    validateTarget(entryType, taskId, habitTypeId);
    await ensureNoTimeOverlap({
      scheduledDate,
      startAt,
      endAt,
      excludeId: id,
    });

    const { data, error } = await supabase
      .from("time_blocks")
      .update({
        scheduled_date: scheduledDate,
        start_at: startAt,
        end_at: endAt,
        entry_type: entryType,
        task_id: entryType === "task" ? taskId : null,
        habit_type_id: entryType === "habit" ? habitTypeId : null,
        notes: "notes" in body ? body.notes ?? null : current.notes,
      })
      .eq("id", id)
      .select("*, task:tasks(*, task_type:task_types(*)), habit_type:habit_types(*)")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ timeBlock: data });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.from("time_blocks").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
