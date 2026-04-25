import Anthropic from "@anthropic-ai/sdk";

import { type WeeklySummaryData } from "./gather-data";

function buildPrompt(data: WeeklySummaryData): string {
  const { weekStart, weekEnd, tasks, habits, timeBlocks, locations } = data;

  const taskDayStr = tasks.byDay
    .map((d) => `  ${d.date}: ${d.done}/${d.total} tareas`)
    .join("\n");

  const habitStr = habits.byHabit
    .map((h) => `  ${h.name}: ${h.completed}/${h.planned} completados`)
    .join("\n");

  const nonHomePlaces = locations.visits.filter((v) => !v.isHome);
  const placesStr = nonHomePlaces.length
    ? nonHomePlaces.map((v) => `  Lugar (${v.lat.toFixed(4)}, ${v.lng.toFixed(4)}): ${v.sessions} visita(s)`).join("\n")
    : "  Sin visitas a lugares fuera de casa registradas.";

  return `Eres el asistente personal del usuario. Tienes los datos de su semana (${weekStart} → ${weekEnd}) en su app de seguimiento personal. Escribe un correo de resumen semanal en español, en tono directo y motivador (como un coach personal). Sin saludos largos.

DATOS DE LA SEMANA:

TAREAS:
- Total: ${tasks.total} | Completadas: ${tasks.done} | Pendientes: ${tasks.notDone}
- Puntaje promedio de tareas hechas: ${tasks.avgPoints}/10
- Por día:
${taskDayStr}

HÁBITOS PLANIFICADOS:
- Bloques planificados: ${habits.totalPlanned} | Completados: ${habits.totalCompleted} | Tasa: ${habits.completionRate}%
- Por hábito:
${habitStr}

TIEMPO PLANIFICADO:
- Total de bloques: ${timeBlocks.totalPlanned}
- Minutos de tareas: ${timeBlocks.byType.find((b) => b.type === "task")?.minutes ?? 0} min
- Minutos de hábitos: ${timeBlocks.byType.find((b) => b.type === "habit")?.minutes ?? 0} min

UBICACIONES (días fuera de casa):
${placesStr}

INSTRUCCIONES:
1. Resumen ejecutivo de la semana (2-3 oraciones).
2. Lo que fue bien (máx. 3 puntos concretos con datos).
3. Lo que mejorar la próxima semana (máx. 3 puntos concretos).
4. Frase de cierre motivadora.

Formatea la respuesta en HTML limpio listo para incrustar en un email (solo el body interior, sin <html>/<head>/<body>). Usa <h2>, <p>, <ul>, <li>. Colores sobrios: #18181b texto, #8b5cf6 acento para encabezados.`;
}

export async function generateWeeklySummaryHtml(data: WeeklySummaryData): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1500,
    messages: [{ role: "user", content: buildPrompt(data) }],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";

  return wrapInEmailShell(text, data);
}

function wrapInEmailShell(body: string, data: WeeklySummaryData): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Resumen semanal ${data.weekStart} – ${data.weekEnd}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; margin: 0; padding: 24px; color: #18181b; }
  .card { background: #fff; border-radius: 12px; max-width: 640px; margin: 0 auto; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  h2 { color: #8b5cf6; margin-top: 24px; font-size: 18px; }
  p  { line-height: 1.6; margin: 8px 0; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; line-height: 1.6; }
  .footer { text-align: center; font-size: 12px; color: #a1a1aa; margin-top: 24px; }
</style>
</head>
<body>
<div class="card">
  <p style="font-size:13px;color:#a1a1aa;margin-bottom:16px;">Semana ${data.weekStart} – ${data.weekEnd}</p>
  ${body}
  <div class="footer">Personal Tracker · generado automáticamente</div>
</div>
</body>
</html>`;
}
