-- Daily goals: one completable main title per day
-- Run this in Supabase SQL editor.

create table if not exists public.daily_goals (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  title text not null default '',
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_daily_goals_date
  on public.daily_goals (date);
