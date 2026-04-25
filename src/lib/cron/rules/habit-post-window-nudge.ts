import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { type HourlyNotificationRule } from "@/lib/cron/hourly-notifications";

import { handleSendCustomNotification } from "@/lib/push/handle-send-custom-notification";

/**
 * Tras `end_at` del bloque planificado (hábito), espera 1 h; en la ventana
 * de 30 min siguientes (para que el cron no tenga que pegar al minuto),
 * envía **una** notificación por bloque (collapseId por `time_block.id`), si
 * aún no hay `actual_habit_blocks` con `planned_block_id` = ese bloque.
 */
const NUDGE_AFTER_END_MS = 60 * 60 * 1000;
const NUDGE_WINDOW_MS = 30 * 60 * 1000;

type HabitBlockRow = {
  id: string;
  end_at: string;
  scheduled_date: string;
  habit_type_id: string;
  habit_type: { name: string } | null;
};

function normalizeHabitBlock(raw: Record<string, unknown>): HabitBlockRow {
  const ht = raw.habit_type;
  const one = Array.isArray(ht) ? (ht[0] as { name?: string } | undefined) ?? null : (ht as { name?: string } | null);
  return {
    id: String(raw.id),
    end_at: String(raw.end_at),
    scheduled_date: String(raw.scheduled_date),
    habit_type_id: String(raw.habit_type_id),
    habit_type: one && typeof one === "object" && one !== null && "name" in one
      ? { name: String((one as { name: string }).name) }
      : null,
  };
}

export const habitPostWindowNudgeRule: HourlyNotificationRule = {
  id: "habit-post-window-nudge",
  match: () => false,
  buildNotification: () => ({ body: "" }),

  async customRunner(now: Date) {
    const tAfter = new Date(now.getTime() - NUDGE_AFTER_END_MS).toISOString();
    const tWindowStart = new Date(now.getTime() - NUDGE_AFTER_END_MS - NUDGE_WINDOW_MS).toISOString();

    const supabase = getSupabaseAdminClient();
    const { data: blocks, error } = await supabase
      .from("time_blocks")
      .select("id, end_at, scheduled_date, habit_type_id, habit_type:habit_types(name)")
      .eq("entry_type", "habit")
      .gte("end_at", tWindowStart)
      .lte("end_at", tAfter);

    if (error) throw new Error(error.message);
    const list = (blocks ?? []).map((r) => normalizeHabitBlock(r as Record<string, unknown>));
    if (list.length === 0) return { sent: 0, skipped: "no-candidate-blocks" };

    const ids = list.map((b) => b.id);
    const { data: doneRows, error: doneErr } = await supabase
      .from("actual_habit_blocks")
      .select("planned_block_id")
      .in("planned_block_id", ids);

    if (doneErr) throw new Error(doneErr.message);
    const done = new Set(
      (doneRows ?? [])
        .map((r: { planned_block_id: string | null }) => r.planned_block_id)
        .filter(Boolean) as string[],
    );

    let sent = 0;
    const errors: string[] = [];

    for (const block of list) {
      if (done.has(block.id)) continue;

      const title = block.habit_type?.name?.trim() || "Hábito";
      const end = new Date(block.end_at);
      const body = `El bloque planificado terminó a las ${end.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Caracas" })}. Regístralo como hecho si ya lo cumpliste.`;

      try {
        await handleSendCustomNotification({
          title: "🟢 ¿Completaste el hábito?",
          body: `“${title}”. ${body}`,
          data: {
            type: "habit_post_window_nudge",
            time_block_id: block.id,
            habit_type_id: block.habit_type_id,
            scheduled_date: block.scheduled_date,
          },
          collapseId: `habit-post-window-${block.id}`,
        });
        sent++;
      } catch (e) {
        errors.push(`${block.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      sent,
      candidates: list.length,
      alreadyCompleted: list.filter((b) => done.has(b.id)).length,
      errors,
    };
  },
};
