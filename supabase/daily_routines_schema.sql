-- Daily routines: reusable planned-day templates (tasks + time blocks).
-- Run in Supabase SQL editor AFTER planner_schema.sql, daily_goals_schema.sql,
-- daily_goals_main_category.sql, add_tasks_sort_order.sql.

create table if not exists public.daily_routines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_routine_tasks (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.daily_routines(id) on delete cascade,
  title text not null,
  notes text,
  points integer not null default 0 check (points >= 0 and points <= 10),
  task_type_id uuid references public.task_types(id) on delete set null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_daily_routine_tasks_routine
  on public.daily_routine_tasks (routine_id, sort_order);

create table if not exists public.daily_routine_time_blocks (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.daily_routines(id) on delete cascade,
  entry_type text not null check (entry_type in ('task', 'habit')),
  start_time time not null,
  end_time time not null,
  routine_task_id uuid references public.daily_routine_tasks(id) on delete cascade,
  habit_type_id uuid references public.habit_types(id) on delete cascade,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_daily_routine_time_blocks_interval check (start_time <> end_time),
  constraint chk_daily_routine_time_blocks_target check (
    (entry_type = 'task' and routine_task_id is not null and habit_type_id is null) or
    (entry_type = 'habit' and habit_type_id is not null and routine_task_id is null)
  )
);

create index if not exists idx_daily_routine_time_blocks_routine
  on public.daily_routine_time_blocks (routine_id, sort_order);

-- One row per calendar day: last applied routine (nullable if routine deleted).
create table if not exists public.daily_routine_applications (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  routine_id uuid references public.daily_routines(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_daily_routine_applications_date
  on public.daily_routine_applications (date);

create index if not exists idx_daily_routine_applications_routine
  on public.daily_routine_applications (routine_id);
