import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";

import {
  attachAnalysisLookupCatalogs,
  expandTablesForFetch,
  fetchAnalysisTableRows,
  resolveAppliedRoutineIdsForAnalysis,
} from "./fetch-analysis-table-rows";
import { ANALYZABLE_TABLE_KEYS, type AnalyzableTable } from "./types";

export const PLANNER_TOOLS: Anthropic.Tool[] = [
  {
    name: "query_table",
    description:
      "Query a planner table filtered by date range. Returns all matching rows as JSON. " +
      "Call this to fetch the data you need before answering.",
    input_schema: {
      type: "object" as const,
      properties: {
        table: {
          type: "string",
          enum: [
            "tasks",
            "time_blocks",
            "actual_task_blocks",
            "actual_habit_blocks",
            "daily_goals",
            "daily_summaries",
            "routines",
          ],
          description: "The planner table to query.",
        },
        date_start: {
          type: "string",
          description: "Start date (inclusive) in YYYY-MM-DD format.",
        },
        date_end: {
          type: "string",
          description: "End date (inclusive) in YYYY-MM-DD format.",
        },
      },
      required: ["table", "date_start", "date_end"],
    },
  },
  {
    name: "query_lookup_catalogs",
    description:
      "Fetch the task_types and habit_types catalogs. Use this to resolve type names when rows contain type IDs.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

type QueryTableInput = {
  table: string;
  date_start: string;
  date_end: string;
};

type ToolInput = Record<string, unknown>;

export async function executeDbTool(
  supabase: SupabaseClient,
  allowedTables: AnalyzableTable[],
  toolName: string,
  rawInput: ToolInput,
): Promise<unknown> {
  if (toolName === "query_table") {
    const input = rawInput as QueryTableInput;
    const table = input.table;

    if (!ANALYZABLE_TABLE_KEYS.has(table as AnalyzableTable)) {
      return { error: `Unknown table: ${table}` };
    }

    const allowed = new Set<string>(allowedTables);
    if (!allowed.has(table)) {
      return {
        error: `Table "${table}" is not in the allowed list for this analysis.`,
      };
    }

    const tableKey = table as AnalyzableTable;
    const appliedRoutineIds = await resolveAppliedRoutineIdsForAnalysis(
      supabase,
      [tableKey],
      input.date_start,
      input.date_end,
    );
    const fetchKeys = expandTablesForFetch([tableKey]);
    const tableData: Record<string, unknown[]> = {};
    await Promise.all(
      fetchKeys.map(async (t) => {
        tableData[t] = await fetchAnalysisTableRows(
          supabase,
          t,
          input.date_start,
          input.date_end,
          { appliedRoutineIds },
        );
      }),
    );
    return tableData;
  }

  if (toolName === "query_lookup_catalogs") {
    const tableData: Record<string, unknown[]> = {};
    await attachAnalysisLookupCatalogs(supabase, tableData);
    return {
      task_types: tableData.task_types ?? [],
      habit_types: tableData.habit_types ?? [],
    };
  }

  return { error: `Unknown tool: ${toolName}` };
}
