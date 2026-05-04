import { NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export type LocationPlaceRow = {
  id: string;
  name: string | null;
  lat: number;
  lng: number;
  is_home: boolean;
  first_seen_at: string;
  last_seen_at: string | null;
  created_at: string;
};

/** GET — listar lugares (app móvil provisional). */
export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("location_places")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ places: (data ?? []) as LocationPlaceRow[] });
  } catch (error) {
    return apiError(error);
  }
}
