-- Un-off: marcar un punto como casa. Ejecutar en Supabase SQL (ajusta lat/lng si hace falta).
-- Tras esto, los pulsos cerca (≤60 m) hacen match con este lugar (sin depender del 2.º pulso).

insert into public.location_places (lat, lng, is_home, first_seen_at, last_seen_at)
values (
  10.1829357,
  -64.6668402,
  true,
  now(),
  now()
);
