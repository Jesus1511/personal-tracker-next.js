import { NextRequest, NextResponse } from "next/server";

import { addCalendarDays } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Crea en el día siguiente (respecto a la fecha programada de la tarea) una tarea
 * hija con parent_task_id = tarea origen, puntos = restantes, sin tocar el origen
 * (sigue not done).
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  try {
    const { id: taskId } = await context.params;
    const supabase = getSupabaseAdminClient();

    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("id, title, notes, points, done, task_type_id, scheduled_date, sort_order, parent_task_id")
      .eq("id", taskId)
      .maybeSingle();
    if (taskError) throw new Error(taskError.message);
    if (!task) throw new Error("Tarea no encontrada.");
    if (task.done) throw new Error("Solo se puede pasar una tarea pendiente.");

    const nextDate = addCalendarDays(String(task.scheduled_date).slice(0, 10), 1);

    const { data: existingChild, error: childErr } = await supabase
      .from("tasks")
      .select("id")
      .eq("parent_task_id", taskId)
      .eq("scheduled_date", nextDate)
      .maybeSingle();
    if (childErr) throw new Error(childErr.message);
    if (existingChild) {
      throw new Error("Ya existe una tarea hija en el día siguiente para esta tarea.");
    }

    const total = Math.max(0, task.points ?? 0);
    const { data: blockRows, error: blocksError } = await supabase
      .from("actual_task_blocks")
      .select("points_completed")
      .eq("task_id", taskId)
      .eq("scheduled_date", String(task.scheduled_date).slice(0, 10));
    if (blocksError) throw new Error(blocksError.message);
    let donePts = 0;
    for (const row of blockRows ?? []) {
      donePts += row.points_completed ?? 0;
    }
    const done = Math.min(total, donePts);
    const remaining = Math.max(0, total - done);

    const { data: maxRow, error: maxError } = await supabase
      .from("tasks")
      .select("sort_order")
      .eq("scheduled_date", nextDate)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxError) throw new Error(maxError.message);
    const nextSort = (maxRow?.sort_order ?? 0) + 1;

    const { data: inserted, error: insertError } = await supabase
      .from("tasks")
      .insert({
        title: task.title,
        notes: task.notes,
        points: remaining,
        task_type_id: task.task_type_id,
        scheduled_date: nextDate,
        sort_order: nextSort,
        parent_task_id: taskId,
        done: false,
      })
      .select("*, task_type:task_types(*)")
      .single();
    if (insertError) throw new Error(insertError.message);

    return NextResponse.json({ task: inserted, sourceTaskId: taskId, fromDate: task.scheduled_date, toDate: nextDate });
  } catch (error) {
    return apiError(error);
  }
}
