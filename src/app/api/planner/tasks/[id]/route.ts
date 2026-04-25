import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      title?: string;
      notes?: string | null;
      done?: boolean;
      points?: number;
      taskTypeId?: string | null;
      scheduledDate?: string;
      sortOrder?: number;
    };

    const payload: {
      title?: string;
      notes?: string | null;
      done?: boolean;
      points?: number;
      task_type_id?: string | null;
      scheduled_date?: string;
      sort_order?: number;
    } = {};

    if (typeof body.title === "string") {
      payload.title = body.title.trim();
    }
    if ("notes" in body) payload.notes = body.notes ?? null;
    if (typeof body.done === "boolean") payload.done = body.done;
    if (typeof body.points === "number") payload.points = Math.max(0, Math.min(10, body.points));
    if ("taskTypeId" in body) payload.task_type_id = body.taskTypeId ?? null;
    if (typeof body.scheduledDate === "string") payload.scheduled_date = normalizeDate(body.scheduledDate);
    if (typeof body.sortOrder === "number") payload.sort_order = body.sortOrder;

    if (Object.keys(payload).length === 0) throw new Error("No fields provided.");

    const supabase = getSupabaseAdminClient();

    // Si se intenta marcar done=true, verificar que la tarea tenga categoría.
    if (payload.done === true) {
      const { data: current, error: fetchErr } = await supabase
        .from("tasks")
        .select("task_type_id")
        .eq("id", id)
        .single();
      if (fetchErr) throw new Error(fetchErr.message);
      const effectiveTypeId = "task_type_id" in payload ? payload.task_type_id : current.task_type_id;
      if (!effectiveTypeId) {
        return NextResponse.json(
          { error: "Asigna una categoría antes de completar la tarea." },
          { status: 422 },
        );
      }
    }

    const { data, error } = await supabase
      .from("tasks")
      .update(payload)
      .eq("id", id)
      .select("*, task_type:task_types(*)")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ task: data });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.from("tasks").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
