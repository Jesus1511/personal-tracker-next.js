export type TaskType = {
  id: string;
  name: string;
  color: string | null;
  contributes_to_main: boolean;
};

export type HabitType = {
  id: string;
  name: string;
  color: string | null;
};

export type TaskItem = {
  id: string;
  title: string;
  notes: string | null;
  done: boolean;
  points: number;
  /** Suma de points_completed en actual_task_blocks para esta tarea. Calculado en el GET. */
  points_done?: number;
  sort_order: number;
  scheduled_date: string;
  task_type_id: string | null;
  task_type?: TaskType | null;
  /** Si esta tarea nació por rollover, apunta a la tarea original. */
  parent_task_id?: string | null;
  /** Id de la tarea hija creada al “pasar al día siguiente” (mientras exista, no re-enviar). */
  carry_next_child_id?: string | null;
};

export type TimeBlock = {
  id: string;
  scheduled_date: string;
  start_at: string;
  end_at: string;
  entry_type: "task" | "habit";
  notes: string | null;
  task_id: string | null;
  habit_type_id: string | null;
  task?: TaskItem | null;
  habit_type?: HabitType | null;
};

export type ActualHabitBlock = {
  id: string;
  scheduled_date: string;
  start_at: string;
  end_at: string;
  habit_type_id: string;
  description: string;
  planned_block_id: string | null;
  habit_type?: HabitType | null;
};

export type ActualTaskBlock = {
  id: string;
  scheduled_date: string;
  start_at: string;
  end_at: string;
  task_id: string | null;
  planned_block_id: string | null;
  /** Ahora nullable: las filas "manuales" (sin Rize) guardan null. */
  rize_entry_id: string | null;
  rize_title: string;
  user_completion_link?: boolean;
  /** Puntos que aportó este bloque a la tarea. */
  points_completed?: number;
  /** 'rize' cuando vino de un foco Rize, 'manual' cuando el usuario registró avance sin vincular. */
  source?: "rize" | "manual";
  task?: TaskItem | null;
};

export type RizeTimeEntryOption = {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
};
