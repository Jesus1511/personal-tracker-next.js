import { getSupabaseAdminClient } from "@/lib/supabase/server";

export type TimeBlockInput = {
  scheduledDate: string;
  startAt: string;
  endAt: string;
  excludeId?: string;
};

export async function ensureNoTimeOverlap(input: TimeBlockInput): Promise<void> {
  const supabase = getSupabaseAdminClient();
  let query = supabase
    .from("time_blocks")
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
    throw new Error(`Unable to validate time overlap: ${error.message}`);
  }

  if (data && data.length > 0) {
    throw new Error("Time block overlaps with an existing block.");
  }
}
