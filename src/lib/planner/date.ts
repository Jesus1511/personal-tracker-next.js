/** Calendar planning + daily routines: wall clock in Venezuela (UTC−04:00, no DST). */
export const PLANNER_DISPLAY_TIME_ZONE = "America/Caracas";

const VENEZUELA_OFFSET_FROM_UTC_HOURS = 4;

/** HH:mm in Caracas for an instant (timestamptz ISO from DB). */
export function isoToPlannerZoneHhMm(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: PLANNER_DISPLAY_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hh = (parts.find((p) => p.type === "hour")?.value ?? "0").padStart(2, "0");
  const mm = (parts.find((p) => p.type === "minute")?.value ?? "0").padStart(2, "0");
  return `${hh}:${mm}`;
}

/** UTC ISO instant for YYYY-MM-DD at HH:mm in Caracas. */
export function plannerZoneWallClockToUtcIso(dateYmd: string, hhmm: string): string {
  const [y, mo, d] = dateYmd.split("-").map(Number);
  const [hRaw, mRaw] = hhmm.split(":");
  const h = Number(hRaw);
  const m = Number(mRaw ?? "0");
  return new Date(
    Date.UTC(y, mo - 1, d, h + VENEZUELA_OFFSET_FROM_UTC_HOURS, m, 0, 0),
  ).toISOString();
}

/** Returns the local calendar date as YYYY-MM-DD, using the browser/device timezone. */
export function localDateString(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

export function normalizeDate(input: string | null | undefined): string {
  if (!input) {
    return new Date().toISOString().slice(0, 10);
  }

  const parsed = new Date(`${input}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid date format. Use YYYY-MM-DD.");
  }
  return input;
}

export function assertIsoDateTime(value: string, fieldName: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName}. Expected ISO date-time string.`);
  }
}

/** YYYY-MM-DD + delta días (zona fija al mediodía para evitar DST edge cases). */
export function addCalendarDays(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}
