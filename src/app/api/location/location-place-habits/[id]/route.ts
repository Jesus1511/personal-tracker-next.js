import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** DELETE /api/location/location-place-habits/:id */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase
      .from("location_place_habits")
      .delete()
      .eq("id", id);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
