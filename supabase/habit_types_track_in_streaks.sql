-- Hábitos visibles en rachas (métricas). Ejecutar en Supabase SQL editor.

ALTER TABLE public.habit_types
  ADD COLUMN IF NOT EXISTS track_in_streaks boolean NOT NULL DEFAULT true;
