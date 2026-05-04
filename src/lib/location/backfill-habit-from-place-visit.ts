import { ASSUMED_SINGLE_PULSE_VISIT_MS } from "@/lib/location/assumed-visit-duration";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const VET = "America/Caracas";
const STILL_THERE_MS = 10 * 60 * 1000;

function vetToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: VET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function vetDayBoundsIso(d: string): { startIso: string; endIso: string } {
  const start = new Date(`${d}T00:00:00-04:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/**
 * Tras vincular un hábito a un lugar: si hoy hubo pulsos en ese lugar,
 * crea `actual_habit_block` con la racha actual (misma lógica de gap que al salir del lugar).
 */
export async function backfillActualHabitIfVisitedToday(
  placeId: string,
  habitTypeId: string,
): Promise<{ created: boolean; reason?: string }> {
  const supabase = getSupabaseAdminClient();
  const today = vetToday();
  const { startIso, endIso } = vetDayBoundsIso(today);

  const { data: pulses, error } = await supabase
    .from("location_pulses")
    .select("recorded_at, created_at")
    .eq("place_id", placeId)
    .gte("recorded_at", startIso)
    .lt("recorded_at", endIso)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  if (!pulses?.length) return { created: false, reason: "no-pulses-today-at-place" };

  const firstPulse = pulses[0];
  const lastPulse = pulses[pulses.length - 1];

  const { data: gapRows } = await supabase
    .from("location_pulses")
    .select("created_at")
    .neq("place_id", placeId)
    .lt("created_at", firstPulse.created_at)
    .order("created_at", { ascending: false })
    .limit(1);

  const gapCutoff = gapRows?.[0]?.created_at ?? startIso;

  const { data: sessionStartRows } = await supabase
    .from("location_pulses")
    .select("recorded_at")
    .eq("place_id", placeId)
    .gt("created_at", gapCutoff)
    .order("created_at", { ascending: true })
    .limit(1);

  const startAt = sessionStartRows?.[0]?.recorded_at ?? firstPulse.recorded_at;
  let endAt = lastPulse.recorded_at;

  const { count: sessionCountRaw } = await supabase
    .from("location_pulses")
    .select("id", { count: "exact", head: true })
    .eq("place_id", placeId)
    .gt("created_at", gapCutoff)
    .gte("recorded_at", startIso)
    .lt("recorded_at", endIso);
  const sessionCount = sessionCountRaw ?? 0;

  if (sessionCount > 1) {
    const now = new Date();
    const lastRec = new Date(endAt);
    if (now.getTime() - lastRec.getTime() <= STILL_THERE_MS) {
      endAt = now.toISOString();
    }
  }

  let start = new Date(startAt);
  let end = new Date(endAt);
  if (sessionCount <= 1) {
    end = new Date(start.getTime() + ASSUMED_SINGLE_PULSE_VISIT_MS);
  } else if (end <= start) {
    end = new Date(start.getTime() + ASSUMED_SINGLE_PULSE_VISIT_MS);
  }

  const { data: dup } = await supabase
    .from("actual_habit_blocks")
    .select("id")
    .eq("habit_type_id", habitTypeId)
    .eq("scheduled_date", today)
    .gte("start_at", new Date(start.getTime() - 120_000).toISOString())
    .lte("start_at", new Date(start.getTime() + 120_000).toISOString())
    .limit(1);

  if (dup?.length) return { created: false, reason: "duplicate-block-same-window" };

  const { error: insErr } = await supabase.from("actual_habit_blocks").insert({
    scheduled_date: today,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    habit_type_id: habitTypeId,
    description: `Auto: vinculaste el hábito tras visitar hoy (${startAt.slice(11, 16)}–${end.toISOString().slice(11, 16)} VET)`,
    planned_block_id: null,
  });

  if (insErr) throw new Error(insErr.message);
  return { created: true };
}
