-- Hábitos vinculados a lugares físicos.
-- Cuando el usuario abandona un place con hábitos asociados,
-- el sistema crea automáticamente un actual_habit_block con la duración real de la visita.
-- Requiere: location_places, habit_types, actual_habit_blocks.

create table if not exists public.location_place_habits (
  id             uuid        primary key default gen_random_uuid(),
  place_id       uuid        not null references public.location_places(id) on delete cascade,
  habit_type_id  uuid        not null references public.habit_types(id) on delete cascade,
  created_at     timestamptz not null default now(),
  constraint uq_location_place_habits unique (place_id, habit_type_id)
);

create index if not exists idx_location_place_habits_place
  on public.location_place_habits (place_id);
