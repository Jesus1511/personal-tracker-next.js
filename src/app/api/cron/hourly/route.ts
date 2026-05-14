import { NextRequest, NextResponse } from "next/server";

import { shouldRunCronNotificationLogic } from "@/lib/cron/config";
import { runHourlyNotificationCron } from "@/lib/cron/hourly-notifications";
import { apiError } from "@/lib/planner/http";

export const dynamic = "force-dynamic";

function verifyCronRequest(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false as const, status: 503, message: "CRON_SECRET not configured" };
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return { ok: false as const, status: 401, message: "Unauthorized" };
  }
  return { ok: true as const };
}

/**
 * Vercel Cron: GET cada hora (UTC). Requiere `CRON_SECRET` y
 * `Authorization: Bearer <CRON_SECRET>` (Vercel lo inyecta si está definido).
 */
export async function GET(request: NextRequest) {
  const auth = verifyCronRequest(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.message },
      { status: auth.status },
    );
  }
  try {
    const now = new Date();
    console.log("[cron/hourly] invoke", { at: now.toISOString() });
    if (!shouldRunCronNotificationLogic(now)) {
      console.log("[cron/hourly] skip tick (schedule gate)");
      return NextResponse.json({ ok: true, skipped: "cron-tick" });
    }
    console.log("[cron/hourly] run rules", { at: now.toISOString() });
    const result = await runHourlyNotificationCron(now);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return apiError(error);
  }
}
