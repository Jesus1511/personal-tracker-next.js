-- Actual task blocks: tracks Rize focus blocks matched to planned task time blocks.
-- Separate from planned time_blocks; can reference a planned block or stand alone.
-- Run this script in Supabase SQL editor AFTER planner_schema.sql.

create table if not exists public.actual_task_blocks (
  id uuid primary key default gen_random_uuid(),
  scheduled_date date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  task_id uuid references public.tasks(id) on delete set null,
  planned_block_id uuid references public.time_blocks(id) on delete set null,
  rize_entry_id text not null unique,
  rize_title text not null default '',
  user_completion_link boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_actual_task_interval check (end_at > start_at)
);

create index if not exists idx_actual_task_blocks_date
  on public.actual_task_blocks (scheduled_date, start_at, end_at);
