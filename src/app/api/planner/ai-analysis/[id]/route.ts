import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("ai_analyses")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ analysis: data });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      reviewStatus?: string;
      reviewNotes?: string;
    };

    const payload: { review_status?: string; review_notes?: string } = {};
    if (typeof body.reviewStatus === "string") {
      payload.review_status = body.reviewStatus;
    }
    if (typeof body.reviewNotes === "string") {
      payload.review_notes = body.reviewNotes;
    }

    if (Object.keys(payload).length === 0) {
      throw new Error("No fields provided.");
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("ai_analyses")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ analysis: data });
  } catch (error) {
    return apiError(error);
  }
}
