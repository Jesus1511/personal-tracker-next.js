import {
  handleSendCustomNotification,
  type SendCustomNotificationInput,
} from "@/lib/push/handle-send-custom-notification";

import { habitPostWindowNudgeRule } from "./rules/habit-post-window-nudge";
import { planTomorrowBudgetRule } from "./rules/plan-tomorrow-budget";
import { rizeUnlinkedBlocksRule } from "./rules/rize-unlinked-blocks";

/**
 * Contexto UTC fijo en cada tick. Para reglas "hora local" usa
 * `Intl` con `timeZone: "America/Caracas"`.
 */
export type HourlyCronContext = {
  now: Date;
  /** YYYY-MM-DD (UTC) */
  dateUtc: string;
  /** 0–23 (UTC) */
  hourUtc: number;
  /** 0–59 (UTC) */
  minuteUtc: number;
};

function buildContext(now = new Date()): HourlyCronContext {
  return {
    now,
    dateUtc: now.toISOString().slice(0, 10),
    hourUtc: now.getUTCHours(),
    minuteUtc: now.getUTCMinutes(),
  };
}

/**
 * Regla estándar: el runner llama a `match` y, si es true, llama a
 * `buildNotification` para enviar UNA notificación.
 *
 * Para lógica multi-envío (p. ej. una notif por bloque Rize),
 * implementa `customRunner` y deja `match` en `() => false`.
 */
export type HourlyNotificationRule = {
  id: string;
  match: (ctx: HourlyCronContext) => boolean | Promise<boolean>;
  buildNotification: (ctx: HourlyCronContext) => SendCustomNotificationInput;
  /**
   * Opcional. Si está presente, el runner lo invoca en lugar del flujo
   * estándar match → buildNotification → send. Recibe `now` para cálculos
   * de tiempo absoluto sin depender del contexto UTC.
   */
  customRunner?: (now: Date) => Promise<unknown>;
};

export const hourlyNotificationRules: HourlyNotificationRule[] = [
  rizeUnlinkedBlocksRule,
  habitPostWindowNudgeRule,
  planTomorrowBudgetRule,
];

export type HourlyCronRuleRun = {
  ruleId: string;
  matched: boolean;
  sent?: number;
  message?: string;
  error?: string;
  /** Resultado libre de customRunner (si aplica). */
  custom?: unknown;
};

export type HourlyCronRunResult = {
  context: HourlyCronContext;
  rules: HourlyCronRuleRun[];
};

/**
 * Evalúa todas las reglas. Las que tienen `customRunner` lo invocan
 * directamente; las estándar usan match → buildNotification → send.
 */
export async function runHourlyNotificationCron(
  now = new Date(),
): Promise<HourlyCronRunResult> {
  const context = buildContext(now);
  const rules: HourlyCronRuleRun[] = [];

  for (const rule of hourlyNotificationRules) {
    const entry: HourlyCronRuleRun = { ruleId: rule.id, matched: false };

    try {
      if (rule.customRunner) {
        entry.matched = true;
        entry.custom = await rule.customRunner(now);
      } else {
        const matched = await rule.match(context);
        entry.matched = matched;
        if (!matched) {
          rules.push(entry);
          continue;
        }
        const input = rule.buildNotification(context);
        const result = await handleSendCustomNotification(input);
        entry.sent = result.sent;
        if (result.message) entry.message = result.message;
      }
    } catch (e) {
      entry.error = e instanceof Error ? e.message : String(e);
    }

    rules.push(entry);
  }

  return { context, rules };
}
