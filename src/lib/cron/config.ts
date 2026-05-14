/**
 * Ajusta aquí (no env).
 *
 * Cada minuto: `true` y en `vercel.json` cron schedule `* * * * *`.
 * Cada hora: `false` y schedule `0 * * * *` (Vercel invoca 1×/h).
 * Si dejas `* * * * *` con `CRON_EVERY_MINUTE` false, la ruta HTTP ignora ticks
 * salvo los primeros ~20 min de cada hora UTC (tolerancia a retrasos de Vercel).
 */
export const CRON_EVERY_MINUTE = false;

/** Al levantar Node (dev o prod) y luego cada `DEV_CRON_INTERVAL_MS`. En Vercel no aplica (ver instrumentation). */
export const CRON_RUN_ON_DEV_START = true;

/**
 * Intervalo del timer en `instrumentation` cuando NO es Vercel (PM2/VPS/local).
 * Tiene que ser ≤ 60_000 si usas hora+minuto VET exactos; 1 h desde el boot casi nunca pega a :55.
 * En Vercel este valor no se usa (no hay timer; va el cron HTTP).
 */
export const DEV_CRON_INTERVAL_MS = process.env.VERCEL ? 3_600_000 : 60_000;

/**
 * Tiempo mínimo desde el **fin** del bloque Rize hasta notificar
 * (sin `points_completed` en su fila vinculada). Prod: 1 h. Prueba: 60_000.
 */
export const RIZE_UNLINKED_MIN_AGE_MS = 60 * 60 * 1000;

/** Hora 0–23 en `America/Caracas` para el push “escribe resumen del día”. */
export const DAILY_SUMMARY_REMINDER_HOUR_VET = 14;

/**
 * Minuto 0–59 en esa misma zona. Con cron solo cada hora (~:00 UTC) suele pegar a minuto 0 VET;
 * si pones otro minuto, usa `CRON_EVERY_MINUTE = true` + `* * * * *` en vercel o `DEV_CRON_INTERVAL_MS = 60_000`.
 */
export const DAILY_SUMMARY_REMINDER_MINUTE_VET = 4;

/**
 * Si el cron pega cada minuto pero quieres lógica solo cada hora (horario UTC).
 * En Vercel la invocación a veces llega varios minutos después del :00 UTC;
 * si exigimos minuto === 0 nunca corren las reglas (incl. hora Venezuela).
 */
export function shouldRunCronNotificationLogic(now: Date): boolean {
  if (CRON_EVERY_MINUTE) return true;
  // Sin VERCEL (curl/systemd a tu VM): cualquier minuto UTC vale.
  if (!process.env.VERCEL) return true;
  return now.getUTCMinutes() < 20;
}
