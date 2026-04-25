-- Varios is_home = true (ej. mudanza, segunda residencia), y RPC para
-- fusionar pulsos a casa en lugar de crear fila.
-- Ejecutar en Supabase SQL editor si ya apliquiste location_places_schema.sql
-- (versión con unique en is_home).

drop index if exists location_places_one_home;

-- -------------------------------------------------------
-- RPC: el lugar casa más cercano en p_radius_m m (misma semántica que
-- location_nearest_place, pero filtra is_home = true)
-- -------------------------------------------------------
create or replace function location_nearest_home(
  p_lat      double precision,
  p_lng      double precision,
  p_radius_m double precision default 60
)
returns setof location_places
language sql
stable
as $$
  select *
  from location_places
  where is_home = true
  and st_dwithin(
    geography(st_makepoint(lng, lat)),
    geography(st_makepoint(p_lng, p_lat)),
    p_radius_m
  )
  order by st_distance(
    geography(st_makepoint(lng, lat)),
    geography(st_makepoint(p_lng, p_lat))
  ) asc
  limit 1;
$$;
