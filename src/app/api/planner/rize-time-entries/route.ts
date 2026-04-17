import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { fetchRizeFocusSessions } from "@/lib/rize/time-entries";

function calcDurationSeconds(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(0, Math.round(ms / 1000));
}

export async function GET(request: NextRequest) {
  try {
    const date = normalizeDate(request.nextUrl.searchParams.get("date"));
    const sessions = await fetchRizeFocusSessions(date);
    const timeEntries = sessions
      .map((s) => ({
        id: s.id,
        title: s.title?.trim() || "Sin título",
        startTime: s.startTime,
        endTime: s.endTime,
        durationSeconds: calcDurationSeconds(s.startTime, s.endTime),
      }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    return NextResponse.json({ timeEntries, date });
  } catch (error) {
    return apiError(error);
  }
}
