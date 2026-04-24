/**
 * Ajusta aquí (no env).
 *
 * Cada minuto: `true` y en `vercel.json` cron schedule `* * * * *`.
 * Cada hora: `false` y schedule `0 * * * *` (Vercel invoca 1×/h).
 * Si dejas `* * * * *` con `CRON_EVERY_MINUTE` false, solo corre la lógica
 * en el minuto 0 de cada hora (resto: skip rápido).
 */
export const CRON_EVERY_MINUTE = true;

/** `next dev`: correr notificaciones al levantar el server y luego en loop cada `DEV_CRON_INTERVAL_MS`. */
export const CRON_RUN_ON_DEV_START = true;

/** Intervalo del loop en dev (ms). 60_000 = cada minuto. */
export const DEV_CRON_INTERVAL_MS = 60_000;

/**
 * Tiempo mínimo desde el **fin** del bloque Rize hasta notificar
 * (sin `points_completed` en su fila vinculada). Prod: 1 h. Prueba: 60_000.
 */
export const RIZE_UNLINKED_MIN_AGE_MS = 60 * 60 * 1000;

/** Si el cron pega cada minuto pero quieres lógica solo cada hora (horario UTC). */
export function shouldRunCronNotificationLogic(now: Date): boolean {
  if (CRON_EVERY_MINUTE) return true;
  return now.getUTCMinutes() === 0;
}
