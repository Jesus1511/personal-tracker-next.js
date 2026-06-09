-- Conversaciones del Planificador IA (widget en /planner).
-- Ejecutar en Supabase SQL editor.

create table if not exists public.planner_chats (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  title        text not null default 'Nueva conversación',
  mode         text not null default 'plan' check (mode in ('plan', 'agent')),
  model        text not null default 'claude-sonnet-4-6',
  messages     jsonb not null default '[]'::jsonb,
  plan_actions jsonb not null default '[]'::jsonb
);

create index if not exists idx_planner_chats_updated_at
  on public.planner_chats (updated_at desc);
