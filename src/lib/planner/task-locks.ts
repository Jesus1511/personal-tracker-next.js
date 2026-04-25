import { addCalendarDays, localDateString } from "@/lib/planner/date";

/** La lista mostrada es de un calendario estrictamente anterior a hoy (solo lectura salvo vinc. foco). */
export function isPastListDay(listDate: string): boolean {
  return listDate < localDateString();
}

/** Origen con copia hija: no editar ni borrar el origen hasta que se elimine el clon. */
export function isLockedByCarryChild(task: { carry_next_child_id?: string | null }): boolean {
  return Boolean(task.carry_next_child_id);
}

/** Día en Supabase donde buscar `actual_task_blocks` para el modal de foco. */
export function focusBlocksFetchDate(
  _task: { parent_task_id?: string | null; scheduled_date: string },
  listDate: string,
): string {
  return listDate;
}
