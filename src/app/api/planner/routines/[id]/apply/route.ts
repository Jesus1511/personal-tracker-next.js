import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { applyRoutineToDay } from "@/lib/planner/daily-routines";
import { apiError } from "@/lib/planner/http";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/** POST body: { date } — replace planned tasks/blocks for that day */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { date?: string };
    const date = normalizeDate(body.date);

    await applyRoutineToDay(id, date);

    return NextResponse.json({ ok: true, date });
  } catch (error) {
    return apiError(error);
  }
}
