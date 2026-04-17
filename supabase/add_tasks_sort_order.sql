-- Add sort_order to tasks for manual reordering.
-- Run after planner_schema.sql.

alter table public.tasks
  add column if not exists sort_order integer not null default 0;

-- Backfill existing rows: assign sort_order by created_at within each day.
with numbered as (
  select id, row_number() over (partition by scheduled_date order by created_at) as rn
  from public.tasks
)
update public.tasks t
set sort_order = n.rn
from numbered n
where t.id = n.id and t.sort_order = 0;
