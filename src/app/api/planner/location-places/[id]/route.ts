import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

import type { LocationPlaceRow } from "../route";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** DELETE — eliminar un lugar y sus hábitos vinculados (cascade en DB). */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdminClient();
    const { error } = await supabase.from("location_places").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * PATCH — actualizar campos de un lugar (varias filas pueden tener is_home).
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      lat?: number;
      lng?: number;
      isHome?: boolean;
      name?: string | null;
      firstSeenAt?: string | null;
      lastSeenAt?: string | null;
    };

    const supabase = getSupabaseAdminClient();

    const payload: Record<string, unknown> = {};
    if (typeof body.lat === "number" && Number.isFinite(body.lat)) payload.lat = body.lat;
    if (typeof body.lng === "number" && Number.isFinite(body.lng)) payload.lng = body.lng;
    if (typeof body.isHome === "boolean") payload.is_home = body.isHome;
    if ("name" in body) {
      payload.name = body.name === null || body.name === "" ? null : body.name;
    }
    if (typeof body.firstSeenAt === "string" && body.firstSeenAt.trim() !== "") {
      payload.first_seen_at = body.firstSeenAt.trim();
    }
    if ("lastSeenAt" in body) {
      if (body.lastSeenAt === null) payload.last_seen_at = null;
      else if (typeof body.lastSeenAt === "string") {
        payload.last_seen_at = body.lastSeenAt.trim() === "" ? null : body.lastSeenAt.trim();
      }
    }

    if (Object.keys(payload).length === 0) {
      throw new Error("No fields provided.");
    }

    const { data, error } = await supabase
      .from("location_places")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single<LocationPlaceRow>();

    if (error) throw new Error(error.message);
    return NextResponse.json({ place: data });
  } catch (error) {
    return apiError(error);
  }
}
