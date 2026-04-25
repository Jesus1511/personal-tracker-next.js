import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { fetchRizeFocusSessions, type RizeSession } from "@/lib/rize/time-entries";
import { RIZE_UNLINKED_MIN_AGE_MS } from "@/lib/cron/config";
import { type HourlyNotificationRule } from "@/lib/cron/hourly-notifications";

const PLANNER_TZ = "America/Caracas";

/** YYYY-MM-DD del instante `d` en la zona del planner. */
function plannerDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PLANNER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

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

/**
 * Devuelve los IDs de sesiones Rize que YA tienen points_completed > 0
 * en actual_task_blocks para los session IDs dados.
 */
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

/**
 * Obtiene sesiones de hoy y ayer (en VET) y las fusiona para cubrir el borde
 * de medianoche: p.ej. a las 00:15 VET un bloque de las 23:45 de ayer sigue
 * siendo reciente.
 */
async function getRecentSessions(now: Date): Promise<RizeSession[]> {
  const today = plannerDate(now);

  const yesterday = plannerDate(new Date(now.getTime() - 24 * 60 * 60_000));

  const [todaySessions, yesterdaySessions] = await Promise.all([
    fetchRizeFocusSessions(today),
    fetchRizeFocusSessions(yesterday),
  ]);

  // Dedup por id (poco probable, pero seguro)
  const seen = new Set<string>();
  return [...todaySessions, ...yesterdaySessions].filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

export const rizeUnlinkedBlocksRule: HourlyNotificationRule = {
  id: "rize-unlinked-blocks",

  /**
   * La regla siempre "hace match" — la función dispara una notificación
   * POR CADA bloque sin vincular internamente. Devolvemos false aquí para
   * que el runner no intente enviar una notificación genérica; el envío lo
   * hacemos dentro de `buildNotification` de forma especial.
   *
   * Nota: usamos `match` como punto de entrada real porque el runner llama a
   * `buildNotification` solo cuando `match` es true. Por eso exponemos la
   * lógica completa en `matchAndSend` y dejamos match en false para evitar el
   * flujo estándar del runner. El runner tiene una excepción en
   * `hourly-notifications.ts` para reglas con `customRunner`.
   */
  match: () => false, // el runner especial lo invoca directamente
  buildNotification: () => ({ body: "" }), // no se usa

  /**
   * Punto de entrada real. Evalúa todos los bloques y envía/actualiza una
   * notificación por cada bloque no vinculado.
   */
  async customRunner(now: Date) {
    const { handleSendCustomNotification } = await import(
      "@/lib/push/handle-send-custom-notification"
    );

    const sessions = await getRecentSessions(now);

    // Solo bloques que terminaron hace ≥ 1h
    const expired = sessions.filter(
      (s) => now.getTime() - new Date(s.endTime).getTime() >= RIZE_UNLINKED_MIN_AGE_MS,
    );

    if (expired.length === 0) return { notified: 0, skipped: 0 };

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
          },
          // collapseId igual → reemplaza la notificación anterior en el dispositivo
          collapseId: `rize-block-${session.id}`,
        });
        notified++;
      } catch (e) {
        errors.push(`${session.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { notified, skipped: expired.length - unlinked.length, errors };
  },
};
