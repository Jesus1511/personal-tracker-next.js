-- Fix routine template intervals: allow overnight blocks (e.g. 23:00–01:00).
-- Run once in Supabase SQL editor if you already applied daily_routines_schema.sql
-- with the old end_time > start_time constraint.

alter table public.daily_routine_time_blocks
  drop constraint if exists chk_daily_routine_time_blocks_interval;

alter table public.daily_routine_time_blocks
  add constraint chk_daily_routine_time_blocks_interval
  check (start_time <> end_time);
