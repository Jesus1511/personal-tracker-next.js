-- Add optional name column to location_places
alter table location_places
  add column if not exists name text;
