import { NextRequest, NextResponse } from "next/server";

import { normalizeDate } from "@/lib/planner/date";
import { apiError } from "@/lib/planner/http";
import { fetchRizeTimeEntries, RawTimeEntryNode } from "@/lib/rize/time-entries";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

const TOLERANCE_START_END_MS = 30 * 60 * 1000;
const TOLERANCE_DURATION_MS = 20 * 60 * 1000;

const SELECT_WITH_RELATIONS = "*, task:tasks(*, task_type:task_types(*))";

type PlannedBlock = {
  id: string;
  task_id: string | null;
  start_at: string;
  end_at: string;
};

/**
 * Computes absolute diff between two ISO timestamps in milliseconds.
 */
function diffMs(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime());
}

function durationMs(start: string, end: string): number {
  return new Date(end).getTime() - new Date(start).getTime();
}

type MatchResult = {
  rizeEntry: RawTimeEntryNode;
  plannedBlock: PlannedBlock | null;
  score: number;
};

/**
 * Matches Rize entries to planned task blocks using tolerances.
 * Each planned block can only be matched once (best-fit-first).
 *
 * Matching criteria (all three must hold):
 *   |start diff| <= 30 min
 *   |end diff|   <= 30 min
 *   |duration diff| <= 20 min
 *
 * When multiple blocks qualify, picks the one with the smallest total diff.
 */
function matchEntriesToBlocks(
  rizeEntries: RawTimeEntryNode[],
  plannedBlocks: PlannedBlock[],
): MatchResult[] {
  type Candidate = {
    rizeIdx: number;
    blockIdx: number;
    score: number;
  };

  const candidates: Candidate[] = [];

  for (let ri = 0; ri < rizeEntries.length; ri++) {
    const entry = rizeEntries[ri];
    const rizeDuration = entry.duration != null
      ? entry.duration * 1000
      : durationMs(entry.startTime, entry.endTime);

    for (let bi = 0; bi < plannedBlocks.length; bi++) {
      const block = plannedBlocks[bi];
      const startDiff = diffMs(entry.startTime, block.start_at);
      const endDiff = diffMs(entry.endTime, block.end_at);
      const plannedDuration = durationMs(block.start_at, block.end_at);
      const durDiff = Math.abs(rizeDuration - plannedDuration);

      if (
        startDiff <= TOLERANCE_START_END_MS &&
        endDiff <= TOLERANCE_START_END_MS &&
        durDiff <= TOLERANCE_DURATION_MS
      ) {
        candidates.push({
          rizeIdx: ri,
          blockIdx: bi,
          score: startDiff + endDiff + durDiff,
        });
      }
    }
  }

  candidates.sort((a, b) => a.score - b.score);

  const usedRize = new Set<number>();
  const usedBlock = new Set<number>();
  const matched = new Map<number, { blockIdx: number; score: number }>();

  for (const c of candidates) {
    if (usedRize.has(c.rizeIdx) || usedBlock.has(c.blockIdx)) continue;
    usedRize.add(c.rizeIdx);
    usedBlock.add(c.blockIdx);
    matched.set(c.rizeIdx, { blockIdx: c.blockIdx, score: c.score });
  }

  return rizeEntries.map((entry, i) => {
    const m = matched.get(i);
    return {
      rizeEntry: entry,
      plannedBlock: m ? plannedBlocks[m.blockIdx] : null,
      score: m?.score ?? Infinity,
    };
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { date?: string };
    const date = normalizeDate(body.date);
    const supabase = getSupabaseAdminClient();

    const [rizeEntries, { data: plannedBlocks, error: blocksError }] = await Promise.all([
      fetchRizeTimeEntries(date),
      supabase
        .from("time_blocks")
        .select("id, task_id, start_at, end_at")
        .eq("scheduled_date", date)
        .eq("entry_type", "task")
        .order("start_at", { ascending: true }),
    ]);

    if (blocksError) throw new Error(blocksError.message);

    const rizeIds = new Set(rizeEntries.map((e) => e.id));

    const { data: existingRows, error: existingError } = await supabase
      .from("actual_task_blocks")
      .select("id, rize_entry_id, user_completion_link, task_id, planned_block_id")
      .eq("scheduled_date", date);

    if (existingError) throw new Error(existingError.message);

    const existingByRize = new Map(
      (existingRows ?? []).map((r) => [r.rize_entry_id, r] as const),
    );

    const staleIds = (existingRows ?? [])
      .filter((row) => !rizeIds.has(row.rize_entry_id) && !row.user_completion_link)
      .map((row) => row.id);

    if (staleIds.length > 0) {
      const { error: delError } = await supabase
        .from("actual_task_blocks")
        .delete()
        .in("id", staleIds);
      if (delError) throw new Error(delError.message);
    }

    const reservedPlannedIds = new Set(
      (existingRows ?? [])
        .filter((r) => r.user_completion_link && r.planned_block_id)
        .map((r) => r.planned_block_id as string),
    );

    const blocksForMatch = ((plannedBlocks ?? []) as PlannedBlock[]).filter(
      (b) => !reservedPlannedIds.has(b.id),
    );

    const matches = matchEntriesToBlocks(rizeEntries, blocksForMatch);

    for (const match of matches) {
      const entry = match.rizeEntry;
      const block = match.plannedBlock;
      const prev = existingByRize.get(entry.id);

      const baseRow = {
        scheduled_date: date,
        start_at: entry.startTime,
        end_at: entry.endTime,
        rize_entry_id: entry.id,
        rize_title: entry.title?.trim() || "Sin título",
        updated_at: new Date().toISOString(),
      };

      const row =
        prev?.user_completion_link === true
          ? {
              ...baseRow,
              task_id: prev.task_id,
              planned_block_id: prev.planned_block_id,
              user_completion_link: true,
            }
          : {
              ...baseRow,
              task_id: block?.task_id ?? null,
              planned_block_id: block?.id ?? null,
              user_completion_link: false,
            };

      // Evitar upsert(onConflict: rize_entry_id): requiere un UNIQUE no parcial en esa columna.
      const { data: syncedUpdate, error: updateError } = await supabase
        .from("actual_task_blocks")
        .update(row)
        .eq("rize_entry_id", entry.id)
        .select("id");
      if (updateError) throw new Error(updateError.message);
      if (!syncedUpdate?.length) {
        const { error: insertError } = await supabase.from("actual_task_blocks").insert(row);
        if (insertError) throw new Error(insertError.message);
      }
    }

    const { data: result, error: resultError } = await supabase
      .from("actual_task_blocks")
      .select(SELECT_WITH_RELATIONS)
      .eq("scheduled_date", date)
      .order("start_at", { ascending: true });

    if (resultError) throw new Error(resultError.message);

    return NextResponse.json({ actualTaskBlocks: result ?? [] });
  } catch (error) {
    return apiError(error);
  }
}
