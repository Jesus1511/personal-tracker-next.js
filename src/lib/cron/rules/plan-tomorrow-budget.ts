import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { type HourlyNotificationRule } from "@/lib/cron/hourly-notifications";
import { getCaracasClock, PLANNER_TZ, plannerDate } from "@/lib/cron/venezuela-time";

import { handleSendCustomNotification } from "@/lib/push/handle-send-custom-notification";

/**
 * "Mañana" = día calendario siguiente al de hoy (VET). ~+25h basta en Venezuela (sin cambio de DST).
 */
function tomorrowPlannerDateFromNow(now: Date): string {
  return plannerDate(new Date(now.getTime() + 25 * 60 * 60 * 1000));
}

async function countTimeBlocksOnDate(scheduledDate: string): Promise<number> {
  const supabase = getSupabaseAdminClient();
  const { count, error } = await supabase
    .from("time_blocks")
    .select("id", { count: "exact", head: true })
    .eq("scheduled_date", scheduledDate);

  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Frentes (Caracas, VET):
 * - 9:00–10:59: recordatorio “día siguiente” (sin bloques) — 2 h de ventana (el cron rara vez pega a :00).
 * - 20:00–23:59: sin bloques → avisos 20, 21, 22 y 23 h; con bloques: solo 20 h.
 * Una ejecución por hora UTC (Vercel); la hora local VET basta para acotar la franja.
 * `dateLabel`: solo el día a mostrar en el push, no el horario del cron.
 */
export const planTomorrowBudgetRule: HourlyNotificationRule = {
  id: "plan-tomorrow-budget",
  match: () => false,
  buildNotification: () => ({ body: "" }),

  async customRunner(now: Date) {
    const { hour } = getCaracasClock(now);
    const inMorning9to10 = hour === 9 || hour === 10; // 9:00–10:59
    const inEvening = hour >= 20 && hour <= 23; // 20:00–23:59
    if (!inMorning9to10 && !inEvening) {
      return { skipped: "outside-9-10-or-20-23-venezuela" };
    }

    const tomorrow = tomorrowPlannerDateFromNow(now);
    const n = await countTimeBlocksOnDate(tomorrow);

    const dateLabel = new Intl.DateTimeFormat("es-VE", {
      timeZone: PLANNER_TZ,
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(new Date(`${tomorrow}T12:00:00-04:00`));

    if (n > 0) {
      if (hour !== 20) {
        return { skipped: "has-blocks-8pm-only", count: n, tomorrow };
      }
      await handleSendCustomNotification({
        title: "Mañana en el planificador",
        body: `Ya tienes ${n} bloque(s) para ${dateLabel}. Nada crítico; solo un recordatorio por si quieres repasarlo.`,
        data: { type: "plan_tomorrow_has_blocks", scheduled_date: tomorrow, block_count: n },
        collapseId: `planner-tm-check-${tomorrow}`,
      });
      return { sent: 1, case: "has-blocks-8pm", count: n, tomorrow };
    }

    const emptyCollapseId =
      hour === 9 || hour === 10
        ? `planner-tm-empty-${tomorrow}-morning-9-10`
        : `planner-tm-empty-${tomorrow}-h${hour}`;

    await handleSendCustomNotification({
      title: "Programa el día siguiente",
      body: `Aún no hay bloques en el calendario para ${dateLabel}. Reparte tareas y hábitos en el planificador.`,
      data: { type: "plan_tomorrow_empty", scheduled_date: tomorrow, hour_ven: hour },
      collapseId: emptyCollapseId,
    });
    return { sent: 1, case: "empty-hourly", hour, tomorrow };
  },
};
