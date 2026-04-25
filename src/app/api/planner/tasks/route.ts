import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const date = normalizeDate(request.nextUrl.searchParams.get("date"));
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("tasks")
      .select("*, task_type:task_types(*)")
      .eq("scheduled_date", date)
      .order("sort_order", { ascending: true });

    if (error) throw new Error(error.message);

    const tasks = data ?? [];
    const taskIds = tasks.map((t) => t.id);

    // Tareas hija creadas al “pasar al día siguiente” (cualquier fecha): un id por padre.
    const carryChildIdByParent = new Map<string, string>();
    if (taskIds.length > 0) {
      const { data: childData, error: childErr } = await supabase
        .from("tasks")
        .select("id, parent_task_id")
        .in("parent_task_id", taskIds);
      if (childErr) throw new Error(childErr.message);
      for (const row of childData ?? []) {
        const p = row.parent_task_id;
        if (!p || carryChildIdByParent.has(p)) continue;
        carryChildIdByParent.set(p, row.id);
      }
    }

    // Sumo points_completed por task_id desde actual_task_blocks (solo del día);
    // me ahorro N round-trips trayendo una sola colección y agregando en memoria.
    const pointsDoneByTaskId = new Map<string, number>();
    if (taskIds.length > 0) {
      const { data: blocks, error: blocksError } = await supabase
        .from("actual_task_blocks")
        .select("task_id, points_completed, scheduled_date")
        .eq("scheduled_date", date)
        .in("task_id", taskIds);
      if (blocksError) throw new Error(blocksError.message);
      for (const row of blocks ?? []) {
        if (!row.task_id) continue;
        const prev = pointsDoneByTaskId.get(row.task_id) ?? 0;
        pointsDoneByTaskId.set(row.task_id, prev + (row.points_completed ?? 0));
      }
    }

    const tasksWithProgress = tasks.map((t) => ({
      ...t,
      points_done: pointsDoneByTaskId.get(t.id) ?? 0,
      carry_next_child_id: carryChildIdByParent.get(t.id) ?? null,
    }));

    return NextResponse.json({ tasks: tasksWithProgress, date });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      title?: string;
      notes?: string | null;
      taskTypeId?: string | null;
      scheduledDate?: string;
    };

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const scheduledDate = normalizeDate(body.scheduledDate);

    const supabase = getSupabaseAdminClient();

    const { data: maxRow } = await supabase
      .from("tasks")
      .select("sort_order")
      .eq("scheduled_date", scheduledDate)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextSort = (maxRow?.sort_order ?? 0) + 1;

    const { data, error } = await supabase
      .from("tasks")
      .insert({
        title,
        notes: body.notes ?? null,
        task_type_id: null, // siempre sin categoría al crear
        scheduled_date: scheduledDate,
        sort_order: nextSort,
      })
      .select("*, task_type:task_types(*)")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ task: data }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
