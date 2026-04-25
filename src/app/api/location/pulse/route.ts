import { NextRequest, NextResponse } from "next/server";

import { ASSUMED_SINGLE_PULSE_VISIT_MS } from "@/lib/location/assumed-visit-duration";
import { apiError } from "@/lib/planner/http";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { handleSendCustomNotification } from "@/lib/push/handle-send-custom-notification";

export const dynamic = "force-dynamic";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LocationPulseBody = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  recordedAt: string;
  source?: string;
  platform?: string;
};

type LocationPlace = {
  id: string;
  lat: number;
  lng: number;
  is_home: boolean;
  first_seen_at: string;
  last_seen_at: string | null;
};

type LocationPulse = {
  id: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  recorded_at: string;
  source: string | null;
  platform: string | null;
  place_id: string | null;
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

function verifySecret(request: NextRequest): boolean {
  const secret = process.env.LOCATION_PULSE_SECRET?.trim();
  if (!secret) return true;
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

// ─── Core deduplication logic ─────────────────────────────────────────────────

/** Log legible; datos extra en el segundo argumento. */
function logPulse(narrative: string, data?: Record<string, unknown>) {
  if (data && Object.keys(data).length) {
    console.log(`[location/pulse] ${narrative}`, data);
  } else {
    console.log(`[location/pulse] ${narrative}`);
  }
}

/** Casa: no insertar en location_pulses (ruido; ausencia de pulses ⇒ en casa en capas de producto). */
async function touchHomeOnly(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  place: LocationPlace,
  body: LocationPulseBody,
): Promise<LocationPlace> {
  const { data: updatedPlace, error: updateErr } = await supabase
    .from("location_places")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", place.id)
    .select()
    .single<LocationPlace>();
  if (updateErr) throw new Error(`update place: ${updateErr.message}`);

  logPulse(
    "Casa (is_home): solo last_seen en location_places; sin fila en location_pulses.",
    {
      placeId: place.id,
      placeCenter: { lat: place.lat, lng: place.lng },
      requestCoords: { lat: body.lat, lng: body.lng },
      source: body.source ?? null,
      platform: body.platform ?? null,
    },
  );
  return updatedPlace;
}

async function attachPulseToPlace(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  place: LocationPlace,
  body: LocationPulseBody,
): Promise<{ pulse: LocationPulse; place: LocationPlace }> {
  const { lat, lng, accuracy, recordedAt, source, platform } = body;
  const { data: updatedPlace, error: updateErr } = await supabase
    .from("location_places")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", place.id)
    .select()
    .single<LocationPlace>();
  if (updateErr) throw new Error(`update place: ${updateErr.message}`);

  const { data: pulse, error: pulseErr } = await supabase
    .from("location_pulses")
    .insert({
      lat,
      lng,
      accuracy: accuracy ?? null,
      recorded_at: recordedAt,
      source: source ?? null,
      platform: platform ?? null,
      place_id: place.id,
    })
    .select()
    .single<LocationPulse>();
  if (pulseErr) throw new Error(`insert pulse: ${pulseErr.message}`);

  logPulse(
    "Pulso guardado y unido a un lugar existente: se actualizó last_seen y se asoció place_id al pulso.",
    {
      placeId: place.id,
      placeIsHome: place.is_home,
      placeCenter: { lat: place.lat, lng: place.lng },
      pulseCoords: { lat, lng },
      accuracy: accuracy ?? null,
      source: source ?? null,
      platform: platform ?? null,
    },
  );

  return { pulse, place: updatedPlace };
}

/** Tras pulso con place previo y sin `nearest` a 60 m: fusionar a is_home o crear lugar. */
async function matchHomeOrCreatePlace(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  body: LocationPulseBody,
): Promise<{
  pulse: LocationPulse | null;
  place: LocationPlace;
  action: "home_silent" | "created";
}> {
  const { lat, lng, accuracy, recordedAt, source, platform } = body;
  const { data: homeRows, error: homeErr } = await supabase.rpc("location_nearest_home", {
    p_lat: lat,
    p_lng: lng,
    p_radius_m: 60,
  });
  if (homeErr) throw new Error(`nearest home rpc: ${homeErr.message}`);
  const homePlace: LocationPlace | null =
    Array.isArray(homeRows) && homeRows.length > 0
      ? (homeRows[0] as LocationPlace)
      : null;
  if (homePlace) {
    logPulse(
      "is_home a ≤60 m: anclar a esa casa; sin insertar pulse (misma política que nearest is_home).",
      { homePlaceId: homePlace.id, homeCenter: { lat: homePlace.lat, lng: homePlace.lng } },
    );
    const updatedPlace = await touchHomeOnly(supabase, homePlace, body);
    return { pulse: null, place: updatedPlace, action: "home_silent" };
  }

  logPulse(
    "Ninguna is_home a ≤60 m: se crea un location_places NUEVO (is_home=false) y el pulso apunta a él.",
    { coords: { lat, lng } },
  );
  const now = new Date().toISOString();
  const { data: newPlace, error: placeErr } = await supabase
    .from("location_places")
    .insert({ lat, lng, is_home: false, first_seen_at: now })
    .select()
    .single<LocationPlace>();
  if (placeErr) throw new Error(`create place: ${placeErr.message}`);

  const { data: pulse, error: pulseErr } = await supabase
    .from("location_pulses")
    .insert({
      lat,
      lng,
      accuracy: accuracy ?? null,
      recorded_at: recordedAt,
      source: source ?? null,
      platform: platform ?? null,
      place_id: newPlace.id,
    })
    .select()
    .single<LocationPulse>();
  if (pulseErr) throw new Error(`insert pulse: ${pulseErr.message}`);

  logPulse("Lugar nuevo persistido; pulso creado con place_id = nuevo UUID.", {
    newPlaceId: newPlace.id,
    isHome: newPlace.is_home,
  });
  return { pulse, place: newPlace, action: "created" };
}

/**
 * Rules:
 * 1. If there is a known place within 60 m  → associate pulse, update last_seen_at.
 * 2. If no place within 60 m, look at the latest pulse in DB (before this insert):
 *    a. No previous pulse  → insert pulse con place_id = null (primer ping; sin historia).
 *    b. It had a place_id  → nuevo tramo: casa cercana o nuevo lugar.
 *    c. It had no place_id  → ya había un “defer”; este es el 2.º punto →
 *       mismo criterio que (b) (ancla o crea; sale del limbo de defer encadenado).
 */
async function upsertPulse(body: LocationPulseBody): Promise<{
  pulse: LocationPulse | null;
  place: LocationPlace | null;
  action: "matched" | "created" | "deferred" | "home_silent";
  prevPlaceId: string | null;
  prevRecordedAt: string | null;
  prevCreatedAt: string | null;
}> {
  const supabase = getSupabaseAdminClient();
  const { lat, lng, accuracy, recordedAt, source, platform } = body;

  logPulse("Entrando a la lógica (coordenadas del pulso y metadatos).", {
    coords: { lat, lng },
    accuracyM: accuracy ?? null,
    recordedAt,
    source: source ?? null,
    platform: platform ?? null,
  });

  // ── 1. Find the nearest place within 60 m ─────────────────────────────────
  const { data: nearestRows, error: nearestError } = await supabase.rpc(
    "location_nearest_place",
    { p_lat: lat, p_lng: lng, p_radius_m: 60 },
  );
  if (nearestError) throw new Error(`nearest place rpc: ${nearestError.message}`);

  const nearest: LocationPlace | null =
    Array.isArray(nearestRows) && nearestRows.length > 0
      ? (nearestRows[0] as LocationPlace)
      : null;

  if (nearest) {
    const role = nearest.is_home
      ? "Ese registro es is_home=true (casa o similar)."
      : "Ese registro no es is_home; es un lugar genérico que ya existía a ≤60 m.";
    logPulse(
      `Paso 1 — Cualquier location_places a ≤60 m (location_nearest_place): SÍ. ${role} Se reutiliza el mismo id (unión, no crear otro).`,
      {
        existingPlaceId: nearest.id,
        isHome: nearest.is_home,
        placeCenter: { lat: nearest.lat, lng: nearest.lng },
      },
    );
  } else {
    logPulse(
      "Paso 1 — Cualquier location_places a ≤60 m: NO. No se une a un sitio existente por proximidad; se mira el historial de pulsos o se difiere el primer ping.",
    );
  }

  // ── 2. Lugar a ≤ 60 m: casa → solo last_seen, sin fila en location_pulses
  // prevPlaceId se obtiene más abajo en paso 3; para el caso nearest aquí no lo conocemos aún,
  // así que hacemos la query prev también para step-2 returns.
  if (nearest) {
    // Fetch prev para session-close (mismo select que paso 3)
    const { data: pr2, error: pr2Err } = await supabase
      .from("location_pulses")
      .select("place_id, recorded_at, created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    if (pr2Err) throw new Error(`prev pulse (step2): ${pr2Err.message}`);
    const p2 = Array.isArray(pr2) && pr2.length > 0
      ? (pr2[0] as { place_id: string | null; recorded_at: string; created_at: string })
      : null;

    if (nearest.is_home) {
      const place = await touchHomeOnly(supabase, nearest, body);
      return {
        pulse: null, place, action: "home_silent",
        prevPlaceId: p2?.place_id ?? null,
        prevRecordedAt: p2?.recorded_at ?? null,
        prevCreatedAt: p2?.created_at ?? null,
      };
    }
    const { pulse, place: updatedPlace } = await attachPulseToPlace(supabase, nearest, body);
    return {
      pulse, place: updatedPlace, action: "matched",
      prevPlaceId: p2?.place_id ?? null,
      prevRecordedAt: p2?.recorded_at ?? null,
      prevCreatedAt: p2?.created_at ?? null,
    };
  }

  // ── 3. No nearby place: check previous pulse (última fila antes de este insert)
  const { data: prevRows, error: prevErr } = await supabase
    .from("location_pulses")
    .select("place_id, recorded_at, created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  if (prevErr) throw new Error(`prev pulse: ${prevErr.message}`);

  const prev =
    Array.isArray(prevRows) && prevRows.length > 0
      ? (prevRows[0] as { place_id: string | null; recorded_at: string; created_at: string })
      : null;

  if (!prev) {
    logPulse(
      "Paso 2 — Aún no había filas en location_pulses. No se puede anclar a un sitio: se guarda este pulso con place_id = null (diferido) hasta el siguiente dato.",
    );
    // ── 3a. Primer pulso en BD: un solo punto; aún no hay 2.º para anclar
    const { data: pulse, error: pulseErr } = await supabase
      .from("location_pulses")
      .insert({
        lat,
        lng,
        accuracy: accuracy ?? null,
        recorded_at: recordedAt,
        source: source ?? null,
        platform: platform ?? null,
        place_id: null,
      })
      .select()
      .single<LocationPulse>();
    if (pulseErr) throw new Error(`insert deferred pulse: ${pulseErr.message}`);

    logPulse("Resultado: DEFER — lista de lugares en app sigue vacía hasta que haya lógica posterior o 2.º pulso / seed en BD.");
    return {
      pulse, place: null, action: "deferred",
      prevPlaceId: null, prevRecordedAt: null, prevCreatedAt: null,
    };
  }

  logPulse(
    "Paso 2 — Ya existía al menos un pulso previo. Siguiente: si no hay is_home a ≤60 m, crear sitio NUEVO; si la hay, anclar a casa.",
    { lastPrevHadPlaceId: prev.place_id !== null },
  );
  // ── 3b. Al menos un pulso previo (con o sin place) → ancla o tramo (evita defer ∞)
  const r3b = await matchHomeOrCreatePlace(supabase, body);
  return {
    ...r3b,
    prevPlaceId: prev.place_id,
    prevRecordedAt: prev.recorded_at,
    prevCreatedAt: prev.created_at,
  };
}

// ─── Session close → auto habit blocks ───────────────────────────────────────

const PLANNER_TZ = "America/Caracas";

function plannerDateVET(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PLANNER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Cuando el usuario sale de un lugar no-home que tiene hábitos vinculados,
 * crea un actual_habit_block por cada hábito usando los tiempos reales de la sesión
 * (primer pulso de la racha → último pulso = prevRecordedAt).
 */
async function maybeCloseSession(
  prevPlaceId: string,
  prevRecordedAt: string,
  prevCreatedAt: string,
): Promise<{ created: number; errors: string[] }> {
  const supabase = getSupabaseAdminClient();

  // ── Hábitos vinculados al lugar
  const { data: habitRows, error: hErr } = await supabase
    .from("location_place_habits")
    .select("habit_type_id")
    .eq("place_id", prevPlaceId);
  if (hErr) throw new Error(`place habits: ${hErr.message}`);
  if (!habitRows || habitRows.length === 0) return { created: 0, errors: [] };

  // ── Inicio de sesión: último pulso en OTRO lugar antes de esta racha en prevPlaceId
  const { data: gapRows } = await supabase
    .from("location_pulses")
    .select("created_at")
    .neq("place_id", prevPlaceId)
    .lt("created_at", prevCreatedAt)
    .order("created_at", { ascending: false })
    .limit(1);
  const gapCutoff = gapRows?.[0]?.created_at ?? "1900-01-01T00:00:00Z";

  const { data: startRows } = await supabase
    .from("location_pulses")
    .select("recorded_at")
    .eq("place_id", prevPlaceId)
    .gt("created_at", gapCutoff)
    .order("created_at", { ascending: true })
    .limit(1);

  const sessionStart = startRows?.[0]?.recorded_at ?? prevRecordedAt;
  const sessionEnd = prevRecordedAt;

  const { count: sessionCountRaw } = await supabase
    .from("location_pulses")
    .select("id", { count: "exact", head: true })
    .eq("place_id", prevPlaceId)
    .gt("created_at", gapCutoff)
    .lte("created_at", prevCreatedAt);
  const sessionCount = sessionCountRaw ?? 0;

  const startDate = new Date(sessionStart);
  const endDate = new Date(sessionEnd);
  const adjustedEnd =
    sessionCount <= 1 || endDate <= startDate
      ? new Date(startDate.getTime() + ASSUMED_SINGLE_PULSE_VISIT_MS).toISOString()
      : sessionEnd;

  const scheduledDate = plannerDateVET(startDate);

  logPulse(
    "Cierre de sesión: creando actual_habit_block(s) automáticos para el lugar.",
    {
      prevPlaceId,
      sessionStart,
      sessionEnd: adjustedEnd,
      scheduledDate,
      habitCount: habitRows.length,
    },
  );

  let created = 0;
  const errors: string[] = [];

  for (const row of habitRows as { habit_type_id: string }[]) {
    const { error: insertErr } = await supabase
      .from("actual_habit_blocks")
      .insert({
        scheduled_date: scheduledDate,
        start_at: sessionStart,
        end_at: adjustedEnd,
        habit_type_id: row.habit_type_id,
        description: `Auto: visita registrada (${sessionStart.slice(11, 16)}–${adjustedEnd.slice(11, 16)} VET)`,
        planned_block_id: null,
      });

    if (insertErr) {
      errors.push(`${row.habit_type_id}: ${insertErr.message}`);
    } else {
      created++;
    }
  }

  return { created, errors };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * POST from the mobile background task.
 * Optional auth: set LOCATION_PULSE_SECRET (server) and
 * EXPO_PUBLIC_LOCATION_PULSE_SECRET (mobile) to the same value.
 */
export async function POST(request: NextRequest) {
  try {
    if (!verifySecret(request)) {
      console.warn("[location/pulse] POST rejected: unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as LocationPulseBody;
    if (typeof body.lat !== "number" || typeof body.lng !== "number") {
      console.warn("[location/pulse] POST rejected: missing lat/lng", {
        lat: body.lat,
        lng: body.lng,
      });
      return NextResponse.json({ error: "lat and lng required" }, { status: 400 });
    }

    const result = await upsertPulse(body);

    // ── Cierre de sesión en lugar previo (si el usuario salió)
    const currentPlaceId = result.place?.id ?? null;
    if (
      result.prevPlaceId &&
      result.prevPlaceId !== currentPlaceId &&
      result.prevRecordedAt &&
      result.prevCreatedAt
    ) {
      try {
        const session = await maybeCloseSession(
          result.prevPlaceId,
          result.prevRecordedAt,
          result.prevCreatedAt,
        );
        if (session.created > 0) {
          logPulse(
            `Hábitos auto-creados por salida del lugar anterior: ${session.created} bloques.`,
            { prevPlaceId: result.prevPlaceId, created: session.created, errors: session.errors },
          );
        }
      } catch (e) {
        console.error("[location/pulse] maybeCloseSession error", e);
      }
    }

    const summary =
      result.action === "deferred"
        ? "Resumen: DEFER (sin fila en location_places; solo se guardó el raw pulse)."
        : result.action === "home_silent"
          ? "Resumen: CASA (is_home) — solo last_seen, sin fila en location_pulses."
          : result.action === "created"
            ? "Resumen: CREADO sitio nuevo (is_home=false) + pulso (salvo notificación/push en handler)."
            : result.place?.is_home
              ? "Resumen: MATCH con sitio existente; ese sitio es is_home=true (casa) o false según el id listado abajo."
              : "Resumen: MATCH con sitio existente a ≤60 m (lugar no-home o ya registrado cerca).";
    logPulse(summary, {
      action: result.action,
      placeId: result.place?.id ?? null,
      placeIsHome: result.place?.is_home ?? null,
      pulseId: result.pulse?.id ?? null,
    });

    if (result.action === "created" && result.place) {
      const p = result.place;
      try {
        await handleSendCustomNotification({
          title: "🔴 Lugar nuevo",
          body: "Se detectó y guardó un sitio distinto. Revisa o nómbralo (casa) en Lugares.",
          data: {
            type: "location_place_created",
            place_id: p.id,
            lat: p.lat,
            lng: p.lng,
          },
          collapseId: `location-place-${p.id}`,
        });
      } catch (e) {
        console.error("[location/pulse] push (solo en created)", e);
      }
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return apiError(error);
  }
}
