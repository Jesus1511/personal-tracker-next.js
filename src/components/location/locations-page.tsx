"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle, GoogleMap, Marker, useJsApiLoader } from "@react-google-maps/api";

const GOOGLE_MAPS_API_KEY = "AIzaSyCybx1vf4LNjfyolPFpvtY_x2CzfnqARBw";
const ZONE_RADIUS_M = 60;

type LocationPlaceRow = {
  id: string;
  name: string | null;
  lat: number;
  lng: number;
  is_home: boolean;
  first_seen_at: string;
  last_seen_at: string | null;
  created_at: string;
};

type HabitTypeRow = {
  id: string;
  name: string;
  color: string | null;
};

type PlaceHabitRow = {
  id: string;
  place_id: string;
  habit_type_id: string;
  habit_type?: { id: string; name: string; color: string | null } | null;
};

function centerForPlaces(places: LocationPlaceRow[]) {
  if (places.length === 0) return { lat: 10.5, lng: -66.916 };
  const lat = places.reduce((s, p) => s + p.lat, 0) / places.length;
  const lng = places.reduce((s, p) => s + p.lng, 0) / places.length;
  return { lat, lng };
}

function PlaceModal({
  place,
  allHabits,
  onClose,
  onSaved,
  onDeleted,
}: {
  place: LocationPlaceRow;
  allHabits: HabitTypeRow[];
  onClose: () => void;
  onSaved: (updated: LocationPlaceRow) => void;
  onDeleted: (id: string) => void;
}) {
  const [home, setHome] = useState(place.is_home);
  const [name, setName] = useState(place.name ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [linked, setLinked] = useState<PlaceHabitRow[]>([]);
  const [loadingH, setLoadingH] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    setHome(place.is_home);
    setName(place.name ?? "");
    setErr(null);
    setLoadingH(true);
    fetch(`/api/location/location-place-habits?placeId=${place.id}`)
      .then((r) => r.json())
      .then((d: { habits: PlaceHabitRow[] }) => setLinked(d.habits ?? []))
      .catch(() => {})
      .finally(() => setLoadingH(false));
  }, [place.id, place.is_home]);

  async function save() {
    setErr(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/planner/location-places/${place.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isHome: home, name: name.trim() || null }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { place: LocationPlaceRow };
      onSaved(data.place);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    if (!confirm("¿Eliminar este lugar?")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/planner/location-places/${place.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      onDeleted(place.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al eliminar");
      setDeleting(false);
    }
  }

  async function toggleHabit(habit: HabitTypeRow) {
    const existing = linked.find((l) => l.habit_type_id === habit.id);
    setToggling(habit.id);
    try {
      if (existing) {
        const res = await fetch(`/api/location/location-place-habits/${existing.id}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(await res.text());
        setLinked((prev) => prev.filter((l) => l.id !== existing.id));
      } else {
        const res = await fetch("/api/location/location-place-habits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ placeId: place.id, habitTypeId: habit.id }),
        });
        if (!res.ok && res.status !== 409) throw new Error(await res.text());
        const data = (await res.json()) as { habit: PlaceHabitRow };
        setLinked((prev) => [...prev, data.habit]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al vincular hábito");
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="relative z-10 w-full max-w-md max-h-[80vh] rounded-t-2xl sm:rounded-2xl bg-white dark:bg-zinc-900 shadow-2xl flex flex-col overflow-hidden">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="w-9 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>

        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex-1 min-w-0">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={place.is_home ? "Casa" : "Lugar sin nombre"}
              className="w-full text-lg font-bold text-zinc-900 dark:text-zinc-100 bg-transparent border-none outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
            />
            <p className="text-xs text-zinc-500 font-mono mt-0.5">
              {place.lat.toFixed(5)}, {place.lng.toFixed(5)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 text-xl leading-none mt-0.5 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {err && (
            <p className="text-sm text-rose-600 bg-rose-50 dark:bg-rose-950/30 rounded-lg px-3 py-2">
              {err}
            </p>
          )}

          {/* is_home toggle */}
          <div className="flex items-center justify-between rounded-xl border border-zinc-200 dark:border-zinc-700 px-4 py-3">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Es casa</span>
            <button
              onClick={() => setHome((h) => !h)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                home ? "bg-violet-500" : "bg-zinc-300 dark:bg-zinc-600"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  home ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Habits */}
          {allHabits.length > 0 && (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 px-4 py-3 flex flex-col gap-3">
              <p className="text-xs font-bold tracking-wider text-zinc-400 uppercase">
                Hábitos vinculados
              </p>
              {loadingH ? (
                <div className="flex justify-center py-2">
                  <span className="animate-spin text-violet-500 text-lg">⟳</span>
                </div>
              ) : (
                allHabits.map((h) => {
                  const isLinked = linked.some((l) => l.habit_type_id === h.id);
                  const busy = toggling === h.id;
                  return (
                    <div key={h.id} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {h.color && (
                          <span
                            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: h.color }}
                          />
                        )}
                        <span className="text-sm text-zinc-800 dark:text-zinc-200">{h.name}</span>
                      </div>
                      <button
                        onClick={() => void toggleHabit(h)}
                        disabled={busy}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                          isLinked ? "bg-violet-500" : "bg-zinc-300 dark:bg-zinc-600"
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                            isLinked ? "translate-x-[18px]" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-5 py-4 border-t border-zinc-100 dark:border-zinc-800 flex flex-col gap-2">
          <button
            onClick={() => void save()}
            disabled={saving}
            className="w-full py-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-60 text-white font-semibold text-sm transition-colors"
          >
            {saving ? "Guardando…" : "Guardar"}
          </button>
          <button
            onClick={() => void doDelete()}
            disabled={deleting}
            className="w-full py-2.5 rounded-xl border border-rose-500 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-60 font-semibold text-sm transition-colors"
          >
            {deleting ? "Eliminando…" : "Eliminar lugar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function LocationsPage() {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: GOOGLE_MAPS_API_KEY,
  });

  const [places, setPlaces] = useState<LocationPlaceRow[]>([]);
  const [allHabits, setAllHabits] = useState<HabitTypeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<LocationPlaceRow | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);

  const [geoViewport, setGeoViewport] = useState<{ lat: number; lng: number; zoom: number } | null>(
    null,
  );

  function centerMapOnCurrentPosition(map: google.maps.Map) {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const zoom = 16;
        map.panTo({ lat, lng });
        map.setZoom(zoom);
        setGeoViewport({ lat, lng, zoom });
      },
      () => {},
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60_000 },
    );
  }

  const load = useCallback(async () => {
    setError(null);
    try {
      const [pr, hr] = await Promise.all([
        fetch("/api/planner/location-places"),
        fetch("/api/planner/habit-types"),
      ]);
      const pd = (await pr.json()) as { places: LocationPlaceRow[] };
      const hd = (await hr.json()) as { habitTypes: HabitTypeRow[] };
      setPlaces(pd.places ?? []);
      setAllHabits(hd.habitTypes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fallbackCenter = useMemo(() => centerForPlaces(places), [places]);

  const mapCenter = useMemo(() => {
    if (geoViewport) return { lat: geoViewport.lat, lng: geoViewport.lng };
    return fallbackCenter;
  }, [geoViewport, fallbackCenter]);

  const mapZoom = geoViewport?.zoom ?? 14;

  const mapOptions = useMemo(
    () => ({
      disableDefaultUI: false,
      clickableIcons: false,
      styles: [
        { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
      ],
    }),
    [],
  );

  if (!isLoaded || loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-zinc-400 text-sm">Cargando mapa…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-rose-500 text-sm">{error}</span>
      </div>
    );
  }

  return (
    <div className="relative flex-1 flex flex-col">
      <GoogleMap
        mapContainerStyle={{ width: "100%", flex: 1, minHeight: 0 }}
        mapContainerClassName="flex-1"
        center={mapCenter}
        zoom={mapZoom}
        onLoad={(map) => {
          mapRef.current = map;
          centerMapOnCurrentPosition(map);
        }}
        options={mapOptions}
      >
        {places.map((p) => (
          <Circle
            key={`c-${p.id}`}
            center={{ lat: p.lat, lng: p.lng }}
            radius={ZONE_RADIUS_M}
            options={{
              strokeColor: p.is_home ? "#14b8a6" : "#8b5cf6",
              fillColor: p.is_home ? "rgba(20,184,166,0.15)" : "rgba(139,92,246,0.12)",
              strokeWeight: 2,
              clickable: false,
            }}
          />
        ))}
        {places.map((p) => (
          <Marker
            key={p.id}
            position={{ lat: p.lat, lng: p.lng }}
            title={p.name ?? (p.is_home ? "Casa" : "Lugar")}
            icon={{
              path: google.maps.SymbolPath.CIRCLE,
              scale: 10,
              fillColor: p.is_home ? "#14b8a6" : "#8b5cf6",
              fillOpacity: 1,
              strokeColor: "#fff",
              strokeWeight: 2,
            }}
            onClick={() => setSelectedPlace(p)}
          />
        ))}
      </GoogleMap>

      {selectedPlace && (
        <PlaceModal
          place={selectedPlace}
          allHabits={allHabits}
          onClose={() => setSelectedPlace(null)}
          onSaved={(updated) => {
            setPlaces((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
            setSelectedPlace(null);
          }}
          onDeleted={(id) => {
            setPlaces((prev) => prev.filter((p) => p.id !== id));
            setSelectedPlace(null);
          }}
        />
      )}
    </div>
  );
}
