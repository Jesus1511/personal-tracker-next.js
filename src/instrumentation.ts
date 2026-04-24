import { CRON_RUN_ON_DEV_START, DEV_CRON_INTERVAL_MS } from "@/lib/cron/config";

/**
 * `register` corre al arrancar el runtime Node (no en Edge).
 * En prod serverless cada cold-start lo repetiría, por eso solo en development.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  if (process.env.NODE_ENV !== "development") return;
  if (!CRON_RUN_ON_DEV_START) return;

  const { runHourlyNotificationCron } = await import(
    "@/lib/cron/hourly-notifications"
  );

  const run = async () => {
    try {
      console.log("[cron/hourly] tick", new Date().toISOString());
      await runHourlyNotificationCron(new Date());
    } catch (e) {
      console.error("[cron/hourly] tick failed", e);
    }
  };

  // Primer disparo inmediato
  void run();

  // Loop cada DEV_CRON_INTERVAL_MS
  setInterval(() => void run(), DEV_CRON_INTERVAL_MS);
}
