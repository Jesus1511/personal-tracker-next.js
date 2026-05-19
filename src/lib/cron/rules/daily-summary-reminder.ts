import {
  DAILY_SUMMARY_REMINDER_HOUR_VET,
  DAILY_SUMMARY_REMINDER_MINUTE_VET,
} from "@/lib/cron/config";
import { type HourlyNotificationRule } from "@/lib/cron/hourly-notifications";
import { getCaracasClock, plannerDate } from "@/lib/cron/venezuela-time";

import { handleSendCustomNotification } from "@/lib/push/handle-send-custom-notification";

/** Hora y minuto VET en `lib/cron/config.ts`. */
export const dailySummaryReminderRule: HourlyNotificationRule = {
  id: "daily-summary-reminder",
  match: () => false,
  buildNotification: () => ({ body: "" }),

  async customRunner(now: Date) {
    const { hour, minute } = getCaracasClock(now);
    const inSummaryWindow =
      hour === DAILY_SUMMARY_REMINDER_HOUR_VET &&
      minute >= DAILY_SUMMARY_REMINDER_MINUTE_VET &&
      minute < DAILY_SUMMARY_REMINDER_MINUTE_VET + 15;
    if (!inSummaryWindow) {
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
