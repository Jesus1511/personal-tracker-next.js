-- Bloc de texto libre (singleton). Ejecutar en Supabase SQL editor.

create table if not exists public.scratchpad (
  id text primary key default 'singleton' check (id = 'singleton'),
  content text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.scratchpad (id, content)
values ('singleton', '')
on conflict (id) do nothing;
