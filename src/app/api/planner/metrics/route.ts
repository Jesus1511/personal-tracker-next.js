import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

/** Builds an inclusive list of YYYY-MM-DD strings from start to end. */
function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Hours between two ISO timestamps, never negative. */
function hoursBetween(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Math.max(0, ms / 3_600_000);
}

/** Milliseconds overlap of two [start,end) intervals. */
function overlapMs(a0: number, a1: number, b0: number, b1: number): number {
  const s = Math.max(a0, b0);
  const e = Math.min(a1, b1);
  return Math.max(0, e - s);
}

/** Merge overlapping [start,end) intervals in ms. */
function mergeIntervalsMs(intervals: [number, number][]): [number, number][] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let cs = sorted[0][0];
  let ce = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= ce) ce = Math.max(ce, e);
    else {
      out.push([cs, ce]);
      cs = s;
      ce = e;
    }
  }
  out.push([cs, ce]);
  return out;
}

/** Sum ms of actual intervals that fall inside merged planned intervals. */
function actualInsidePlannedMs(
  actual: [number, number][],
  planned: [number, number][],
): number {
  if (actual.length === 0 || planned.length === 0) return 0;
  const merged = mergeIntervalsMs(planned);
  let sum = 0;
  for (const [as, ae] of actual) {
    for (const [ps, pe] of merged) {
      sum += overlapMs(as, ae, ps, pe);
    }
  }
  return sum;
}

type HabitType = { id: string; name: string; color: string | null; track_in_streaks: boolean };
type TaskType = { id: string; name: string; color: string | null };
type Task = { id: string; points: number; task_type_id: string | null };

type TimeBlockRow = {
  scheduled_date: string;
  start_at: string;
  end_at: string;
  entry_type: "task" | "habit";
  task_id: string | null;
  habit_type_id: string | null;
};

type ActualTaskRow = {
  scheduled_date: string;
  start_at: string;
  end_at: string;
  task_id: string | null;
  points_completed: number;
};

type ActualHabitRow = {
  scheduled_date: string;
  habit_type_id: string;
  start_at: string;
  end_at: string;
};

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const start = normalizeDate(sp.get("start"));
    const end = normalizeDate(sp.get("end"));

    if (new Date(end) < new Date(start)) {
      throw new Error("end must be >= start");
    }

    const supabase = getSupabaseAdminClient();

    const [
      { data: tasksRaw, error: tErr },
      { data: timeBlocksRaw, error: tbErr },
      { data: actualTasksRaw, error: atErr },
      { data: actualHabitsRaw, error: ahErr },
      { data: habitTypesRaw, error: htErr },
      { data: taskTypesRaw, error: ttErr },
      { data: dailyGoalsRaw, error: dgErr },
    ] = await Promise.all([
      supabase
        .from("tasks")
        .select("id, points, task_type_id, scheduled_date, done")
        .gte("scheduled_date", start)
        .lte("scheduled_date", end),
      supabase
        .from("time_blocks")
        .select("scheduled_date, start_at, end_at, entry_type, task_id, habit_type_id")
        .gte("scheduled_date", start)
        .lte("scheduled_date", end),
      supabase
        .from("actual_task_blocks")
        .select("scheduled_date, start_at, end_at, task_id, points_completed")
        .gte("scheduled_date", start)
        .lte("scheduled_date", end),
      supabase
        .from("actual_habit_blocks")
        .select("scheduled_date, habit_type_id, start_at, end_at")
        .gte("scheduled_date", start)
        .lte("scheduled_date", end),
      supabase.from("habit_types").select("id, name, color, track_in_streaks"),
      supabase.from("task_types").select("id, name, color"),
      supabase.from("daily_goals").select("date, done").gte("date", start).lte("date", end),
    ]);

    for (const err of [tErr, tbErr, atErr, ahErr, htErr, ttErr, dgErr]) {
      if (err) throw new Error(err.message);
    }

    const tasks = (tasksRaw ?? []) as (Task & { scheduled_date: string; done: boolean })[];
    const timeBlocks = (timeBlocksRaw ?? []) as TimeBlockRow[];
    const actualTasks = (actualTasksRaw ?? []) as ActualTaskRow[];
    const actualHabits = (actualHabitsRaw ?? []) as ActualHabitRow[];
    const habitTypes = ((habitTypesRaw ?? []) as (HabitType & { track_in_streaks?: boolean })[]).map(
      (h) => ({
        id: h.id,
        name: h.name,
        color: h.color,
        track_in_streaks: h.track_in_streaks !== false,
      }),
    );
    const taskTypes = (taskTypesRaw ?? []) as TaskType[];
    const dailyGoalsRows = (dailyGoalsRaw ?? []) as { date: string; done: boolean }[];

    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const habitTypeById = new Map(habitTypes.map((h) => [h.id, h]));
    const taskTypeById = new Map(taskTypes.map((t) => [t.id, t]));

    const days = enumerateDays(start, end);

    /* ---------- 1) Points planned vs completed per day ---------- */
    const plannedPointsByDay = new Map<string, number>();
    for (const t of tasks) {
      plannedPointsByDay.set(
        t.scheduled_date,
        (plannedPointsByDay.get(t.scheduled_date) ?? 0) + (t.points ?? 0),
      );
    }
    const completedPointsByDay = new Map<string, number>();
    for (const a of actualTasks) {
      completedPointsByDay.set(
        a.scheduled_date,
        (completedPointsByDay.get(a.scheduled_date) ?? 0) + (a.points_completed ?? 0),
      );
    }
    const pointsByDay = days.map((date) => ({
      date,
      planned: plannedPointsByDay.get(date) ?? 0,
      completed: completedPointsByDay.get(date) ?? 0,
    }));

    /* ---------- 2) Habit adherence by type ---------- */
    const plannedHabitCount = new Map<string, number>();
    for (const tb of timeBlocks) {
      if (tb.entry_type === "habit" && tb.habit_type_id) {
        plannedHabitCount.set(
          tb.habit_type_id,
          (plannedHabitCount.get(tb.habit_type_id) ?? 0) + 1,
        );
      }
    }
    const actualHabitCount = new Map<string, number>();
    for (const ah of actualHabits) {
      actualHabitCount.set(
        ah.habit_type_id,
        (actualHabitCount.get(ah.habit_type_id) ?? 0) + 1,
      );
    }
    const habitAdherence = habitTypes
      .map((h) => {
        const planned = plannedHabitCount.get(h.id) ?? 0;
        const actual = actualHabitCount.get(h.id) ?? 0;
        const adherencePct = planned > 0 ? Math.round((actual / planned) * 100) : null;
        return {
          habitTypeId: h.id,
          name: h.name,
          color: h.color,
          planned,
          actual,
          adherencePct,
        };
      })
      .filter((r) => r.planned > 0 || r.actual > 0)
      .sort((a, b) => (b.actual + b.planned) - (a.actual + a.planned));

    /* ---------- 3) Focus heatmap (real focus hours/day) ---------- */
    const focusHoursByDay = new Map<string, number>();
    for (const a of actualTasks) {
      focusHoursByDay.set(
        a.scheduled_date,
        (focusHoursByDay.get(a.scheduled_date) ?? 0) + hoursBetween(a.start_at, a.end_at),
      );
    }
    const focusHeatmap = days.map((date) => {
      const hours = +(focusHoursByDay.get(date) ?? 0).toFixed(2);
      let level: 0 | 1 | 2 | 3 | 4;
      if (hours === 0) level = 0;
      else if (hours < 2.5) level = 1;
      else if (hours < 4) level = 2;
      else if (hours < 6) level = 3;
      else level = 4;
      return { date, hours, level };
    });

    /* ---------- 4) Planned vs actual task hours per day ---------- */
    const plannedTaskHoursByDay = new Map<string, number>();
    for (const tb of timeBlocks) {
      if (tb.entry_type === "task") {
        plannedTaskHoursByDay.set(
          tb.scheduled_date,
          (plannedTaskHoursByDay.get(tb.scheduled_date) ?? 0) +
            hoursBetween(tb.start_at, tb.end_at),
        );
      }
    }
    const hoursByDay = days.map((date) => ({
      date,
      plannedHours: +(plannedTaskHoursByDay.get(date) ?? 0).toFixed(2),
      actualHours: +(focusHoursByDay.get(date) ?? 0).toFixed(2),
    }));

    /* ---------- 4b) Daily goals + routine adherence per day ---------- */
    const goalByDate = new Map(dailyGoalsRows.map((g) => [g.date, g.done]));
    const dailyGoalsByDay = days.map((date) => ({
      date,
      hasGoal: goalByDate.has(date),
      done: goalByDate.get(date) ?? false,
    }));

    const plannedTaskIntervalsByDay = new Map<string, [number, number][]>();
    for (const tb of timeBlocks) {
      if (tb.entry_type !== "task") continue;
      if (!plannedTaskIntervalsByDay.has(tb.scheduled_date)) {
        plannedTaskIntervalsByDay.set(tb.scheduled_date, []);
      }
      plannedTaskIntervalsByDay.get(tb.scheduled_date)!.push([
        new Date(tb.start_at).getTime(),
        new Date(tb.end_at).getTime(),
      ]);
    }
    const actualIntervalsByDay = new Map<string, [number, number][]>();
    for (const a of actualTasks) {
      if (!actualIntervalsByDay.has(a.scheduled_date)) actualIntervalsByDay.set(a.scheduled_date, []);
      actualIntervalsByDay.get(a.scheduled_date)!.push([
        new Date(a.start_at).getTime(),
        new Date(a.end_at).getTime(),
      ]);
    }

    const routineByDay = days.map((date) => {
      const plannedH = plannedTaskHoursByDay.get(date) ?? 0;
      const actualH = focusHoursByDay.get(date) ?? 0;
      const plannedIntervals = plannedTaskIntervalsByDay.get(date) ?? [];
      const actIntervals = actualIntervalsByDay.get(date) ?? [];
      let totalActualMs = 0;
      for (const [as, ae] of actIntervals) totalActualMs += Math.max(0, ae - as);
      const insideMs =
        plannedIntervals.length > 0 && actIntervals.length > 0
          ? actualInsidePlannedMs(actIntervals, plannedIntervals)
          : 0;
      const hoursRatio = plannedH > 0 ? Math.min(1, actualH / plannedH) : 0;
      const timeWindowScore = totalActualMs > 0 ? insideMs / totalActualMs : 0;
      const routineScore = +(hoursRatio * timeWindowScore * 100).toFixed(1);
      return {
        date,
        hoursScore: +(hoursRatio * 100).toFixed(1),
        timeWindowScore: +(timeWindowScore * 100).toFixed(1),
        routineScore,
      };
    });

    /* ---------- 5) Real hours distribution by task_type ---------- */
    const hoursByTaskType = new Map<string | null, number>();
    for (const a of actualTasks) {
      const task = a.task_id ? taskById.get(a.task_id) : null;
      const typeId = task?.task_type_id ?? null;
      hoursByTaskType.set(
        typeId,
        (hoursByTaskType.get(typeId) ?? 0) + hoursBetween(a.start_at, a.end_at),
      );
    }
    const taskTypeDistribution = Array.from(hoursByTaskType.entries())
      .map(([id, hours]) => ({
        taskTypeId: id,
        name: id ? (taskTypeById.get(id)?.name ?? "Desconocido") : "Sin categoría",
        color: id ? (taskTypeById.get(id)?.color ?? null) : null,
        hours: +hours.toFixed(2),
      }))
      .filter((r) => r.hours > 0)
      .sort((a, b) => b.hours - a.hours);

    /* ---------- 6) Habit streaks (current + best in selected range) ---------- */
    // Build per-habit set of YYYY-MM-DD where they logged at least one actual block.
    const daysByHabit = new Map<string, Set<string>>();
    for (const ah of actualHabits) {
      if (!daysByHabit.has(ah.habit_type_id)) daysByHabit.set(ah.habit_type_id, new Set());
      daysByHabit.get(ah.habit_type_id)!.add(ah.scheduled_date);
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const habitStreaks = habitTypes
      .filter((h) => h.track_in_streaks)
      .map((h) => {
        const set = daysByHabit.get(h.id) ?? new Set<string>();
        let current = 0;
        // Current streak walks back from today while the habit has presence.
        const cursor = new Date(todayStr + "T00:00:00");
        while (set.has(cursor.toISOString().slice(0, 10))) {
          current++;
          cursor.setDate(cursor.getDate() - 1);
        }
        // Best streak within the queried range.
        let best = 0;
        let run = 0;
        for (const d of days) {
          if (set.has(d)) {
            run++;
            if (run > best) best = run;
          } else {
            run = 0;
          }
        }
        return {
          habitTypeId: h.id,
          name: h.name,
          color: h.color,
          currentStreak: current,
          bestStreak: best,
        };
      })
      .filter((r) => r.bestStreak > 0 || r.currentStreak > 0)
      .sort((a, b) => b.currentStreak - a.currentStreak || b.bestStreak - a.bestStreak);

    const streakTracking = {
      total: habitTypes.length,
      tracked: habitTypes.filter((h) => h.track_in_streaks).length,
    };

    /* ---------- 7) Habit daily presence heatmap ---------- */
    const habitDailyMap = habitTypes.map((h) => {
      const doneSet = daysByHabit.get(h.id) ?? new Set<string>();
      return {
        id: h.id,
        name: h.name,
        color: h.color,
        byDay: days.map((date) => ({ date, done: doneSet.has(date) })),
      };
    });

    /* ---------- 8) Habit cross chart: hours per habit-type per day ---------- */
    const habitHoursByTypeByDay = new Map<string, Map<string, number>>();
    for (const ah of actualHabits) {
      if (!habitHoursByTypeByDay.has(ah.habit_type_id)) {
        habitHoursByTypeByDay.set(ah.habit_type_id, new Map());
      }
      const byDay = habitHoursByTypeByDay.get(ah.habit_type_id)!;
      byDay.set(
        ah.scheduled_date,
        (byDay.get(ah.scheduled_date) ?? 0) + hoursBetween(ah.start_at, ah.end_at),
      );
    }

    const habitCrossData = [
      // Special "work" series built from already-computed focusHoursByDay
      {
        id: "__work__",
        name: "Trabajo",
        color: "#8b5cf6",
        isWork: true,
        byDay: days.map((date) => ({
          date,
          hours: +(focusHoursByDay.get(date) ?? 0).toFixed(2),
        })),
      },
      // One entry per habit type that has at least one actual block in range
      ...habitTypes
        .filter((h) => habitHoursByTypeByDay.has(h.id))
        .map((h) => {
          const byDay = habitHoursByTypeByDay.get(h.id)!;
          return {
            id: h.id,
            name: h.name,
            color: h.color,
            isWork: false,
            byDay: days.map((date) => ({
              date,
              hours: +(byDay.get(date) ?? 0).toFixed(2),
            })),
          };
        }),
    ];

    return NextResponse.json({
      range: { start, end },
      pointsByDay,
      habitAdherence,
      focusHeatmap,
      hoursByDay,
      dailyGoalsByDay,
      routineByDay,
      taskTypeDistribution,
      habitStreaks,
      streakTracking,
      habitCrossData,
      habitDailyMap,
    });
  } catch (error) {
    return apiError(error);
  }
}
