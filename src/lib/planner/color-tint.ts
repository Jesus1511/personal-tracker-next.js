const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Opacidad aplicada a fondos de tipo/hábito en calendario y listas (0–1). */
export const PLANNER_TINT_ALPHA = 0.8;

/**
 * Devuelve un color CSS apto para `backgroundColor` con el tono dado y transparencia.
 * **Why:** los hex se guardan opacos en Supabase pero en UI se muestran más suaves;
 * **Risk:** valores no hex dependen de `color-mix` (navegadores recientes);
 * **Alternative:** guardar rgba en base de datos.
 */
export function plannerTintBackground(color: string, alpha: number = PLANNER_TINT_ALPHA): string {
  const trimmed = color.trim();
  const m = trimmed.match(HEX_RE);
  if (m) {
    let h = m[1];
    if (h.length === 3) {
      h = h.split("").map((c) => c + c).join("");
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const pct = Math.round(alpha * 100);
  return `color-mix(in srgb, ${trimmed} ${pct}%, transparent)`;
}
