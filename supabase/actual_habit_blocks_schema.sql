-- Actual habit blocks: tracks habits the user actually completed.
-- Separate from the planned time_blocks; can reference a planned block or stand alone.
-- Run this script in Supabase SQL editor AFTER planner_schema.sql.

create table if not exists public.actual_habit_blocks (
  id uuid primary key default gen_random_uuid(),
  scheduled_date date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  habit_type_id uuid not null references public.habit_types(id) on delete cascade,
  description text not null default '',
  planned_block_id uuid references public.time_blocks(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_actual_habit_interval check (end_at > start_at)
);

create index if not exists idx_actual_habit_blocks_date
  on public.actual_habit_blocks (scheduled_date, start_at, end_at);
