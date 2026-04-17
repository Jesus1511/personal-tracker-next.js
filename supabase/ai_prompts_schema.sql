-- Prompts reutilizables para el an\u00e1lisis con IA.
-- Ejecutar en Supabase SQL editor.

create table if not exists public.ai_prompts (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  label         text not null,
  prompt_text   text not null
);

create index if not exists idx_ai_prompts_created_at
  on public.ai_prompts (created_at desc);
