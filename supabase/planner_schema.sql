-- Planner schema for task/habit scheduling
-- Run this script in Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.task_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.habit_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  notes text,
  done boolean not null default false,
  points integer not null default 0 check (points >= 0 and points <= 10),
  scheduled_date date not null,
  task_type_id uuid references public.task_types(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tasks_scheduled_date
  on public.tasks (scheduled_date);

create table if not exists public.time_blocks (
  id uuid primary key default gen_random_uuid(),
  scheduled_date date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  entry_type text not null check (entry_type in ('task', 'habit')),
  task_id uuid references public.tasks(id) on delete cascade,
  habit_type_id uuid references public.habit_types(id) on delete cascade,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_time_blocks_interval check (end_at > start_at),
  constraint chk_time_blocks_target check (
    (entry_type = 'task' and task_id is not null and habit_type_id is null) or
    (entry_type = 'habit' and habit_type_id is not null and task_id is null)
  )
);

create index if not exists idx_time_blocks_scheduled_date
  on public.time_blocks (scheduled_date, start_at, end_at);
