#!/usr/bin/env node
/**
 * Crea una tarea y un bloque de tiempo en el calendario.
 *
 * Por defecto usa el 16 de abril de 2026 (fecha fija del plan).
 *
 * Uso:
 *   node scripts/seed-plan-block.mjs
 *   node scripts/seed-plan-block.mjs --date 2026-04-17   # otro día
 *
 * Requiere en .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY
 */

const DEFAULT_SCHEDULED_DATE = "2026-04-16";

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(join(root, name), "utf8");
      for (let line of raw.split("\n")) {
        line = line.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (process.env[k] === undefined) process.env[k] = v;
      }
      return;
    } catch {
      /* try next */
    }
  }
}

loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SECRET_KEY?.trim();
if (!url || !key) {
  console.error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SECRET_KEY.");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const dateArg = process.argv.find((a) => a.startsWith("--date"));
const scheduledDate = dateArg
  ? process.argv[process.argv.indexOf(dateArg) + 1]
  : DEFAULT_SCHEDULED_DATE;

const TASK_TITLE = "Avanazar hasta integrar AI en el personal planer";
/** Horas de pared en Venezuela (America/Caracas: UTC−4 todo el año). */
const START_HH_MM = "09:30";
const END_HH_MM = "11:00";
const VENEZUELA_OFFSET = "-04:00";

/**
 * ISO-8601 con offset explícito para que Postgres (timestamptz) guarde el instante correcto.
 * Sin offset, "2026-04-16T09:30:00" suele interpretarse como UTC, no como hora local VE.
 */
function toTimestamptzVenezuela(date, hhmm) {
  return `${date}T${hhmm}:00${VENEZUELA_OFFSET}`;
}

async function main() {
  console.log(`Fecha: ${scheduledDate}`);

  // 1. Find or create the task
  const { data: existing } = await supabase
    .from("tasks")
    .select("*")
    .eq("scheduled_date", scheduledDate)
    .eq("title", TASK_TITLE)
    .limit(1)
    .maybeSingle();

  let task = existing;

  if (task) {
    console.log(`Tarea ya existe: ${task.id}`);
  } else {
    const { data: maxRow } = await supabase
      .from("tasks")
      .select("sort_order")
      .eq("scheduled_date", scheduledDate)
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextSort = (maxRow?.sort_order ?? 0) + 1;

    const { data: created, error } = await supabase
      .from("tasks")
      .insert({
        title: TASK_TITLE,
        scheduled_date: scheduledDate,
        sort_order: nextSort,
      })
      .select("*")
      .single();

    if (error) {
      console.error("Error creando tarea:", error.message);
      process.exit(1);
    }
    task = created;
    console.log(`Tarea creada: ${task.id}`);
  }

  // 2. Check for overlapping time blocks
  const startAt = toTimestamptzVenezuela(scheduledDate, START_HH_MM);
  const endAt = toTimestamptzVenezuela(scheduledDate, END_HH_MM);
  console.log(
    `Ventana planeada (VE ${VENEZUELA_OFFSET}): ${startAt} → ${endAt} (en UTC: ${new Date(startAt).toISOString()} – ${new Date(endAt).toISOString()})`,
  );

  const { data: overlapping, error: overlapErr } = await supabase
    .from("time_blocks")
    .select("*, task:tasks(*, task_type:task_types(*)), habit_type:habit_types(*)")
    .eq("scheduled_date", scheduledDate)
    .lt("start_at", endAt)
    .gt("end_at", startAt);

  if (overlapErr) {
    console.error("Error comprobando solapes:", overlapErr.message);
    process.exit(1);
  }

  if (overlapping && overlapping.length > 0) {
    console.warn(
      `⚠  Ya existe(n) ${overlapping.length} bloque(s) que se superpone(n) con ${START_HH_MM}–${END_HH_MM}. No se crea el bloque.`,
    );
    console.warn(
      "JSON de los bloques en conflicto (misma forma que GET /api/planner/time-blocks):",
    );
    console.log(JSON.stringify(overlapping, null, 2));
    return;
  }

  // 3. Create the time block
  const { data: block, error: blockErr } = await supabase
    .from("time_blocks")
    .insert({
      scheduled_date: scheduledDate,
      start_at: startAt,
      end_at: endAt,
      entry_type: "task",
      task_id: task.id,
    })
    .select("*")
    .single();

  if (blockErr) {
    console.error("Error creando bloque:", blockErr.message);
    process.exit(1);
  }

  console.log(
    `Bloque creado: ${block.id}  (${START_HH_MM}–${END_HH_MM}) → "${TASK_TITLE}"`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
