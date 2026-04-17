/** Prefijo para filas optimistas antes de que Supabase devuelva el uuid real. */
export const TEMP_ID_PREFIX = "temp:";

export function makeTempId(): string {
  return `${TEMP_ID_PREFIX}${crypto.randomUUID()}`;
}

export function isTempId(id: string): boolean {
  return id.startsWith(TEMP_ID_PREFIX);
}
