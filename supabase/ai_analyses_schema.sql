create table if not exists ai_analyses (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  date_start      date not null,
  date_end        date not null,
  tables_analyzed text[] not null,
  prompt_type     text not null check (prompt_type in ('summary','recommendations','custom')),
  prompt_text     text not null,
  response_text   text,
  status          text not null default 'completed' check (status in ('completed','failed')),
  failure_reason  text,
  review_status   text not null default 'pending' check (review_status in ('pending','successful','failed')),
  review_notes    text
);

create index if not exists idx_ai_analyses_created_at on ai_analyses (created_at desc);
