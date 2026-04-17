import { NextRequest, NextResponse } from "next/server";

import { assertIsoDateTime, normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const SELECT_ACTUAL = "*, task:tasks(*, task_type:task_types(*))";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Registra un avance MANUAL (sin Rize) en una tarea: inserta una fila en
 * actual_task_blocks con source='manual' y rize_entry_id=null.
 * Si se pasa `plannedBlockId` usa las horas del bloque planeado;
 * si no, usa `startAt/endAt` del body y como fallback un rango ahora±1min.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id: taskId } = await context.params;
    const body = (await request.json()) as {
      pointsCompleted?: number;
      plannedBlockId?: string | null;
      scheduledDate?: string;
      startAt?: string;
      endAt?: string;
    };

    const supabase = getSupabaseAdminClient();
    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("id, scheduled_date, points")
      .eq("id", taskId)
      .single();
    if (taskError) throw new Error(taskError.message);
    if (!task) throw new Error("Task not found.");

    const date = normalizeDate(body.scheduledDate ?? task.scheduled_date);

    // Resuelvo start/end: prioriza bloque planeado → body → ahora±1min.
    let startAt = body.startAt ?? null;
    let endAt = body.endAt ?? null;
    let plannedBlockId = body.plannedBlockId ?? null;
    if (plannedBlockId) {
      const { data: planned, error: plannedError } = await supabase
        .from("time_blocks")
        .select("id, start_at, end_at, scheduled_date, task_id")
        .eq("id", plannedBlockId)
        .maybeSingle();
      if (plannedError) throw new Error(plannedError.message);
      if (!planned) throw new Error("Planned block not found.");
      if (planned.scheduled_date !== date) {
        throw new Error("plannedBlockId must belong to the same scheduledDate.");
      }
      startAt = planned.start_at;
      endAt = planned.end_at;
    }
    if (!startAt || !endAt) {
      const now = new Date();
      const before = new Date(now.getTime() - 60_000);
      startAt = startAt ?? before.toISOString();
      endAt = endAt ?? now.toISOString();
    }
    assertIsoDateTime(startAt, "startAt");
    assertIsoDateTime(endAt, "endAt");

    // Calculo acumulado previo para no exceder los puntos de la tarea.
    const { data: existingBlocks, error: existingError } = await supabase
      .from("actual_task_blocks")
      .select("points_completed")
      .eq("scheduled_date", date)
      .eq("task_id", taskId);
    if (existingError) throw new Error(existingError.message);

    const pointsDoneOthers = (existingBlocks ?? []).reduce(
      (s, b) => s + (b.points_completed ?? 0),
      0,
    );
    const totalPoints = Math.max(0, task.points ?? 0);
    const remaining = Math.max(0, totalPoints - pointsDoneOthers);
    const requested = clampInt(body.pointsCompleted, 0, totalPoints, remaining);
    const pointsCompleted = totalPoints === 0 ? 0 : Math.min(requested, remaining);

    const row = {
      scheduled_date: date,
      start_at: startAt,
      end_at: endAt,
      task_id: taskId,
      planned_block_id: plannedBlockId,
      rize_entry_id: null,
      rize_title: "",
      user_completion_link: true,
      points_completed: pointsCompleted,
      source: "manual" as const,
    };
    const { data: inserted, error: insertError } = await supabase
      .from("actual_task_blocks")
      .insert(row)
      .select(SELECT_ACTUAL)
      .single();
    if (insertError) throw new Error(insertError.message);

    const newPointsDone = pointsDoneOthers + pointsCompleted;
    const shouldMarkDone = totalPoints === 0 || newPointsDone >= totalPoints;
    if (shouldMarkDone) {
      const { error: updateTaskError } = await supabase
        .from("tasks")
        .update({ done: true, updated_at: new Date().toISOString() })
        .eq("id", taskId);
      if (updateTaskError) throw new Error(updateTaskError.message);
    }

    const { data: taskOut, error: taskOutError } = await supabase
      .from("tasks")
      .select("*, task_type:task_types(*)")
      .eq("id", taskId)
      .single();
    if (taskOutError) throw new Error(taskOutError.message);

    const taskWithProgress = { ...taskOut, points_done: newPointsDone };

    return NextResponse.json({ task: taskWithProgress, actualTaskBlock: inserted });
  } catch (error) {
    return apiError(error);
  }
}
