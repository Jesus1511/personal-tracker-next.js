import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("task_types")
      .select("*")
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);
    return NextResponse.json({ taskTypes: data ?? [] });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { name?: string; color?: string | null };
    const name = body.name?.trim();
    if (!name) throw new Error("Task type name is required.");

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("task_types")
      .insert({ name, color: body.color ?? null })
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ taskType: data }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
