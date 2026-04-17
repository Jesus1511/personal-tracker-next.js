import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * Mueve a `date` (normalmente "hoy") las tareas no terminadas de días anteriores.
 * Para cada tarea origen con puntos pendientes, crea UNA tarea hija en `date`
 * con `points = restantes` y `parent_task_id = origen`, y marca la original `done=true`.
 *
 * Idempotente: si ya existe una hija con `parent_task_id = origen` en `date`, no duplica.
 * Se dispara desde el cliente al abrir el día. Si el usuario pasa varios días sin abrir
 * la app, la cadena se crea de una sola vez (una tarea hija por tarea origen).
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { date?: string };
    const date = normalizeDate(body.date);
    const supabase = getSupabaseAdminClient();

    // 1) Tareas origen: no hechas, de días anteriores.
    const { data: origins, error: originsError } = await supabase
      .from("tasks")
      .select("id, title, notes, points, task_type_id, sort_order, scheduled_date")
      .eq("done", false)
      .lt("scheduled_date", date);
    if (originsError) throw new Error(originsError.message);

    const originIds = (origins ?? []).map((t) => t.id);
    if (originIds.length === 0) {
      return NextResponse.json({ createdCount: 0, tasks: [] });
    }

    // 2) Cuántos puntos ya hizo cada una (todos los días, no solo uno).
    const { data: progressRows, error: progressError } = await supabase
      .from("actual_task_blocks")
      .select("task_id, points_completed")
      .in("task_id", originIds);
    if (progressError) throw new Error(progressError.message);

    const doneByTaskId = new Map<string, number>();
    for (const row of progressRows ?? []) {
      if (!row.task_id) continue;
      doneByTaskId.set(row.task_id, (doneByTaskId.get(row.task_id) ?? 0) + (row.points_completed ?? 0));
    }

    // 3) Idempotencia: ignoro los orígenes que ya tienen hija en `date`.
    const { data: existingChildren, error: existingError } = await supabase
      .from("tasks")
      .select("id, parent_task_id")
      .eq("scheduled_date", date)
      .in("parent_task_id", originIds);
    if (existingError) throw new Error(existingError.message);
    const alreadyRolled = new Set(
      (existingChildren ?? []).map((c) => c.parent_task_id).filter(Boolean) as string[],
    );

    // 4) Próximo sort_order disponible en el día destino.
    const { data: maxRow, error: maxError } = await supabase
      .from("tasks")
      .select("sort_order")
      .eq("scheduled_date", date)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxError) throw new Error(maxError.message);
    let nextSort = (maxRow?.sort_order ?? 0) + 1;

    // 5) Construyo filas a insertar (tareas pendientes reales).
    const toInsert: Array<{
      title: string;
      notes: string | null;
      points: number;
      task_type_id: string | null;
      scheduled_date: string;
      sort_order: number;
      parent_task_id: string;
    }> = [];
    const originsToClose: string[] = [];

    for (const o of origins ?? []) {
      if (alreadyRolled.has(o.id)) continue;
      const total = Math.max(0, o.points ?? 0);
      const done = Math.min(total, doneByTaskId.get(o.id) ?? 0);
      const remaining = Math.max(0, total - done);

      // Si la tarea no tenía puntos (0) y no está done, igual la paso a hoy con 0 puntos.
      // Si tenía puntos y ya no quedan restantes, está "hecha" de facto: solo la cierro.
      if (total > 0 && remaining === 0) {
        originsToClose.push(o.id);
        continue;
      }

      toInsert.push({
        title: o.title,
        notes: o.notes,
        points: remaining,
        task_type_id: o.task_type_id,
        scheduled_date: date,
        sort_order: nextSort++,
        parent_task_id: o.id,
      });
      originsToClose.push(o.id);
    }

    // 6) Inserto hijas y cierro orígenes.
    let createdTasks: unknown[] = [];
    if (toInsert.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from("tasks")
        .insert(toInsert)
        .select("*, task_type:task_types(*)");
      if (insertError) throw new Error(insertError.message);
      createdTasks = inserted ?? [];
    }

    if (originsToClose.length > 0) {
      const { error: closeError } = await supabase
        .from("tasks")
        .update({ done: true, updated_at: new Date().toISOString() })
        .in("id", originsToClose);
      if (closeError) throw new Error(closeError.message);
    }

    return NextResponse.json({ createdCount: toInsert.length, tasks: createdTasks });
  } catch (error) {
    return apiError(error);
  }
}
