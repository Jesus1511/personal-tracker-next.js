import { CRON_RUN_ON_DEV_START, DEV_CRON_INTERVAL_MS } from "@/lib/cron/config";

let startupEnvLogged = false;

type CronGlobals = typeof globalThis & {
  __notifCronTimer?: ReturnType<typeof setInterval>;
  __notifCronDidBootRun?: boolean;
};

const g = globalThis as CronGlobals;

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
 * Loop in-process: VPS/PM2 y `next dev`. En Vercel se omite (cron HTTP en vercel.json).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  logStartupCredentialsCheck();
  if (process.env.VERCEL) return;
  if (!CRON_RUN_ON_DEV_START) return;

  if (g.__notifCronTimer) {
    clearInterval(g.__notifCronTimer);
    g.__notifCronTimer = undefined;
  }

  const { runHourlyNotificationCron } = await import(
    "@/lib/cron/hourly-notifications"
  );

  const everySec = DEV_CRON_INTERVAL_MS / 1000;
  const run = async () => {
    try {
      console.log(
        "[cron/notifications] tick",
        new Date().toISOString(),
        `(dev cada ${everySec}s; prod HTTP /api/cron/hourly según vercel.json)`,
      );
      await runHourlyNotificationCron(new Date());
    } catch (e) {
      console.error("[cron/notifications] tick failed", e);
    }
  };

  const firstBoot = !g.__notifCronDidBootRun;
  g.__notifCronDidBootRun = true;
  if (firstBoot) void run();

  g.__notifCronTimer = setInterval(() => void run(), DEV_CRON_INTERVAL_MS);
}
