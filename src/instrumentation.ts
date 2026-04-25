import { CRON_RUN_ON_DEV_START, DEV_CRON_INTERVAL_MS } from "@/lib/cron/config";

let startupEnvLogged = false;

function logStartupCredentialsCheck() {
  if (startupEnvLogged) return;
  startupEnvLogged = true;

  const requiredEnv = [
    "CRON_SECRET",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY|NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SECRET_KEY",
    "CLAUDE_API_KEY|ANTHROPIC_API_KEY",
    "EMAIL_USER",
    "EMAIL_PASS",
    "WEEKLY_EMAIL_FROM",
    "WEEKLY_EMAIL_TO",
  ];

  const getStatus = (name: string) => {
    if (name.includes("|")) {
      const options = name.split("|");
      return options.some((option) => Boolean(process.env[option]?.trim())) ? "OK" : "MISSING";
    }
    return process.env[name]?.trim() ? "OK" : "MISSING";
  };

  const checks = requiredEnv.map((name) => ({ name, status: getStatus(name) }));
  const missing = checks.filter((check) => check.status === "MISSING").map((check) => check.name);

  console.log("[startup/env] weekly-summary credentials check");
  for (const check of checks) {
    console.log(`[startup/env] ${check.name}: ${check.status}`);
  }
  if (missing.length) {
    console.error("[startup/env] missing credentials:", missing.join(", "));
  } else {
    console.log("[startup/env] all required credentials present");
  }
}

/**
 * `register` corre al arrancar el runtime Node (no en Edge).
 * En prod serverless cada cold-start lo repetiría, por eso solo en development.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  logStartupCredentialsCheck();
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
