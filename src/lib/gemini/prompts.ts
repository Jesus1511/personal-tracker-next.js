import type { DateRange } from "./types";

type TableData = Record<string, unknown[]>;

function formatDataBlock(tableName: string, rows: unknown[]): string {
  if (rows.length === 0) return `### ${tableName}\nSin datos en este rango.\n`;
  return `### ${tableName} (${rows.length} registros)\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n`;
}

function buildDataContext(data: TableData, range: DateRange): string {
  const sections = Object.entries(data).map(([t, rows]) =>
    formatDataBlock(t, rows),
  );
  return [`## Datos del ${range.start} al ${range.end}\n`, ...sections].join("\n");
}

const SYSTEM_PREFIX =
  "Eres un asistente de productividad personal. Analiza los datos que te proporciono y responde siempre en español. " +
  "Usa Markdown para formatear tu respuesta. Sé conciso pero completo.\n\n";

const DEFAULT_CUSTOM_WHEN_EMPTY =
  "Analiza estos datos y ofrece un resumen breve en español con los hallazgos más relevantes y, si aplica, 2–3 recomendaciones concretas.";

export function buildCustomPrompt(
  data: TableData,
  range: DateRange,
  userPrompt: string,
): string {
  const instructions = userPrompt.trim() || DEFAULT_CUSTOM_WHEN_EMPTY;
  return (
    SYSTEM_PREFIX +
    buildDataContext(data, range) +
    "\n## Instrucciones del usuario\n" +
    instructions +
    "\n"
  );
}
