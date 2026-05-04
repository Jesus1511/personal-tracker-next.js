-- Resumen libre del día (meta journaling). Ejecutar en Supabase SQL editor.

create table if not exists public.daily_summaries (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  text text not null default '' check (char_length(text) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_daily_summaries_date on public.daily_summaries (date);
