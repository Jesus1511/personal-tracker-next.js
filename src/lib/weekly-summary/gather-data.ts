import { getSupabaseAdminClient } from "@/lib/supabase/server";

const PLANNER_TZ = "America/Caracas";

function vetDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PLANNER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** ISO YYYY-MM-DD para N días atrás en VET. */
function daysAgo(now: Date, n: number): string {
  return vetDate(new Date(now.getTime() - n * 24 * 60 * 60_000));
}

export type WeeklySummaryData = {
  weekStart: string;
  weekEnd: string;
  tasks: {
    total: number;
    done: number;
    notDone: number;
    avgPoints: number;
    byDay: { date: string; done: number; total: number }[];
  };
  habits: {
    totalPlanned: number;
    totalCompleted: number;
    completionRate: number;
    byHabit: { name: string; planned: number; completed: number }[];
  };
  timeBlocks: {
    totalPlanned: number;
    totalMinutes: number;
    byType: { type: "task" | "habit"; minutes: number }[];
  };
  locations: {
    uniquePlaces: number;
    visits: { placeId: string; lat: number; lng: number; isHome: boolean; sessions: number }[];
    homeTime: "unknown";
  };
};

export async function gatherWeeklyData(now: Date): Promise<WeeklySummaryData> {
  const supabase = getSupabaseAdminClient();

  const weekEnd = daysAgo(now, 0);    // hoy (domingo)
  const weekStart = daysAgo(now, 6);  // hace 6 días (lunes)

  const dates: string[] = [];
  for (let i = 6; i >= 0; i--) dates.push(daysAgo(now, i));

  // ── Tareas ──────────────────────────────────────────────────────────────────
  const { data: taskRows } = await supabase
    .from("tasks")
    .select("id, done, points, scheduled_date")
    .gte("scheduled_date", weekStart)
    .lte("scheduled_date", weekEnd);

  const tasks = taskRows ?? [];
  const doneTasks = tasks.filter((t) => t.done);
  const totalPoints = doneTasks.reduce((s, t) => s + (t.points ?? 0), 0);

  const byDay = dates.map((d) => {
    const dayTasks = tasks.filter((t) => t.scheduled_date === d);
    return { date: d, done: dayTasks.filter((t) => t.done).length, total: dayTasks.length };
  });

  // ── Hábitos ─────────────────────────────────────────────────────────────────
  const { data: plannedHabitRows } = await supabase
    .from("time_blocks")
    .select("id, habit_type_id, habit_type:habit_types(name)")
    .eq("entry_type", "habit")
    .gte("scheduled_date", weekStart)
    .lte("scheduled_date", weekEnd);

  const { data: completedHabitRows } = await supabase
    .from("actual_habit_blocks")
    .select("habit_type_id, planned_block_id")
    .gte("scheduled_date", weekStart)
    .lte("scheduled_date", weekEnd);

  const planned = plannedHabitRows ?? [];
  const completed = completedHabitRows ?? [];
  const linkedPlannedIds = new Set(
    completed.map((c) => c.planned_block_id).filter(Boolean),
  );

  const habitMap = new Map<string, { name: string; planned: number; completed: number }>();
  for (const p of planned) {
    const ht = p.habit_type as { name: string } | { name: string }[] | null;
    const name = Array.isArray(ht) ? (ht[0]?.name ?? "?") : (ht?.name ?? "?");
    const existing = habitMap.get(p.habit_type_id) ?? { name, planned: 0, completed: 0 };
    existing.planned++;
    if (linkedPlannedIds.has(p.id)) existing.completed++;
    habitMap.set(p.habit_type_id, existing);
  }

  const byHabit = [...habitMap.values()];
  const completionRate =
    planned.length > 0 ? Math.round((byHabit.reduce((s, h) => s + h.completed, 0) / planned.length) * 100) : 0;

  // ── Bloques de tiempo ───────────────────────────────────────────────────────
  const { data: blockRows } = await supabase
    .from("time_blocks")
    .select("id, entry_type, start_at, end_at")
    .gte("scheduled_date", weekStart)
    .lte("scheduled_date", weekEnd);

  const blocks = blockRows ?? [];
  let taskMins = 0, habitMins = 0;
  for (const b of blocks) {
    const mins = (new Date(b.end_at).getTime() - new Date(b.start_at).getTime()) / 60_000;
    if (b.entry_type === "task") taskMins += mins;
    else habitMins += mins;
  }

  // ── Ubicaciones ─────────────────────────────────────────────────────────────
  const { data: pulseRows } = await supabase
    .from("location_pulses")
    .select("place_id, created_at")
    .not("place_id", "is", null)
    .gte("created_at", `${weekStart}T00:00:00Z`)
    .lte("created_at", `${weekEnd}T23:59:59Z`);

  const placeSessionCounts = new Map<string, number>();
  const sortedPulses = (pulseRows ?? []).sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  let prevPId: string | null = null;
  for (const p of sortedPulses) {
    if (p.place_id !== prevPId) {
      placeSessionCounts.set(p.place_id, (placeSessionCounts.get(p.place_id) ?? 0) + 1);
    }
    prevPId = p.place_id;
  }

  const placeIds = [...placeSessionCounts.keys()];
  const { data: placeRows } = placeIds.length
    ? await supabase.from("location_places").select("id, lat, lng, is_home").in("id", placeIds)
    : { data: [] };

  const visits = (placeRows ?? []).map((pl) => ({
    placeId: pl.id,
    lat: pl.lat,
    lng: pl.lng,
    isHome: pl.is_home,
    sessions: placeSessionCounts.get(pl.id) ?? 1,
  }));

  return {
    weekStart,
    weekEnd,
    tasks: {
      total: tasks.length,
      done: doneTasks.length,
      notDone: tasks.length - doneTasks.length,
      avgPoints: doneTasks.length ? Math.round(totalPoints / doneTasks.length) : 0,
      byDay,
    },
    habits: {
      totalPlanned: planned.length,
      totalCompleted: byHabit.reduce((s, h) => s + h.completed, 0),
      completionRate,
      byHabit,
    },
    timeBlocks: {
      totalPlanned: blocks.length,
      totalMinutes: taskMins + habitMins,
      byType: [
        { type: "task", minutes: Math.round(taskMins) },
        { type: "habit", minutes: Math.round(habitMins) },
      ],
    },
    locations: {
      uniquePlaces: visits.filter((v) => !v.isHome).length,
      visits,
      homeTime: "unknown",
    },
  };
}
