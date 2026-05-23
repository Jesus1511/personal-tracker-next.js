-- Enable Supabase Realtime on daily_goals so the Mac watcher can react instantly
-- Run once in the Supabase SQL editor.
ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_goals;
