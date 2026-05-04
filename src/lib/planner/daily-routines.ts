import { addCalendarDays, isoToPlannerZoneHhMm, plannerZoneWallClockToUtcIso } from "@/lib/planner/date";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

import { ensureNoTimeOverlap } from "./time-blocks";

/** If wall-clock end is not after start on the same calendar day in Caracas, use next day for end. */
function endIsoForRoutineBlockWallClock(
  scheduledDate: string,
  startClockHhMm: string,
  endClockHhMm: string,
): string {
  const startAt = plannerZoneWallClockToUtcIso(scheduledDate, startClockHhMm);
  let endAt = plannerZoneWallClockToUtcIso(scheduledDate, endClockHhMm);
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    endAt = plannerZoneWallClockToUtcIso(addCalendarDays(scheduledDate, 1), endClockHhMm);
  }
  return endAt;
}
export function toPgTime(value: string): string {
  const trimmed = value.trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return `${trimmed}:00`;
  if (/^\d{2}:\d{2}:\d{2}/.test(trimmed)) return trimmed.slice(0, 8);
  return trimmed;
}

export function timeToHhMm(value: string): string {
  const t = toPgTime(value);
  return t.slice(0, 5);
}

type TaskRow = {
  id: string;
  title: string;
  notes: string | null;
  points: number;
  task_type_id: string | null;
  sort_order: number;
};

type TimeBlockRow = {
  id: string;
  entry_type: string;
  start_at: string;
  end_at: string;
  task_id: string | null;
  habit_type_id: string | null;
  notes: string | null;
};

/** Replace routine template content from a day's planned tasks + time blocks. */
export async function replaceRoutineFromDay(routineId: string, sourceDate: string): Promise<void> {
  const supabase = getSupabaseAdminClient();

  const { error: delBlocksErr } = await supabase
    .from("daily_routine_time_blocks")
    .delete()
    .eq("routine_id", routineId);
  if (delBlocksErr) throw new Error(delBlocksErr.message);

  const { error: delTasksErr } = await supabase
    .from("daily_routine_tasks")
    .delete()
    .eq("routine_id", routineId);
  if (delTasksErr) throw new Error(delTasksErr.message);

  const { data: taskRows, error: taskErr } = await supabase
    .from("tasks")
    .select("id, title, notes, points, task_type_id, sort_order")
    .eq("scheduled_date", sourceDate)
    .order("sort_order", { ascending: true });
  if (taskErr) throw new Error(taskErr.message);

  const { data: blockRows, error: blockErr } = await supabase
    .from("time_blocks")
    .select("id, entry_type, start_at, end_at, task_id, habit_type_id, notes")
    .eq("scheduled_date", sourceDate)
    .order("start_at", { ascending: true });
  if (blockErr) throw new Error(blockErr.message);

  const tasks = (taskRows ?? []) as TaskRow[];
  const blocks = (blockRows ?? []) as TimeBlockRow[];

  const taskIdToRoutineTaskId = new Map<string, string>();

  for (const t of tasks) {
    const { data: inserted, error } = await supabase
      .from("daily_routine_tasks")
      .insert({
        routine_id: routineId,
        title: t.title,
        notes: t.notes ?? null,
        points: t.points ?? 0,
        task_type_id: t.task_type_id,
        sort_order: t.sort_order ?? 0,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    taskIdToRoutineTaskId.set(t.id, inserted.id);
  }

  let sortOrder = 0;
  for (const b of blocks) {
    if (b.entry_type !== "task" && b.entry_type !== "habit") continue;

    const startClock = isoToPlannerZoneHhMm(b.start_at);
    const endClock = isoToPlannerZoneHhMm(b.end_at);
    if (startClock === endClock) continue;

    let routineTaskId: string | null = null;
    let habitTypeId: string | null = null;

    if (b.entry_type === "habit") {
      if (!b.habit_type_id) continue;
      habitTypeId = b.habit_type_id;
    } else {
      if (b.task_id && taskIdToRoutineTaskId.has(b.task_id)) {
        routineTaskId = taskIdToRoutineTaskId.get(b.task_id)!;
      } else {
        const { data: placeholder, error: phErr } = await supabase
          .from("daily_routine_tasks")
          .insert({
            routine_id: routineId,
            title: "(Sin tarea en calendario)",
            notes: null,
            points: 0,
            task_type_id: null,
            sort_order: 999 + sortOrder,
          })
          .select("id")
          .single();
        if (phErr) throw new Error(phErr.message);
        routineTaskId = placeholder.id;
      }
    }

    const { error: insBlockErr } = await supabase.from("daily_routine_time_blocks").insert({
      routine_id: routineId,
      entry_type: b.entry_type,
      start_time: toPgTime(`${startClock}:00`),
      end_time: toPgTime(`${endClock}:00`),
      routine_task_id: routineTaskId,
      habit_type_id: habitTypeId,
      notes: b.notes ?? null,
      sort_order: sortOrder++,
    });
    if (insBlockErr) throw new Error(insBlockErr.message);
  }

  await supabase
    .from("daily_routines")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", routineId);
}

/** Delete planned tasks + time blocks for a day (not actual_*). */
export async function clearPlannedDay(scheduledDate: string): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error: tbErr } = await supabase.from("time_blocks").delete().eq("scheduled_date", scheduledDate);
  if (tbErr) throw new Error(tbErr.message);
  const { error: tErr } = await supabase.from("tasks").delete().eq("scheduled_date", scheduledDate);
  if (tErr) throw new Error(tErr.message);
}

type RoutineTaskTemplate = {
  id: string;
  title: string;
  notes: string | null;
  points: number;
  task_type_id: string | null;
  sort_order: number;
};

type RoutineBlockTemplate = {
  entry_type: "task" | "habit";
  start_time: string;
  end_time: string;
  routine_task_id: string | null;
  habit_type_id: string | null;
  notes: string | null;
  sort_order: number;
};

/** Apply routine template to a day: replaces planned content, records application. */
export async function applyRoutineToDay(routineId: string, scheduledDate: string): Promise<void> {
  const supabase = getSupabaseAdminClient();

  const { data: routine, error: rErr } = await supabase
    .from("daily_routines")
    .select("id")
    .eq("id", routineId)
    .maybeSingle();
  if (rErr) throw new Error(rErr.message);
  if (!routine) throw new Error("Routine not found.");

  const { data: rtRows, error: rtErr } = await supabase
    .from("daily_routine_tasks")
    .select("id, title, notes, points, task_type_id, sort_order")
    .eq("routine_id", routineId)
    .order("sort_order", { ascending: true });
  if (rtErr) throw new Error(rtErr.message);

  const { data: rbRows, error: rbErr } = await supabase
    .from("daily_routine_time_blocks")
    .select("entry_type, start_time, end_time, routine_task_id, habit_type_id, notes, sort_order")
    .eq("routine_id", routineId)
    .order("sort_order", { ascending: true });
  if (rbErr) throw new Error(rbErr.message);

  const rts = (rtRows ?? []) as RoutineTaskTemplate[];
  const rbs = (rbRows ?? []) as RoutineBlockTemplate[];

  const sortedBlocks = [...rbs].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  await clearPlannedDay(scheduledDate);

  const routineTaskIdToTaskId = new Map<string, string>();
  const orderedTasks = [...rts].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const rt of orderedTasks) {
    const { data: task, error: insErr } = await supabase
      .from("tasks")
      .insert({
        title: rt.title,
        notes: rt.notes ?? null,
        points: rt.points ?? 0,
        task_type_id: rt.task_type_id,
        scheduled_date: scheduledDate,
        sort_order: rt.sort_order ?? 0,
        done: false,
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    routineTaskIdToTaskId.set(rt.id, task.id);
  }

  for (const b of sortedBlocks) {
    const startClock = timeToHhMm(toPgTime(String(b.start_time)));
    const endClock = timeToHhMm(toPgTime(String(b.end_time)));
    const startAt = plannerZoneWallClockToUtcIso(scheduledDate, startClock);
    const endAt = endIsoForRoutineBlockWallClock(scheduledDate, startClock, endClock);

    if (b.entry_type === "habit") {
      if (!b.habit_type_id) throw new Error("Routine habit block missing habit_type_id.");
      await ensureNoTimeOverlap({ scheduledDate, startAt, endAt });
      const { error: insH } = await supabase.from("time_blocks").insert({
        scheduled_date: scheduledDate,
        start_at: startAt,
        end_at: endAt,
        entry_type: "habit",
        task_id: null,
        habit_type_id: b.habit_type_id,
        notes: b.notes ?? null,
      });
      if (insH) throw new Error(insH.message);
    } else {
      const taskId = b.routine_task_id ? routineTaskIdToTaskId.get(b.routine_task_id) : null;
      if (!taskId) throw new Error("Routine task block missing task mapping.");
      await ensureNoTimeOverlap({ scheduledDate, startAt, endAt });
      const { error: insT } = await supabase.from("time_blocks").insert({
        scheduled_date: scheduledDate,
        start_at: startAt,
        end_at: endAt,
        entry_type: "task",
        task_id: taskId,
        habit_type_id: null,
        notes: b.notes ?? null,
      });
      if (insT) throw new Error(insT.message);
    }
  }

  const now = new Date().toISOString();
  const { error: appErr } = await supabase.from("daily_routine_applications").upsert(
    {
      date: scheduledDate,
      routine_id: routineId,
      updated_at: now,
    },
    { onConflict: "date" },
  );
  if (appErr) throw new Error(appErr.message);
}
