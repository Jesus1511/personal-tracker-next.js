import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { fetchRizeFocusSessions, type RizeSession } from "@/lib/rize/time-entries";
import { RIZE_UNLINKED_MIN_AGE_MS } from "@/lib/cron/config";
import { type HourlyNotificationRule } from "@/lib/cron/hourly-notifications";
import {
  PLANNER_TZ,
  plannerDate,
  plannerDateFromIso,
} from "@/lib/cron/venezuela-time";

/** HH:MM de un ISO string mostrado en hora local (VET). */
function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat("es-VE", {
    timeZone: PLANNER_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** "hace 2 h 15 min" / "hace 45 min" */
function agoLabel(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `hace ${m} min`;
  if (m === 0) return `hace ${h} h`;
  return `hace ${h} h ${m} min`;
}

async function linkedRizeIds(sessionIds: string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("actual_task_blocks")
    .select("rize_entry_id")
    .in("rize_entry_id", sessionIds)
    .gt("points_completed", 0)
    .not("rize_entry_id", "is", null);

  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r: { rize_entry_id: string }) => r.rize_entry_id));
}

export const rizeUnlinkedBlocksRule: HourlyNotificationRule = {
  id: "rize-unlinked-blocks",
  match: () => false,
  buildNotification: () => ({ body: "" }),

  async customRunner(now: Date) {
    const { handleSendCustomNotification } = await import(
      "@/lib/push/handle-send-custom-notification"
    );

    const today = plannerDate(now);
    const sessions = await fetchRizeFocusSessions(today);

    const expired = sessions.filter((s) => {
      if (plannerDateFromIso(s.endTime) !== today) return false;
      return now.getTime() - new Date(s.endTime).getTime() >= RIZE_UNLINKED_MIN_AGE_MS;
    });

    if (expired.length === 0) return { notified: 0, skipped: 0, today };

    const linked = await linkedRizeIds(expired.map((s) => s.id));
    const unlinked = expired.filter((s) => !linked.has(s.id));

    let notified = 0;
    const errors: string[] = [];

    for (const session of unlinked) {
      const elapsedMs = now.getTime() - new Date(session.endTime).getTime();
      const start = fmtTime(session.startTime);
      const end = fmtTime(session.endTime);
      const title = session.title?.trim() || "Sin título";
      const ago = agoLabel(elapsedMs);

      try {
        await handleSendCustomNotification({
          title: "🔵 ¿Qué hiciste en este bloque?",
          body: `"${title}" (${start}–${end}) · terminó ${ago}. Asígnale una tarea.`,
          data: {
            type: "rize_unlinked_block",
            rize_entry_id: session.id,
            start_time: session.startTime,
            end_time: session.endTime,
            scheduled_date: today,
          },
          collapseId: `rize-block-${session.id}`,
        });
        notified++;
      } catch (e) {
        errors.push(`${session.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { notified, skipped: expired.length - unlinked.length, today, errors };
  },
};
