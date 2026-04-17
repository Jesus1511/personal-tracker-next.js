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

type HabitType = { id: string; name: string; color: string | null };
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
      supabase.from("habit_types").select("id, name, color"),
      supabase.from("task_types").select("id, name, color"),
    ]);

    for (const err of [tErr, tbErr, atErr, ahErr, htErr, ttErr]) {
      if (err) throw new Error(err.message);
    }

    const tasks = (tasksRaw ?? []) as (Task & { scheduled_date: string; done: boolean })[];
    const timeBlocks = (timeBlocksRaw ?? []) as TimeBlockRow[];
    const actualTasks = (actualTasksRaw ?? []) as ActualTaskRow[];
    const actualHabits = (actualHabitsRaw ?? []) as ActualHabitRow[];
    const habitTypes = (habitTypesRaw ?? []) as HabitType[];
    const taskTypes = (taskTypesRaw ?? []) as TaskType[];

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
      else if (hours < 2) level = 1;
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

    return NextResponse.json({
      range: { start, end },
      pointsByDay,
      habitAdherence,
      focusHeatmap,
      hoursByDay,
      taskTypeDistribution,
      habitStreaks,
    });
  } catch (error) {
    return apiError(error);
  }
}
