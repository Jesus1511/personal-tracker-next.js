import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { gatherWeeklyData } from "@/lib/weekly-summary/gather-data";
import { generateWeeklySummaryHtml } from "@/lib/weekly-summary/generate-email";
import { sendWeeklySummaryEmail } from "@/lib/weekly-summary/send-email";

export const dynamic = "force-dynamic";

/**
 * Vercel Cron: GET domingos 01:00 UTC (= 21:00 VET, Venezuela UTC-4).
 * Schedule en vercel.json: "0 1 * * 0"
 * Requiere CRON_SECRET igual que el cron horario.
 */
function verifyCronRequest(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false as const, status: 503, message: "CRON_SECRET not configured" };
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) return { ok: false as const, status: 401, message: "Unauthorized" };
  return { ok: true as const };
}

export async function GET(request: NextRequest) {
  const auth = verifyCronRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }

  try {
    const now = new Date();
    console.log("[cron/weekly] start", { at: now.toISOString() });

    const data = await gatherWeeklyData(now);
    console.log("[cron/weekly] data gathered", {
      weekStart: data.weekStart,
      weekEnd: data.weekEnd,
      tasks: data.tasks.total,
      habits: data.habits.totalPlanned,
    });

    const html = await generateWeeklySummaryHtml(data);
    console.log("[cron/weekly] html generated, length", html.length);

    await sendWeeklySummaryEmail(html, `${data.weekStart} – ${data.weekEnd}`);
    console.log("[cron/weekly] email sent");

    return NextResponse.json({ ok: true, weekStart: data.weekStart, weekEnd: data.weekEnd });
  } catch (error) {
    console.error("[cron/weekly] error", error);
    return apiError(error);
  }
}
