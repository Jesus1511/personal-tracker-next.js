-- Puntos parciales por bloque + rollover a día siguiente.
-- Ejecutar en Supabase SQL editor DESPUÉS de planner_schema.sql,
-- actual_task_blocks_schema.sql y add_tasks_sort_order.sql.

-- 1) actual_task_blocks: puntos completados por bloque y origen (rize vs manual)
alter table public.actual_task_blocks
  add column if not exists points_completed integer not null default 0
    check (points_completed >= 0 and points_completed <= 10);

alter table public.actual_task_blocks
  add column if not exists source text not null default 'rize'
    check (source in ('rize', 'manual'));

-- 2) Permitir filas "manuales" sin Rize: rize_entry_id nullable y unique parcial
alter table public.actual_task_blocks
  alter column rize_entry_id drop not null;

-- El unique original se creó implícitamente por `text not null unique`.
-- Lo reemplazamos por un índice único parcial (solo aplica a filas con Rize).
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'actual_task_blocks_rize_entry_id_key'
  ) then
    alter table public.actual_task_blocks drop constraint actual_task_blocks_rize_entry_id_key;
  end if;
end$$;

-- Índice único SIN predicado: PostgREST/Supabase usa ON CONFLICT (rize_entry_id) en upsert;
-- un índice parcial (WHERE rize_entry_id IS NOT NULL) NO coincide con esa especificación.
-- En PostgreSQL, varias filas con rize_entry_id NULL siguen siendo válidas (NULL ≠ NULL en UNIQUE).
drop index if exists idx_actual_task_blocks_rize_entry_id_unique;
create unique index idx_actual_task_blocks_rize_entry_id_unique
  on public.actual_task_blocks (rize_entry_id);

create index if not exists idx_actual_task_blocks_task_date
  on public.actual_task_blocks (task_id, scheduled_date);

-- 3) tasks: cadena de rollover (tarea hija apunta a la original)
alter table public.tasks
  add column if not exists parent_task_id uuid references public.tasks(id) on delete set null;

create index if not exists idx_tasks_parent_task_id
  on public.tasks (parent_task_id);

create index if not exists idx_tasks_scheduled_date_done
  on public.tasks (scheduled_date, done);
