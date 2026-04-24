-- Push tokens for Expo push notifications
-- Run in Supabase SQL editor

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  device_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_push_tokens_token on public.push_tokens (token);
