-- ============================================================
-- Location places + pulses
-- Run in Supabase SQL editor.
-- Requires PostGIS (enabled by default in Supabase).
-- ============================================================

-- PostGIS is pre-installed in Supabase; this is a no-op if already enabled.
create extension if not exists postgis;

-- -------------------------------------------------------
-- location_places: known recurring places (~60 m radius)
-- -------------------------------------------------------
create table if not exists location_places (
  id            uuid        primary key default gen_random_uuid(),
  lat           double precision not null,
  lng           double precision not null,
  is_home       boolean     not null default false,
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- Spatial index for ST_DWithin / ST_Distance queries.
create index if not exists location_places_geog_gist
  on location_places
  using gist (geography(st_makepoint(lng, lat)));

-- Varios is_home = true si hace falta (mudanza, etc.).

-- -------------------------------------------------------
-- location_pulses: raw ping from the mobile background task
-- -------------------------------------------------------
create table if not exists location_pulses (
  id          uuid        primary key default gen_random_uuid(),
  lat         double precision not null,
  lng         double precision not null,
  accuracy    double precision,
  recorded_at timestamptz not null,
  source      text,
  platform    text,
  -- Null when the pulse could not yet be associated to a place.
  place_id    uuid        references location_places(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists location_pulses_created_at_idx
  on location_pulses (created_at desc);

create index if not exists location_pulses_place_id_idx
  on location_pulses (place_id);

-- -------------------------------------------------------
-- RPC: location_nearest_place(p_lat, p_lng, p_radius_m)
-- Returns the closest location_place within p_radius_m meters,
-- or an empty set if none exists.
-- -------------------------------------------------------
create or replace function location_nearest_place(
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
  where st_dwithin(
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

grant execute on function public.location_nearest_place(
  double precision,
  double precision,
  double precision
) to anon, authenticated, service_role;

-- -------------------------------------------------------
-- RPC: casa (is_home) más cercana en p_radius_m; vacío si no hay o no hay
-- ninguna fila is_home. Usado al crear un lugar para fusionar a casa.
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

grant execute on function public.location_nearest_home(
  double precision,
  double precision,
  double precision
) to anon, authenticated, service_role;
