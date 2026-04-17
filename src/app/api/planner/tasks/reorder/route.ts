import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

/**
 * PATCH /api/planner/tasks/reorder
 * Body: { orderedIds: string[] }
 *
 * Sets sort_order = index+1 for each task id in the provided order.
 * Only touches tasks whose id is in the array.
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as { orderedIds?: string[] };
    const ids = body.orderedIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error("orderedIds must be a non-empty array.");
    }

    const supabase = getSupabaseAdminClient();

    const updates = ids.map((id, i) =>
      supabase
        .from("tasks")
        .update({ sort_order: i + 1 })
        .eq("id", id),
    );

    const results = await Promise.all(updates);

    for (const r of results) {
      if (r.error) throw new Error(r.error.message);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
