import { NextRequest, NextResponse } from "next/server";

import { addCalendarDays, normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const SELECT_ACTUAL = "*, task:tasks(*, task_type:task_types(*))";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** Clampa un entero a [min, max]. NaN/undefined ⇒ fallback. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id: taskId } = await context.params;
    const body = (await request.json()) as {
      rizeEntryId?: string;
      /** Día de la tarea (debe coincidir con `tasks.scheduled_date`). */
      scheduledDate?: string;
      /** Día en que está el `actual_task_block` de Rize (p. ej. día anterior para tarea hija/rollover). */
      blockScheduledDate?: string;
      pointsCompleted?: number;
    };

    if (!body.rizeEntryId?.trim()) {
      throw new Error("rizeEntryId is required.");
    }

    const supabase = getSupabaseAdminClient();
    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("id, scheduled_date, points, parent_task_id")
      .eq("id", taskId)
      .single();

    if (taskError) throw new Error(taskError.message);
    if (!task) throw new Error("Task not found.");

    const taskDay = String(task.scheduled_date).slice(0, 10);
    if (body.scheduledDate) {
      const sd = normalizeDate(body.scheduledDate);
      if (sd !== taskDay) {
        throw new Error("scheduledDate debe ser el mismo día de la tarea.");
      }
    }

    const prevDay = addCalendarDays(taskDay, -1);
    let blockDate: string;
    if (body.blockScheduledDate?.trim()) {
      blockDate = normalizeDate(body.blockScheduledDate);
      const allowed = new Set<string>([taskDay]);
      if (task.parent_task_id) {
        allowed.add(prevDay);
      }
      if (!allowed.has(blockDate)) {
        throw new Error("blockScheduledDate no permitido para esta tarea.");
      }
    } else {
      blockDate = taskDay;
    }

    const rizeId = body.rizeEntryId.trim();
    const { data: syncedBlock, error: syncedError } = await supabase
      .from("actual_task_blocks")
      .select("rize_entry_id, start_at, end_at, rize_title, points_completed")
      .eq("scheduled_date", blockDate)
      .eq("rize_entry_id", rizeId)
      .maybeSingle();

    if (syncedError) throw new Error(syncedError.message);
    if (!syncedBlock) {
      throw new Error(
        "Ese bloque no está en Supabase para ese día. Sincroniza el calendario (⟳) y vuelve a intentar.",
      );
    }

    const { data: plannedRows, error: plannedError } = await supabase
      .from("time_blocks")
      .select("id")
      .eq("scheduled_date", taskDay)
      .eq("entry_type", "task")
      .eq("task_id", taskId)
      .order("start_at", { ascending: true })
      .limit(1);

    if (plannedError) throw new Error(plannedError.message);
    const plannedBlockId = plannedRows?.[0]?.id ?? null;

    // Puntos en todos los días (vinculación en día distinto al de la tarea).
    const { data: existingBlocks, error: existingError } = await supabase
      .from("actual_task_blocks")
      .select("rize_entry_id, points_completed")
      .eq("task_id", taskId);
    if (existingError) throw new Error(existingError.message);

    const pointsDoneOthers = (existingBlocks ?? [])
      .filter((b) => b.rize_entry_id !== rizeId)
      .reduce((s, b) => s + (b.points_completed ?? 0), 0);

    const totalPoints = Math.max(0, task.points ?? 0);
    const remaining = Math.max(0, totalPoints - pointsDoneOthers);
    const requested = clampInt(body.pointsCompleted, 0, totalPoints, remaining);
    // Aunque totalPoints sea 0, permito marcar la tarea hecha con este bloque (UX: tareas sin puntos).
    const pointsCompleted = totalPoints === 0 ? 0 : Math.min(requested, remaining);

    const rizeTitle = syncedBlock.rize_title?.trim() || "Sin título";
    const updatePayload = {
      scheduled_date: blockDate,
      start_at: syncedBlock.start_at,
      end_at: syncedBlock.end_at,
      task_id: taskId,
      planned_block_id: plannedBlockId,
      rize_title: rizeTitle,
      user_completion_link: true,
      points_completed: pointsCompleted,
      source: "rize" as const,
      updated_at: new Date().toISOString(),
    };
    // No usar upsert(onConflict: rize_entry_id): un índice único PARCIAL no satisface ON CONFLICT en Postgres.
    const { data: updatedRows, error: updateError } = await supabase
      .from("actual_task_blocks")
      .update(updatePayload)
      .eq("rize_entry_id", rizeId)
      .select("id");
    if (updateError) throw new Error(updateError.message);
    if (!updatedRows?.length) {
      const { error: insertError } = await supabase.from("actual_task_blocks").insert({
        ...updatePayload,
        rize_entry_id: syncedBlock.rize_entry_id,
      });
      if (insertError) throw new Error(insertError.message);
    }

    // Marco la tarea como hecha solo si acumuló todos sus puntos (o si la tarea no tenía puntos).
    const newPointsDone = pointsDoneOthers + pointsCompleted;
    const shouldMarkDone = totalPoints === 0 || newPointsDone >= totalPoints;
    if (shouldMarkDone) {
      const { error: updateTaskError } = await supabase
        .from("tasks")
        .update({ done: true, updated_at: new Date().toISOString() })
        .eq("id", taskId);
      if (updateTaskError) throw new Error(updateTaskError.message);
    }

    const [{ data: taskOut, error: taskOutError }, { data: actualRow, error: actualError }] =
      await Promise.all([
        supabase.from("tasks").select("*, task_type:task_types(*)").eq("id", taskId).single(),
        supabase
          .from("actual_task_blocks")
          .select(SELECT_ACTUAL)
          .eq("rize_entry_id", rizeId)
          .single(),
      ]);

    if (taskOutError) throw new Error(taskOutError.message);
    if (actualError) throw new Error(actualError.message);

    // Devuelvo la tarea con points_done ya calculado para que el cliente actualice el badge sin otro fetch.
    const taskWithProgress = { ...taskOut, points_done: newPointsDone };

    return NextResponse.json({ task: taskWithProgress, actualTaskBlock: actualRow });
  } catch (error) {
    return apiError(error);
  }
}
