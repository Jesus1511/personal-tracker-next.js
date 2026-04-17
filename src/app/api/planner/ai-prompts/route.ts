import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("ai_prompts")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return NextResponse.json({ prompts: data ?? [] });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      label?: string;
      promptText?: string;
    };
    const label = body.label?.trim();
    const promptText = body.promptText?.trim();
    if (!label) throw new Error("label is required");
    if (!promptText) throw new Error("promptText is required");

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase
      .from("ai_prompts")
      .insert({ label, prompt_text: promptText })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ prompt: data }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
