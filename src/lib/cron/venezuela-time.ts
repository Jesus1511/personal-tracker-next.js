/** Calendario y reloj del planner (Venezuela, UTC−4). */
export const PLANNER_TZ = "America/Caracas";

/** YYYY-MM-DD del instante `d` en America/Caracas. */
export function plannerDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PLANNER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Fecha VET de un ISO (p. ej. fin de sesión Rize). */
export function plannerDateFromIso(iso: string): string {
  return plannerDate(new Date(iso));
}

export function getCaracasClock(now: Date): { hour: number; minute: number } {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: PLANNER_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { hour: h, minute: m };
}

/**
 * Ventana al inicio de cada hora VET (tolerancia a cron/retrasos).
 * Con `CRON_EVERY_MINUTE` false, las reglas solo corren en este tramo.
 */
export function isPlannerHourlyTick(now: Date, toleranceMinutes = 15): boolean {
  return getCaracasClock(now).minute < toleranceMinutes;
}
