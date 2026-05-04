import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export type DailySummaryRow = {
  id: string;
  date: string;
  text: string;
};

const SELECT_FIELDS = "id, date, text, created_at, updated_at";

const MAX_LEN = 200;

function parseBodyText(raw: unknown): string | null {
  if (raw === undefined) return "";
  if (typeof raw !== "string") return null;
  if (raw.length > MAX_LEN) return null;
  return raw;
}

/** GET /api/planner/daily-summaries?date=YYYY-MM-DD */
/** GET /api/planner/daily-summaries?from=&to= (range, inclusive) */
export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabaseAdminClient();
    const { searchParams } = request.nextUrl;

    if (searchParams.has("from") && searchParams.has("to")) {
      const from = normalizeDate(searchParams.get("from"));
      const to = normalizeDate(searchParams.get("to"));
      const { data, error } = await supabase
        .from("daily_summaries")
        .select(SELECT_FIELDS)
        .gte("date", from)
        .lte("date", to)
        .order("date", { ascending: true });
      if (error) throw new Error(error.message);
      return NextResponse.json({ dailySummaries: data ?? [] });
    }

    const date = normalizeDate(searchParams.get("date"));
    const { data, error } = await supabase
      .from("daily_summaries")
      .select(SELECT_FIELDS)
      .eq("date", date)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return NextResponse.json({ dailySummary: data ?? null });
  } catch (error) {
    return apiError(error);
  }
}

/** PUT /api/planner/daily-summaries body: { date, text } — upsert */
export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as { date?: string; text?: unknown };

    const date = normalizeDate(body.date);
    const text = parseBodyText(body.text);
    if (text === null) {
      return NextResponse.json(
        { error: `text must be a string with at most ${MAX_LEN} characters` },
        { status: 400 },
      );
    }

    const supabase = getSupabaseAdminClient();

    const { data: existing } = await supabase
      .from("daily_summaries")
      .select("id")
      .eq("date", date)
      .maybeSingle();

    if (existing) {
      const { data, error } = await supabase
        .from("daily_summaries")
        .update({ text, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
        .select(SELECT_FIELDS)
        .single();
      if (error) throw new Error(error.message);
      return NextResponse.json({ dailySummary: data });
    }

    const { data, error } = await supabase
      .from("daily_summaries")
      .insert({ date, text })
      .select(SELECT_FIELDS)
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ dailySummary: data }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
