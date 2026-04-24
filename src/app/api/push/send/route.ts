import { NextRequest, NextResponse } from "next/server";

import { apiError } from "@/lib/planner/http";
import { handleSendCustomNotification, type SendCustomNotificationInput } from "@/lib/push/handle-send-custom-notification";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SendCustomNotificationInput;
    const result = await handleSendCustomNotification(body);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "no valid Expo push tokens") {
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }
    return apiError(error);
  }
}
