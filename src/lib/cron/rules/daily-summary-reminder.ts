import {
  DAILY_SUMMARY_REMINDER_HOUR_VET,
  DAILY_SUMMARY_REMINDER_MINUTE_VET,
} from "@/lib/cron/config";
import { type HourlyNotificationRule } from "@/lib/cron/hourly-notifications";

import { handleSendCustomNotification } from "@/lib/push/handle-send-custom-notification";

const PLANNER_TZ = "America/Caracas";

function plannerDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PLANNER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function getCaracasClock(now: Date): { hour: number; minute: number } {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: PLANNER_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { hour: h, minute: m };
}

/** Hora y minuto VET en `lib/cron/config.ts`. */
export const dailySummaryReminderRule: HourlyNotificationRule = {
  id: "daily-summary-reminder",
  match: () => false,
  buildNotification: () => ({ body: "" }),

  async customRunner(now: Date) {
    const { hour, minute } = getCaracasClock(now);
    if (
      hour !== DAILY_SUMMARY_REMINDER_HOUR_VET ||
      minute !== DAILY_SUMMARY_REMINDER_MINUTE_VET
    ) {
      return {
        skipped: `not-summary-clock-caracas-want-${DAILY_SUMMARY_REMINDER_HOUR_VET}:${String(DAILY_SUMMARY_REMINDER_MINUTE_VET).padStart(2, "0")}`,
      };
    }

    const todayDate = plannerDate(now);

    await handleSendCustomNotification({
      title: "Revisa tus métricas de hoy",
      body: "🟣 ¿Cómo fue el día? Escribe tu resumen de 200 caracteres en métricas.",
      data: { type: "daily_summary_reminder", date: todayDate },
      collapseId: `daily-summary-${todayDate}`,
    });
    return { sent: 1, todayDate };
  },
};
