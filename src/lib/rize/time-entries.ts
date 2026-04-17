import { queryRize } from "./graphql";

/**
 * Un solo usuario (Venezuela). Los días del planner y el rango enviado a Rize
 * siguen el calendario en America/Caracas (VET, UTC−4 fijo desde 2016).
 */
const PLANNER_TIME_ZONE = "America/Caracas";

function venezuelaDayBoundsIso(dateYmd: string): { startTime: string; endTime: string } {
  return {
    startTime: `${dateYmd}T00:00:00.000-04:00`,
    endTime: `${dateYmd}T23:59:59.999-04:00`,
  };
}

/** YYYY-MM-DD del instante `iso` visto en la zona del planner. */
function calendarDateInPlannerZone(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PLANNER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * A Rize Session (focus, break, meeting, etc.) as returned by the `sessions`
 * GraphQL query.  There is no `duration` field — compute it from the timestamps.
 *
 * We intentionally do not request `tasks` / `projects` subselections: Rize has
 * returned null for those on some sessions while the schema marks them
 * non-nullable, which fails the entire `sessions` list with a GraphQL error.
 */
export type RizeSession = {
  id: string;
  title: string | null;
  type: string;
  source: string;
  startTime: string;
  endTime: string;
};

/**
 * Alias kept for callers that used the old type name.
 * `task` / `project` are always null — we no longer load them from Rize here.
 */
export type RawTimeEntryNode = RizeSession & {
  /** Always null — sessions have no server-side duration field. */
  duration: null;
  task: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
};

type RizeSessionsResponse = {
  sessions: RizeSession[];
};

const SESSIONS_QUERY = `
  query Sessions($startTime: ISO8601DateTime!, $endTime: ISO8601DateTime!) {
    sessions(startTime: $startTime, endTime: $endTime, sort: start_time) {
      id
      title
      type
      source
      startTime
      endTime
    }
  }
`;

/**
 * Fetches focus sessions for a calendar day in Venezuela (`date` = YYYY-MM-DD).
 * Uses explicit VET bounds for the GraphQL range and keeps only sessions whose
 * start falls on that same calendar date in Caracas (evita colados por solape).
 */
export async function fetchRizeFocusSessions(date: string): Promise<RizeSession[]> {
  const { startTime, endTime } = venezuelaDayBoundsIso(date);
  const response = await queryRize<RizeSessionsResponse>(SESSIONS_QUERY, {
    startTime,
    endTime,
  });
  return response.sessions.filter(
    (s) =>
      s.type === "focus" && calendarDateInPlannerZone(s.startTime) === date,
  );
}

/**
 * Legacy wrapper — returns focus sessions shaped as RawTimeEntryNode so
 * existing callers (sync route) don't need changes.
 */
export async function fetchRizeTimeEntries(date: string): Promise<RawTimeEntryNode[]> {
  const sessions = await fetchRizeFocusSessions(date);
  return sessions.map((s) => ({
    ...s,
    duration: null,
    task: null,
    project: null,
  }));
}
