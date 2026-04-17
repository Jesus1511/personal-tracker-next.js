-- Si ya ejecutaste una versión antigua de points_and_rollover.sql con índice único PARCIAL
-- (WHERE rize_entry_id IS NOT NULL), los upsert de Supabase fallan con:
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- Ejecuta esto en el SQL Editor de Supabase (una vez). Varios NULL en rize_entry_id siguen siendo válidos.

drop index if exists idx_actual_task_blocks_rize_entry_id_unique;

create unique index idx_actual_task_blocks_rize_entry_id_unique
  on public.actual_task_blocks (rize_entry_id);
