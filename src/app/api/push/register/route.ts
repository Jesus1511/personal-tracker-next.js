import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      token?: string;
      deviceName?: string;
    };

    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      return NextResponse.json({ error: "token required" }, { status: 400 });
    }

    const supabase = getSupabaseAdminClient();

    const { error } = await supabase.from("push_tokens").upsert(
      {
        token,
        device_name: body.deviceName ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "token" },
    );

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
