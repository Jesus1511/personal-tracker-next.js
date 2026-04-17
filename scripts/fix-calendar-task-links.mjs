#!/usr/bin/env node
/**
 * Corrige time_blocks (calendario) de tipo tarea cuando el texto en `notes`
 * coincide con el título de una tarea del mismo día: actualiza `task_id`
 * al id de esa tarea (estable, orden por id).
 *
 * Después, si `notes` solo repite el título de la tarea ya enlazada, lo pone en NULL.
 *
 * Uso (desde la raíz del proyecto):
 *   node scripts/fix-calendar-task-links.mjs
 *   node scripts/fix-calendar-task-links.mjs --dry-run
 *
 * Requiere en .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadEnvFromRoot() {
  for (const name of [".env.local", ".env"]) {
    try {
      const p = join(root, name);
      const raw = readFileSync(p, "utf8");
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

function norm(s) {
  if (s == null) return "";
  return String(s).trim().toLowerCase();
}

loadEnvFromRoot();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SECRET_KEY?.trim();

if (!url || !key) {
  console.error(
    "Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SECRET_KEY (revisa .env.local).",
  );
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const { data: blocks, error: blocksError } = await supabase
    .from("time_blocks")
    .select("id, scheduled_date, task_id, notes")
    .eq("entry_type", "task");

  if (blocksError) throw blocksError;

  const { data: allTasks, error: tasksError } = await supabase
    .from("tasks")
    .select("id, title, scheduled_date");

  if (tasksError) throw tasksError;

  /** @type {Map<string, Array<{ id: string; title: string; scheduled_date: string }>>} */
  const tasksByDate = new Map();
  for (const t of allTasks ?? []) {
    const d = t.scheduled_date;
    if (!tasksByDate.has(d)) tasksByDate.set(d, []);
    tasksByDate.get(d).push(t);
  }

  let fixedTaskIds = 0;
  let clearedNotes = 0;

  for (const b of blocks ?? []) {
    const noteNorm = norm(b.notes);
    const dayTasks = tasksByDate.get(b.scheduled_date) ?? [];

    if (noteNorm) {
      const matches = dayTasks.filter((t) => norm(t.title) === noteNorm);
      if (matches.length > 0) {
        const chosen = [...matches].sort((a, c) => a.id.localeCompare(c.id))[0];
        if (chosen.id !== b.task_id) {
          if (matches.length > 1) {
            console.warn(
              `  [aviso] ${b.scheduled_date}: varias tareas con título "${chosen.title}" — usando ${chosen.id}`,
            );
          }
          console.log(
            `[task_id] ${b.id} (${b.scheduled_date}): ${b.task_id} → ${chosen.id} («${chosen.title}»)`,
          );
          if (!dryRun) {
            const { error } = await supabase
              .from("time_blocks")
              .update({ task_id: chosen.id, updated_at: new Date().toISOString() })
              .eq("id", b.id);
            if (error) throw error;
          }
          fixedTaskIds++;
          b.task_id = chosen.id;
        }
      }
    }

    const linked = dayTasks.find((t) => t.id === b.task_id);
    if (linked && noteNorm && norm(linked.title) === noteNorm) {
      console.log(`[notes]   ${b.id}: limpiar notes (igual al título enlazado)`);
      if (!dryRun) {
        const { error } = await supabase
          .from("time_blocks")
          .update({ notes: null, updated_at: new Date().toISOString() })
          .eq("id", b.id);
        if (error) throw error;
      }
      clearedNotes++;
    }
  }

  console.log("");
  console.log(dryRun ? "Modo --dry-run: no se escribió nada en la base." : "Listo.");
  console.log(`  Correcciones de task_id: ${fixedTaskIds}`);
  console.log(`  Campo notes limpiado (duplicado del título): ${clearedNotes}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
