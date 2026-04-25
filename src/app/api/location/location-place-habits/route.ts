import { NextRequest, NextResponse } from "next/server";

import { backfillActualHabitIfVisitedToday } from "@/lib/location/backfill-habit-from-place-visit";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export type LocationPlaceHabitRow = {
  id: string;
  place_id: string;
  habit_type_id: string;
  created_at: string;
  habit_type?: { id: string; name: string; color: string | null } | null;
};

/** GET ?placeId=<uuid> → { habits: LocationPlaceHabitRow[] } */
export async function GET(request: NextRequest) {
  try {
    const placeId = request.nextUrl.searchParams.get("placeId");
    if (!placeId) throw new Error("placeId is required");

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("location_place_habits")
      .select("*, habit_type:habit_types(id, name, color)")
      .eq("place_id", placeId)
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);
    return NextResponse.json({ habits: (data ?? []) as LocationPlaceHabitRow[] });
  } catch (error) {
    return apiError(error);
  }
}

/** POST { placeId, habitTypeId } → 201 { habit, backfill } */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { placeId?: string; habitTypeId?: string };
    if (!body.placeId || !body.habitTypeId) throw new Error("placeId and habitTypeId required");

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("location_place_habits")
      .insert({ place_id: body.placeId, habit_type_id: body.habitTypeId })
      .select("*, habit_type:habit_types(id, name, color)")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: "Already linked" }, { status: 409 });
      }
      throw new Error(error.message);
    }

    let backfill: { created: boolean; reason?: string };
    try {
      backfill = await backfillActualHabitIfVisitedToday(body.placeId, body.habitTypeId);
    } catch (e) {
      console.error("[location-place-habits] backfill", e);
      backfill = {
        created: false,
        reason: e instanceof Error ? e.message : "backfill-error",
      };
    }

    return NextResponse.json(
      { habit: data as LocationPlaceHabitRow, backfill },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}
