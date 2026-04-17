"use client";

import { useMemo } from "react";

import { plannerTintBackground } from "@/lib/planner/color-tint";

import { TimeBlock } from "./types";

const WORK_DOT_COLOR = "#2563eb";

function blockDurationMinutes(block: TimeBlock): number {
  const start = new Date(block.start_at);
  const end = new Date(block.end_at);
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function formatDuration(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (totalMinutes === 0) return "0 min";
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

type Props = {
  timeBlocks: TimeBlock[];
};

export function PlannedTimeSummary({ timeBlocks }: Props) {
  const { workMinutes, habitRows } = useMemo(() => {
    let work = 0;
    const habitMap = new Map<
      string,
      { name: string; color: string | null; minutes: number }
    >();

    for (const b of timeBlocks) {
      const dur = blockDurationMinutes(b);
      if (dur === 0) continue;

      if (b.entry_type === "task") {
        work += dur;
      } else if (b.entry_type === "habit" && b.habit_type_id) {
        const prev = habitMap.get(b.habit_type_id);
        const name = b.habit_type?.name ?? "Hábito";
        const color = b.habit_type?.color ?? null;
        habitMap.set(b.habit_type_id, {
          name,
          color,
          minutes: (prev?.minutes ?? 0) + dur,
        });
      }
    }

    const habitRows = [...habitMap.entries()]
      .map(([id, row]) => ({ id, ...row }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { workMinutes: work, habitRows };
  }, [timeBlocks]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-zinc-200/80 bg-zinc-50/80 px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
      <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
        Plan del día
      </span>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: plannerTintBackground(WORK_DOT_COLOR) }}
            aria-hidden
          />
          <span className="font-medium text-zinc-800 dark:text-zinc-200">Work</span>
          <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
            {formatDuration(workMinutes)}
          </span>
        </div>
        {habitRows.map((row) => (
          <div key={row.id} className="flex items-center gap-2">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${row.color ? "" : "bg-zinc-300 dark:bg-zinc-600"}`}
              style={
                row.color ? { backgroundColor: plannerTintBackground(row.color) } : undefined
              }
              aria-hidden
            />
            <span className="font-medium text-zinc-800 dark:text-zinc-200">{row.name}</span>
            <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
              {formatDuration(row.minutes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
