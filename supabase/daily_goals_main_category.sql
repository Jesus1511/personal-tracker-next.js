-- Add category support to task_types and link daily_goals to a task_type
-- Run this in Supabase SQL editor AFTER daily_goals_schema.sql

-- Task types can be flagged so their tasks auto-complete the daily main goal
ALTER TABLE public.task_types
  ADD COLUMN IF NOT EXISTS contributes_to_main boolean NOT NULL DEFAULT false;

-- Daily goals can have a display category
ALTER TABLE public.daily_goals
  ADD COLUMN IF NOT EXISTS task_type_id uuid REFERENCES public.task_types(id) ON DELETE SET NULL;
