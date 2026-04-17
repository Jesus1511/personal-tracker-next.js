import { NextRequest, NextResponse } from "next/server";

import { assertIsoDateTime, normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { ensureNoTimeOverlap } from "@/lib/planner/time-blocks";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type EntryType = "task" | "habit";

function validateTarget(entryType: EntryType, taskId?: string | null, habitTypeId?: string | null) {
  if (entryType === "habit" && !habitTypeId) {
    throw new Error("habitTypeId is required for habit blocks.");
  }
  void taskId; // task_id is optional; allows unassigned task-time placeholders
}

export async function GET(request: NextRequest) {
  try {
    const date = normalizeDate(request.nextUrl.searchParams.get("date"));
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("time_blocks")
      .select("*, task:tasks(*, task_type:task_types(*)), habit_type:habit_types(*)")
      .eq("scheduled_date", date)
      .order("start_at", { ascending: true });

    if (error) throw new Error(error.message);
    return NextResponse.json({ timeBlocks: data ?? [], date });
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
      entryType?: EntryType;
      taskId?: string | null;
      habitTypeId?: string | null;
      notes?: string | null;
    };

    const scheduledDate = normalizeDate(body.scheduledDate);
    if (!body.startAt || !body.endAt || !body.entryType) {
      throw new Error("scheduledDate, startAt, endAt and entryType are required.");
    }
    assertIsoDateTime(body.startAt, "startAt");
    assertIsoDateTime(body.endAt, "endAt");
    if (new Date(body.endAt) <= new Date(body.startAt)) {
      throw new Error("endAt must be greater than startAt.");
    }

    validateTarget(body.entryType, body.taskId, body.habitTypeId);
    await ensureNoTimeOverlap({
      scheduledDate,
      startAt: body.startAt,
      endAt: body.endAt,
    });

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("time_blocks")
      .insert({
        scheduled_date: scheduledDate,
        start_at: body.startAt,
        end_at: body.endAt,
        entry_type: body.entryType,
        task_id: body.entryType === "task" ? body.taskId : null,
        habit_type_id: body.entryType === "habit" ? body.habitTypeId : null,
        notes: body.notes ?? null,
      })
      .select("*, task:tasks(*, task_type:task_types(*)), habit_type:habit_types(*)")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ timeBlock: data }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
