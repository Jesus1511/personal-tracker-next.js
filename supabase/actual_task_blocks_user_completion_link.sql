-- Marks actual_task_blocks created when the user completes a task and picks a focus block.
-- Sync preserves task_id / planned_block_id for these rows and does not delete them if missing from Rize.
alter table public.actual_task_blocks
  add column if not exists user_completion_link boolean not null default false;
