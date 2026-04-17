import { getSupabaseAdminClient } from "@/lib/supabase/server";

export type ActualHabitInput = {
  scheduledDate: string;
  startAt: string;
  endAt: string;
  excludeId?: string;
};

/**
 * Checks that a new/updated actual-habit block does not overlap
 * with any other actual_habit_blocks on the same day.
 * Planned time_blocks are intentionally ignored — actuals sit on top of them.
 */
export async function ensureNoActualHabitOverlap(input: ActualHabitInput): Promise<void> {
  const supabase = getSupabaseAdminClient();
  let query = supabase
    .from("actual_habit_blocks")
    .select("id,start_at,end_at")
    .eq("scheduled_date", input.scheduledDate)
    .lt("start_at", input.endAt)
    .gt("end_at", input.startAt)
    .limit(1);

  if (input.excludeId) {
    query = query.neq("id", input.excludeId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Unable to validate actual-habit overlap: ${error.message}`);
  }
  if (data && data.length > 0) {
    throw new Error("El bloque se superpone con otro hábito real existente.");
  }
}
