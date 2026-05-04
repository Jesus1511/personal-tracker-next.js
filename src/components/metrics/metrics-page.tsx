"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { localDateString } from "@/lib/planner/date";

function formatTooltipNumber(value: unknown, suffix: string): string {
  const n = typeof value === "number" ? value : Number(value);
  return `${Number.isFinite(n) ? n : 0}${suffix}`;
}

type MetricsResponse = {
  range: { start: string; end: string };
  pointsByDay: { date: string; planned: number; completed: number }[];
  habitAdherence: {
    habitTypeId: string;
    name: string;
    color: string | null;
    planned: number;
    actual: number;
    adherencePct: number | null;
  }[];
  focusHeatmap: { date: string; hours: number; level: 0 | 1 | 2 | 3 | 4 }[];
  hoursByDay: { date: string; plannedHours: number; actualHours: number }[];
  dailyGoalsByDay: { date: string; hasGoal: boolean; done: boolean }[];
  routineByDay: {
    date: string;
    hoursScore: number;
    timeWindowScore: number;
    routineScore: number;
  }[];
  taskTypeDistribution: {
    taskTypeId: string | null;
    name: string;
    color: string | null;
    hours: number;
  }[];
  habitStreaks: {
    habitTypeId: string;
    name: string;
    color: string | null;
    currentStreak: number;
    bestStreak: number;
  }[];
  streakTracking?: { total: number; tracked: number };
  habitCrossData?: {
    id: string;
    name: string;
    color: string | null;
    isWork: boolean;
    byDay: { date: string; hours: number }[];
  }[];
  habitDailyMap?: {
    id: string;
    name: string;
    color: string | null;
    byDay: { date: string; done: boolean }[];
  }[];
};

const METRICS_RANGE_STORAGE_KEY = "planner-metrics-date-range";

type StoredRange =
  | { kind: "today" }
  | { kind: "range"; start: string; end: string };

function todayIso(): string {
  return localDateString(new Date());
}

const CARACAS_TZ = "America/Caracas";

function caracasTodayIso(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CARACAS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function caracasHourMinute(d: Date): { hour: number; minute: number } {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: CARACAS_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(d);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return { hour, minute };
}

function defaultRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  return { start: localDateString(start), end: localDateString(end) };
}

function clampRangeStrings(start: string, end: string): { start: string; end: string } {
  const t = todayIso();
  let s = start;
  let e = end;
  if (s > e) [s, e] = [e, s];
  if (e > t) e = t;
  if (s > t) s = t;
  return { start: s, end: e };
}

function readStoredRange(): {
  start: string;
  end: string;
  persistKind: "today" | "range";
} {
  if (typeof window === "undefined") {
    const d = defaultRange();
    return { ...d, persistKind: "range" };
  }
  try {
    const raw = localStorage.getItem(METRICS_RANGE_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as StoredRange;
      if (p.kind === "today") {
        const t = todayIso();
        return { start: t, end: t, persistKind: "today" };
      }
      if (p.kind === "range" && typeof p.start === "string" && typeof p.end === "string") {
        const c = clampRangeStrings(p.start, p.end);
        return { ...c, persistKind: "range" };
      }
    }
  } catch {
    /* ignore */
  }
  const d = defaultRange();
  return { ...d, persistKind: "range" };
}

function persistRange(kind: "today" | "range", start?: string, end?: string) {
  if (typeof window === "undefined") return;
  try {
    if (kind === "today") {
      localStorage.setItem(METRICS_RANGE_STORAGE_KEY, JSON.stringify({ kind: "today" } satisfies StoredRange));
    } else if (start && end) {
      const c = clampRangeStrings(start, end);
      localStorage.setItem(
        METRICS_RANGE_STORAGE_KEY,
        JSON.stringify({ kind: "range", start: c.start, end: c.end } satisfies StoredRange),
      );
    }
  } catch {
    /* ignore */
  }
}

/** Short MM-DD label for axis ticks so strings don't overlap. */
function shortDate(iso: string) {
  return iso.slice(5); // "MM-DD"
}

type ActiveKpi = "hours" | "pph" | "completion" | "routine";
type ChartGranularity = "day" | "week" | "month";

type DailyMetricRow = {
  date: string;
  planned: number;
  completed: number;
  plannedHours: number;
  actualHours: number;
  hasGoal: boolean;
  done: boolean;
  routineScore: number;
  hoursScore: number;
  timeWindowScore: number;
};

function weekStartLocal(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  dt.setDate(dt.getDate() + mondayOffset);
  return localDateString(dt);
}

function periodBucketKey(date: string, g: ChartGranularity): string {
  if (g === "day") return date;
  if (g === "week") return weekStartLocal(date);
  return date.slice(0, 7);
}

function periodDisplayLabel(bucketKey: string, g: ChartGranularity): string {
  if (g === "day") return shortDate(bucketKey);
  if (g === "week") return `Sem ${shortDate(bucketKey)}`;
  return bucketKey;
}

const HEATMAP_LEVEL_CLASS = [
  "bg-zinc-100 dark:bg-zinc-800",
  "bg-red-200 dark:bg-red-900",
  "bg-yellow-300 dark:bg-yellow-600",
  "bg-emerald-300 dark:bg-emerald-800",
  "bg-emerald-500 dark:bg-emerald-500",
];

/** Pixel size for heatmap day cells (w/h). */
const HEATMAP_CELL = "h-4 w-4 min-h-4 min-w-4 sm:h-[18px] sm:w-[18px] sm:min-h-[18px] sm:min-w-[18px]";
const HEATMAP_GAP_COL = "gap-1";
const HEATMAP_GAP_ROW = "gap-2";

/** Filas fijas: lunes → domingo */
const HEATMAP_WEEKDAY_LABELS = ["L", "M", "X", "J", "V", "S", "D"] as const;

type HeatmapPad = { kind: "pad" };

function addDaysIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return localDateString(dt);
}

/** Lunes local de la semana que contiene la fecha */
function mondayOfWeekContaining(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  const delta = dow === 0 ? -6 : 1 - dow;
  dt.setDate(dt.getDate() + delta);
  return localDateString(dt);
}

function sundayOfWeekContaining(iso: string): string {
  return addDaysIso(mondayOfWeekContaining(iso), 6);
}

function isoDateCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Columnas = semanas (lun–dom); celdas fuera del rango o sin dato = hueco alineado */
function buildCalendarWeekColumns<T extends { date: string }>(
  items: T[],
  rangeStart: string,
  rangeEnd: string,
): (T | HeatmapPad)[][] {
  const byDate = new Map(items.map((x) => [x.date, x]));
  const gridStart = mondayOfWeekContaining(rangeStart);
  const gridEnd = sundayOfWeekContaining(rangeEnd);
  const cols: (T | HeatmapPad)[][] = [];
  for (
    let weekMon = gridStart;
    isoDateCompare(weekMon, gridEnd) <= 0;
    weekMon = addDaysIso(weekMon, 7)
  ) {
    const col: (T | HeatmapPad)[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDaysIso(weekMon, i);
      if (isoDateCompare(d, rangeStart) < 0 || isoDateCompare(d, rangeEnd) > 0) {
        col.push({ kind: "pad" });
      } else {
        const row = byDate.get(d);
        col.push(row ?? { kind: "pad" });
      }
    }
    cols.push(col);
  }
  return cols;
}

function isHeatmapPad(cell: unknown): cell is HeatmapPad {
  return (
    typeof cell === "object" &&
    cell !== null &&
    "kind" in cell &&
    (cell as HeatmapPad).kind === "pad"
  );
}

/** Misma altura por fila que HEATMAP_CELL para alinear con el grid */
const HEATMAP_DAY_LABEL_CELL =
  "flex h-4 min-h-4 items-center justify-end pr-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400 sm:h-[18px] sm:min-h-[18px] sm:pr-1.5 sm:text-sm";

function focusHeatDetail(level: number, hours: number): string[] {
  const h = `${Number.isFinite(hours) ? hours : 0} h de foco real`;
  switch (level) {
    case 0:
      return [h, "Sin registro o 0 h"];
    case 1:
      return [h, "Poco (< 2.5 h)"];
    case 2:
      return [h, "Moderado (2.5–4 h)"];
    case 3:
      return [h, "Bueno (4–6 h)"];
    case 4:
      return [h, "Alto (6+ h)"];
    default:
      return [h];
  }
}

const TASK_TYPE_FALLBACK_PALETTE = [
  "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#3b82f6", "#ec4899", "#14b8a6",
];

export function MetricsPage() {
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const [rangeMode, setRangeMode] = useState<"today" | "range" | null>(null);
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeKpi, setActiveKpi] = useState<ActiveKpi | null>(null);
  const [chartGranularity, setChartGranularity] = useState<ChartGranularity>("day");
  const [streakModalOpen, setStreakModalOpen] = useState(false);
  const [activeCrossSeries, setActiveCrossSeries] = useState<Set<string>>(new Set(["__work__"]));
  const [activeHabitHeatmap, setActiveHabitHeatmap] = useState<string | null>(null);
  const [heatTooltip, setHeatTooltip] = useState<{
    x: number;
    y: number;
    title: string;
    lines: string[];
  } | null>(null);

  const [summaryGateNow, setSummaryGateNow] = useState(() => new Date());
  const [summaryDraft, setSummaryDraft] = useState("");
  const [summarySaved, setSummarySaved] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summarySaving, setSummarySaving] = useState(false);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);
  const [summaryWantEdit, setSummaryWantEdit] = useState(true);
  const summarySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canEditDailySummary = caracasHourMinute(summaryGateNow).hour >= 21;

  const loadDailySummary = useCallback(async () => {
    const date = caracasTodayIso();
    setSummaryLoading(true);
    setSummaryErr(null);
    try {
      const res = await fetch(`/api/planner/daily-summaries?date=${date}`);
      const json = (await res.json()) as { dailySummary?: { text?: string } | null; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Error cargando resumen");
      const text = json.dailySummary?.text ?? "";
      setSummarySaved(text);
      setSummaryDraft(text);
      setSummaryWantEdit(text.length === 0);
    } catch (e) {
      setSummaryErr(e instanceof Error ? e.message : "Error resumen");
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  const persistDailySummary = useCallback(async (text: string) => {
    const date = caracasTodayIso();
    setSummarySaving(true);
    setSummaryErr(null);
    try {
      const res = await fetch("/api/planner/daily-summaries", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, text }),
      });
      const json = (await res.json()) as { dailySummary?: { text?: string }; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Error guardando resumen");
      const saved = json.dailySummary?.text ?? text;
      setSummarySaved(saved);
      setSummaryDraft(saved);
      setSummaryWantEdit(saved.length === 0);
    } catch (e) {
      setSummaryErr(e instanceof Error ? e.message : "Error guardando");
    } finally {
      setSummarySaving(false);
    }
  }, []);

  const schedulePersistDailySummary = useCallback(
    (text: string) => {
      if (summarySaveTimer.current) clearTimeout(summarySaveTimer.current);
      summarySaveTimer.current = setTimeout(() => {
        summarySaveTimer.current = null;
        void persistDailySummary(text);
      }, 400);
    },
    [persistDailySummary],
  );

  useEffect(() => {
    void loadDailySummary();
  }, [loadDailySummary]);

  useEffect(() => {
    const id = setInterval(() => setSummaryGateNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (summarySaveTimer.current) clearTimeout(summarySaveTimer.current);
    };
  }, []);

  useEffect(() => {
    const r = readStoredRange();
    setRange({ start: r.start, end: r.end });
    setRangeMode(r.persistKind);
  }, []);

  const load = useCallback(async (start: string, end: string) => {
    setLoading(true);
    setError(null);
    try {
      const c = clampRangeStrings(start, end);
      const res = await fetch(`/api/planner/metrics?start=${c.start}&end=${c.end}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Error cargando métricas");
      setData(json as MetricsResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!range) return;
    void load(range.start, range.end);
  }, [range, load]);

  const dailyRows = useMemo((): DailyMetricRow[] => {
    if (!data) return [];
    return data.pointsByDay.map((p, i) => ({
      date: p.date,
      planned: p.planned,
      completed: p.completed,
      plannedHours: data.hoursByDay[i]?.plannedHours ?? 0,
      actualHours: data.hoursByDay[i]?.actualHours ?? 0,
      hasGoal: data.dailyGoalsByDay?.[i]?.hasGoal ?? false,
      done: data.dailyGoalsByDay?.[i]?.done ?? false,
      routineScore: data.routineByDay?.[i]?.routineScore ?? 0,
      hoursScore: data.routineByDay?.[i]?.hoursScore ?? 0,
      timeWindowScore: data.routineByDay?.[i]?.timeWindowScore ?? 0,
    }));
  }, [data]);

  const summary = useMemo(() => {
    if (!data || dailyRows.length === 0) return null;
    const totalCompleted = dailyRows.reduce((s, d) => s + d.completed, 0);
    const totalPlannedPts = dailyRows.reduce((s, d) => s + d.planned, 0);
    const totalActualHrs = dailyRows.reduce((s, d) => s + d.actualHours, 0);
    const nDays = dailyRows.length;
    const ptsPerHour = totalActualHrs > 0 ? totalCompleted / totalActualHrs : null;
    const pointsCompletionPct =
      totalPlannedPts > 0 ? Math.round((totalCompleted / totalPlannedPts) * 100) : null;
    const daysWithGoal = dailyRows.filter((d) => d.hasGoal);
    const daysMainDone = daysWithGoal.filter((d) => d.done);
    const mainTaskPct =
      daysWithGoal.length > 0 ? Math.round((daysMainDone.length / daysWithGoal.length) * 100) : null;
    const routineDays = dailyRows.filter((d) => d.plannedHours > 0);
    const routinePct =
      routineDays.length > 0
        ? +(
            routineDays.reduce((s, d) => s + d.routineScore, 0) / routineDays.length
          ).toFixed(1)
        : null;
    const avgHoursScore =
      routineDays.length > 0
        ? +(routineDays.reduce((s, d) => s + d.hoursScore, 0) / routineDays.length).toFixed(0)
        : null;
    const avgWindowScore =
      routineDays.length > 0
        ? +(routineDays.reduce((s, d) => s + d.timeWindowScore, 0) / routineDays.length).toFixed(0)
        : null;
    return {
      totalActualHrs: +totalActualHrs.toFixed(1),
      avgHoursPerDay: nDays > 0 ? +(totalActualHrs / nDays).toFixed(1) : 0,
      totalCompleted,
      totalPlannedPts,
      ptsPerHour: ptsPerHour !== null ? +ptsPerHour.toFixed(2) : null,
      pointsCompletionPct,
      mainTaskPct,
      routinePct,
      avgHoursScore,
      avgWindowScore,
      nDays,
    };
  }, [data, dailyRows]);

  const kpiChartData = useMemo(() => {
    if (!activeKpi || dailyRows.length === 0) return [];
    const buckets = new Map<string, DailyMetricRow[]>();
    for (const r of dailyRows) {
      const k = periodBucketKey(r.date, chartGranularity);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(r);
    }
    const keys = [...buckets.keys()].sort();
    return keys.map((bucketKey) => {
      const chunk = buckets.get(bucketKey)!;
      const label = periodDisplayLabel(bucketKey, chartGranularity);
      if (activeKpi === "hours") {
        const hours = chunk.reduce((s, r) => s + r.actualHours, 0);
        return { label, value: +hours.toFixed(2) };
      }
      if (activeKpi === "pph") {
        const h = chunk.reduce((s, r) => s + r.actualHours, 0);
        const c = chunk.reduce((s, r) => s + r.completed, 0);
        return { label, value: h > 0 ? +((c / h).toFixed(2)) : 0 };
      }
      if (activeKpi === "completion") {
        const plannedSum = chunk.reduce((s, r) => s + r.planned, 0);
        const completedSum = chunk.reduce((s, r) => s + r.completed, 0);
        const pointsPct =
          plannedSum > 0 ? +((completedSum / plannedSum) * 100).toFixed(1) : 0;
        const me = chunk.filter((r) => r.hasGoal);
        const mainPct = me.length
          ? +((me.filter((r) => r.done).length / me.length) * 100).toFixed(1)
          : 0;
        return { label, pointsPct, mainPct };
      }
      const re = chunk.filter((r) => r.plannedHours > 0);
      const routine = re.length
        ? +(re.reduce((s, r) => s + r.routineScore, 0) / re.length).toFixed(1)
        : 0;
      return { label, value: routine };
    });
  }, [activeKpi, chartGranularity, dailyRows]);

  useEffect(() => {
    if (!data?.habitDailyMap?.length) return;
    setActiveHabitHeatmap((prev) => {
      if (prev && data.habitDailyMap!.some((h) => h.id === prev)) return prev;
      return data.habitDailyMap![0].id;
    });
  }, [data]);

  const habitHeatmapSeries = useMemo(() => {
    if (!data?.habitDailyMap || !activeHabitHeatmap) return null;
    return data.habitDailyMap.find((h) => h.id === activeHabitHeatmap) ?? null;
  }, [data, activeHabitHeatmap]);

  const crossChartRows = useMemo(() => {
    if (!data?.habitCrossData || activeCrossSeries.size === 0) return [];
    const active = data.habitCrossData.filter((s) => activeCrossSeries.has(s.id));
    if (active.length === 0) return [];
    const dateSet = active[0].byDay.map((r) => r.date);
    return dateSet.map((date, i) => {
      const row: Record<string, string | number> = { date };
      for (const s of active) {
        row[s.id] = s.byDay[i]?.hours ?? 0;
      }
      return row;
    });
  }, [data, activeCrossSeries]);

  const focusHeatmapColumns = useMemo(() => {
    if (!data) return [] as ({ date: string; hours: number; level: number } | HeatmapPad)[][];
    return buildCalendarWeekColumns(data.focusHeatmap, data.range.start, data.range.end);
  }, [data]);

  const habitHeatmapColumns = useMemo(() => {
    if (!habitHeatmapSeries || !data)
      return [] as ({ date: string; done: boolean } | HeatmapPad)[][];
    return buildCalendarWeekColumns(
      habitHeatmapSeries.byDay,
      data.range.start,
      data.range.end,
    );
  }, [habitHeatmapSeries, data]);

  const todayMax = todayIso();

  if (!range || rangeMode === null) {
    return (
      <main className="flex w-full flex-col gap-5 px-6 py-6 lg:px-20">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Métricas
            </h1>
            <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
              KPIs de productividad, hábitos y foco.
            </p>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center py-20">
          <p className="text-sm text-zinc-400">Cargando métricas…</p>
        </div>
      </main>
    );
  }

  const setToday = () => {
    const t = todayIso();
    setRange({ start: t, end: t });
    setRangeMode("today");
    persistRange("today");
  };

  const onStartChange = (v: string) => {
    if (!v) return;
    const c = clampRangeStrings(v, range.end);
    setRange(c);
    setRangeMode("range");
    persistRange("range", c.start, c.end);
  };

  const onEndChange = (v: string) => {
    if (!v) return;
    const c = clampRangeStrings(range.start, v);
    setRange(c);
    setRangeMode("range");
    persistRange("range", c.start, c.end);
  };

  const onKpiClick = (id: ActiveKpi) => {
    setActiveKpi((prev) => (prev === id ? null : id));
  };

  const kpiChartTitle =
    activeKpi === "hours"
      ? "Horas reales trabajadas"
      : activeKpi === "pph"
        ? "Puntos por hora"
        : activeKpi === "completion"
          ? "Completitud: puntos y meta principal"
          : activeKpi === "routine"
            ? "Cumplimiento de rutina"
            : "";

  return (
    <main className="flex w-full flex-col gap-5 px-6 py-6 lg:px-20">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Métricas
          </h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            KPIs de productividad, hábitos y foco.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
          <button
            type="button"
            onClick={setToday}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              rangeMode === "today"
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            }`}
          >
            Hoy
          </button>
          <span className="text-zinc-300 dark:text-zinc-600" aria-hidden>
            |
          </span>
          <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
            <span className="sr-only">Desde</span>
            <input
              type="date"
              value={range.start}
              max={range.end}
              onChange={(e) => onStartChange(e.target.value)}
              onKeyDown={(e) => e.preventDefault()}
              onClick={(e) => (e.currentTarget as HTMLInputElement).showPicker?.()}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </label>
          <span className="text-zinc-400">—</span>
          <label className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
            <span className="sr-only">Hasta</span>
            <input
              type="date"
              value={range.end}
              min={range.start}
              max={todayMax}
              onChange={(e) => onEndChange(e.target.value)}
              onKeyDown={(e) => e.preventDefault()}
              onClick={(e) => (e.currentTarget as HTMLInputElement).showPicker?.()}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-zinc-900 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </label>
        </div>
      </header>

      <StreakTrackModal
        open={streakModalOpen}
        onClose={() => setStreakModalOpen(false)}
        onAfterSave={() => {
          if (range) void load(range.start, range.end);
        }}
      />

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50/80 px-4 py-2.5 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex flex-1 items-center justify-center py-20">
          <p className="text-sm text-zinc-400">Cargando métricas…</p>
        </div>
      ) : data ? (
        <>
          {/* ------- Summary tiles ------- */}
          {summary && (
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiTile
                label="Horas reales"
                value={`${summary.totalActualHrs}h`}
                hint={`~${summary.avgHoursPerDay}h/día`}
                active={activeKpi === "hours"}
                onClick={() => onKpiClick("hours")}
              />
              <KpiTile
                label="Pts / hora"
                value={summary.ptsPerHour !== null ? `${summary.ptsPerHour}` : "—"}
                hint={`${summary.totalCompleted} pts total`}
                active={activeKpi === "pph"}
                onClick={() => onKpiClick("pph")}
              />
              <KpiTile
                label="Completitud"
                valueLines={
                  summary.pointsCompletionPct !== null && summary.mainTaskPct !== null
                    ? [`${summary.pointsCompletionPct}% puntos`, `${summary.mainTaskPct}% meta`]
                    : undefined
                }
                value={
                  summary.pointsCompletionPct === null || summary.mainTaskPct === null
                    ? "—"
                    : undefined
                }
                hint={
                  summary.totalPlannedPts > 0
                    ? `${summary.totalCompleted}/${summary.totalPlannedPts} pts · ${summary.nDays}d`
                    : `${summary.nDays} días en rango`
                }
                active={activeKpi === "completion"}
                onClick={() => onKpiClick("completion")}
              />
              <KpiTile
                label="Rutina"
                value={summary.routinePct !== null ? `${summary.routinePct}%` : "—"}
                hint={
                  summary.avgHoursScore != null && summary.avgWindowScore != null
                    ? `Horas ${summary.avgHoursScore}% × Ventana ${summary.avgWindowScore}%`
                    : "Sin bloques planificados"
                }
                active={activeKpi === "routine"}
                onClick={() => onKpiClick("routine")}
              />
            </section>
          )}

          <div
            className={`overflow-hidden transition-[max-height,opacity] duration-300 ease-in-out ${
              activeKpi ? "max-h-[460px] opacity-100" : "max-h-0 opacity-0"
            }`}
            aria-hidden={!activeKpi}
          >
            {activeKpi && kpiChartData.length > 0 && (
              <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{kpiChartTitle}</h3>
                  <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-950">
                    {(
                      [
                        ["day", "Día"],
                        ["week", "Semana"],
                        ["month", "Mes"],
                      ] as const
                    ).map(([val, name]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setChartGranularity(val)}
                        className={`rounded-md px-2.5 py-1 transition-colors ${
                          chartGranularity === val
                            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                            : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                        }`}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  {activeKpi === "completion" ? (
                    <LineChart data={kpiChartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" strokeOpacity={0.4} />
                      <XAxis dataKey="label" fontSize={10} interval="preserveStartEnd" />
                      <YAxis domain={[0, 100]} fontSize={10} />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(value) => formatTooltipNumber(value, "%")}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Line type="monotone" dataKey="pointsPct" name="% puntos (hecho/plan)" stroke="#8b5cf6" strokeWidth={2} dot />
                      <Line type="monotone" dataKey="mainPct" name="% meta principal" stroke="#10b981" strokeWidth={2} dot />
                    </LineChart>
                  ) : (
                    <LineChart data={kpiChartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" strokeOpacity={0.4} />
                      <XAxis dataKey="label" fontSize={10} interval="preserveStartEnd" />
                      <YAxis
                        fontSize={10}
                        domain={
                          activeKpi === "routine" ? [0, 100] : [0, "auto"]
                        }
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(v) =>
                          activeKpi === "routine"
                            ? formatTooltipNumber(v, "%")
                            : activeKpi === "hours"
                              ? formatTooltipNumber(v, "h")
                              : formatTooltipNumber(v, " pts/h")
                        }
                      />
                      <Line
                        type="monotone"
                        dataKey="value"
                        name={
                          activeKpi === "hours"
                            ? "Horas"
                            : activeKpi === "pph"
                              ? "Pts/h"
                              : "Rutina %"
                        }
                        stroke="#8b5cf6"
                        strokeWidth={2}
                        dot
                      />
                    </LineChart>
                  )}
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <details className="rounded-xl border border-zinc-200 bg-white shadow-sm open:pb-4 dark:border-zinc-800 dark:bg-zinc-900">
            <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-zinc-900 marker:hidden dark:text-zinc-50 [&::-webkit-details-marker]:hidden">
              <span className="underline-offset-2 hover:underline">Resumen del día (hasta 200 caracteres)</span>
              <span className="ml-2 font-normal text-zinc-500 dark:text-zinc-400">
                — Venezuela, editable desde las 9:00 PM
              </span>
            </summary>
            <div className="space-y-2 border-t border-zinc-100 px-4 pt-3 dark:border-zinc-800">
              {summaryErr && (
                <p className="text-xs text-rose-600 dark:text-rose-400">{summaryErr}</p>
              )}
              {summaryLoading ? (
                <p className="text-xs text-zinc-500">Cargando resumen…</p>
              ) : !canEditDailySummary ? (
                <>
                  <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">
                    {summarySaved.length > 0 ? summarySaved : "—"}
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Disponible después de las 9 PM (hora Venezuela).
                  </p>
                </>
              ) : summarySaved.length > 0 && !summaryWantEdit ? (
                <div className="space-y-2">
                  <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{summarySaved}</p>
                  <button
                    type="button"
                    onClick={() => setSummaryWantEdit(true)}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 dark:border-zinc-600 dark:bg-zinc-950 dark:text-zinc-100"
                  >
                    Editar
                  </button>
                </div>
              ) : (
                <>
                  <textarea
                    maxLength={200}
                    value={summaryDraft}
                    disabled={!canEditDailySummary || summarySaving}
                    onChange={(e) => setSummaryDraft(e.target.value)}
                    onBlur={() => {
                      if (!canEditDailySummary) return;
                      schedulePersistDailySummary(summaryDraft);
                    }}
                    rows={4}
                    className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                    placeholder="¿Cómo fue hoy?"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-zinc-500">
                      {summaryDraft.length}/200
                      {summarySaving ? " · Guardando…" : ""}
                    </span>
                    <button
                      type="button"
                      disabled={!canEditDailySummary || summarySaving}
                      onClick={() => {
                        if (summarySaveTimer.current) {
                          clearTimeout(summarySaveTimer.current);
                          summarySaveTimer.current = null;
                        }
                        void persistDailySummary(summaryDraft);
                      }}
                      className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      Guardar
                    </button>
                  </div>
                </>
              )}
            </div>
          </details>

          {/* ------- Grid of charts ------- */}
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* 1. Points planned vs completed */}
            <ChartCard title="Puntos planificados vs completados" subtitle="Cada día del rango">
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={data.pointsByDay} margin={{ top: 5, right: 8, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="planned" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#94a3b8" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#94a3b8" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="completed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.6} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" strokeOpacity={0.4} />
                  <XAxis dataKey="date" tickFormatter={shortDate} fontSize={10} />
                  <YAxis fontSize={10} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="planned" name="Planificado" stroke="#94a3b8" fill="url(#planned)" />
                  <Area type="monotone" dataKey="completed" name="Completado" stroke="#8b5cf6" fill="url(#completed)" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* 2. Focus heatmap */}
            <ChartCard title="Mapa de calor de foco real" subtitle="Horas de foco por día (verde/rojo = mucho/poco)">
              <div className="flex items-start gap-2 overflow-x-auto py-2">
                <div className={`flex flex-col ${HEATMAP_GAP_ROW} pt-0.5`}>
                  {HEATMAP_WEEKDAY_LABELS.map((d) => (
                    <span key={d} className={HEATMAP_DAY_LABEL_CELL}>
                      {d}
                    </span>
                  ))}
                </div>
                <div className={`flex ${HEATMAP_GAP_COL}`}>
                  {focusHeatmapColumns.map((col, wi) => (
                    <div key={wi} className={`flex flex-col ${HEATMAP_GAP_ROW}`}>
                      {col.map((cell, ri) =>
                        isHeatmapPad(cell) ? (
                          <div
                            key={`${wi}-${ri}-pad`}
                            className={`${HEATMAP_CELL} shrink-0 rounded-md bg-transparent`}
                            aria-hidden
                          />
                        ) : (
                          <div
                            key={cell.date}
                            role="img"
                            aria-label={`${cell.date}: ${cell.hours} horas de foco`}
                            className={`${HEATMAP_CELL} shrink-0 cursor-default rounded-md ${HEATMAP_LEVEL_CLASS[cell.level]}`}
                            onPointerEnter={(e) => {
                              setHeatTooltip({
                                x: e.clientX,
                                y: e.clientY,
                                title: cell.date,
                                lines: focusHeatDetail(cell.level, cell.hours),
                              });
                            }}
                            onPointerMove={(e) => {
                              setHeatTooltip((prev) =>
                                prev ? { ...prev, x: e.clientX, y: e.clientY } : null,
                              );
                            }}
                            onPointerLeave={() => setHeatTooltip(null)}
                          />
                        ),
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-400">
                <span>Menos</span>
                {HEATMAP_LEVEL_CLASS.map((c, i) => (
                  <span key={i} className={`${HEATMAP_CELL} shrink-0 rounded-md ${c}`} />
                ))}
                <span>Más</span>
              </div>
            </ChartCard>

            {/* 3. Habit cross chart */}
            {data.habitCrossData && data.habitCrossData.length > 0 && (
              <ChartCard title="Horas por actividad" subtitle="Cruza hábitos y trabajo por día">
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {data.habitCrossData.map((s) => {
                    const on = activeCrossSeries.has(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setActiveCrossSeries((prev) => {
                            const next = new Set(prev);
                            if (on) next.delete(s.id);
                            else next.add(s.id);
                            return next;
                          });
                        }}
                        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all ${
                          on
                            ? "border-transparent text-white"
                            : "border-zinc-200 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
                        }`}
                        style={on ? { backgroundColor: s.color ?? "#8b5cf6" } : undefined}
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: on ? "rgba(255,255,255,0.7)" : (s.color ?? "#8b5cf6") }}
                        />
                        {s.name}
                      </button>
                    );
                  })}
                </div>
                {crossChartRows.length === 0 || activeCrossSeries.size === 0 ? (
                  <EmptyMsg text="Selecciona al menos una serie." />
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart data={crossChartRows} margin={{ top: 5, right: 8, left: -12, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" strokeOpacity={0.4} />
                      <XAxis dataKey="date" tickFormatter={shortDate} fontSize={10} />
                      <YAxis fontSize={10} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatTooltipNumber(v, "h")} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {data.habitCrossData
                        .filter((s) => activeCrossSeries.has(s.id))
                        .map((s) => (
                          <Line
                            key={s.id}
                            type="monotone"
                            dataKey={s.id}
                            name={s.name}
                            stroke={s.color ?? "#8b5cf6"}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4 }}
                          />
                        ))}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            )}

            {/* 4. Task type distribution */}
            <ChartCard title="Distribución por tipo de tarea" subtitle="Horas reales agregadas">
              {data.taskTypeDistribution.length === 0 ? (
                <EmptyMsg text="No hay bloques reales registrados." />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={data.taskTypeDistribution}
                      dataKey="hours"
                      nameKey="name"
                      innerRadius={55}
                      outerRadius={95}
                      paddingAngle={2}
                      label={({ name, percent }) =>
                        `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
                      }
                      labelLine={false}
                    >
                      {data.taskTypeDistribution.map((t, i) => (
                        <Cell
                          key={t.taskTypeId ?? `unk-${i}`}
                          fill={t.color ?? TASK_TYPE_FALLBACK_PALETTE[i % TASK_TYPE_FALLBACK_PALETTE.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatTooltipNumber(value, "h")} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            {/* 4. Habit streaks */}
            <ChartCard
              title="Rachas de hábitos"
              subtitle="Racha actual y mejor del rango"
              action={
                <button
                  type="button"
                  onClick={() => setStreakModalOpen(true)}
                  className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700/80"
                >
                  Elegir hábitos
                </button>
              }
            >
              {data.habitStreaks.length === 0 ? (
                <EmptyMsg
                  text={
                    (data.streakTracking?.total ?? 0) > 0 && (data.streakTracking?.tracked ?? 0) === 0
                      ? "Ningún hábito en seguimiento. Activa al menos uno con «Elegir hábitos»."
                      : "Completa hábitos reales para ver tus rachas."
                  }
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {data.habitStreaks.map((h) => (
                    <li
                      key={h.habitTypeId}
                      className="flex items-center justify-between rounded-lg border border-zinc-100 px-3 py-2 dark:border-zinc-800"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="h-3 w-3 rounded-full"
                          style={{ backgroundColor: h.color ?? "#8b5cf6" }}
                          aria-hidden
                        />
                        <span className="text-sm text-zinc-800 dark:text-zinc-100">{h.name}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                          Actual: {h.currentStreak}d
                        </span>
                        <span className="rounded-md bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                          Mejor: {h.bestStreak}d
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </ChartCard>

            {/* 5. Habit daily heatmap */}
            {data.habitDailyMap && data.habitDailyMap.length > 0 && (
              <ChartCard
                title="Mapa de hábitos"
                subtitle="Días realizados en el rango"
                action={
                  <select
                    value={activeHabitHeatmap ?? ""}
                    onChange={(e) => setActiveHabitHeatmap(e.target.value)}
                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 shadow-sm dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                  >
                    {data.habitDailyMap.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </select>
                }
              >
                {!habitHeatmapSeries ? (
                  <EmptyMsg text="Sin datos." />
                ) : (
                  <>
                    <div className="flex items-start gap-2 overflow-x-auto py-2">
                      <div className={`flex flex-col ${HEATMAP_GAP_ROW} pt-0.5`}>
                        {HEATMAP_WEEKDAY_LABELS.map((d) => (
                          <span key={d} className={HEATMAP_DAY_LABEL_CELL}>
                            {d}
                          </span>
                        ))}
                      </div>
                      <div className={`flex ${HEATMAP_GAP_COL}`}>
                        {habitHeatmapColumns.map((col, wi) => (
                          <div key={wi} className={`flex flex-col ${HEATMAP_GAP_ROW}`}>
                            {col.map((cell, ri) =>
                              isHeatmapPad(cell) ? (
                                <div
                                  key={`${wi}-${ri}-pad`}
                                  className={`${HEATMAP_CELL} shrink-0 rounded-md bg-transparent`}
                                  aria-hidden
                                />
                              ) : (
                                <div
                                  key={cell.date}
                                  role="img"
                                  aria-label={`${cell.date}: ${habitHeatmapSeries.name}, ${cell.done ? "hecho" : "no hecho"}`}
                                  className={`${HEATMAP_CELL} shrink-0 cursor-default rounded-md ${
                                    cell.done ? "" : "bg-zinc-100 dark:bg-zinc-800/60"
                                  }`}
                                  style={
                                    cell.done
                                      ? { backgroundColor: habitHeatmapSeries.color ?? "#8b5cf6" }
                                      : undefined
                                  }
                                  onPointerEnter={(e) => {
                                    setHeatTooltip({
                                      x: e.clientX,
                                      y: e.clientY,
                                      title: cell.date,
                                      lines: [
                                        `Hábito: ${habitHeatmapSeries.name}`,
                                        cell.done
                                          ? "Estado: hecho (hay registro ese día)"
                                          : "Estado: no hecho (sin registro)",
                                      ],
                                    });
                                  }}
                                  onPointerMove={(e) => {
                                    setHeatTooltip((prev) =>
                                      prev ? { ...prev, x: e.clientX, y: e.clientY } : null,
                                    );
                                  }}
                                  onPointerLeave={() => setHeatTooltip(null)}
                                />
                              ),
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-400">
                      <span className={`${HEATMAP_CELL} shrink-0 rounded-md bg-zinc-100 dark:bg-zinc-800/60`} />
                      <span>No hecho</span>
                      <span
                        className={`${HEATMAP_CELL} shrink-0 rounded-md`}
                        style={{ backgroundColor: habitHeatmapSeries.color ?? "#8b5cf6" }}
                      />
                      <span>Hecho</span>
                    </div>
                  </>
                )}
              </ChartCard>
            )}
          </section>
        </>
      ) : null}
      {heatTooltip && (
        <div
          className="pointer-events-none fixed z-[200] w-max max-w-[min(17rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs shadow-lg dark:border-zinc-600 dark:bg-zinc-900"
          style={{
            left: Math.max(
              8,
              Math.min(heatTooltip.x + 14, (typeof window !== "undefined" ? window.innerWidth : 400) - 200),
            ),
            top: Math.max(8, heatTooltip.y + 14),
          }}
        >
          <p className="font-semibold text-zinc-900 dark:text-zinc-50">{heatTooltip.title}</p>
          {heatTooltip.lines.map((line, i) => (
            <p key={i} className="mt-0.5 text-zinc-600 dark:text-zinc-300">
              {line}
            </p>
          ))}
        </div>
      )}
    </main>
  );
}

/* ----- small presentational helpers kept in-file ----- */

type StreakHabitDraft = {
  id: string;
  name: string;
  color: string | null;
  track_in_streaks: boolean;
};

function StreakTrackModal({
  open,
  onClose,
  onAfterSave,
}: {
  open: boolean;
  onClose: () => void;
  onAfterSave: () => void;
}) {
  const [drafts, setDrafts] = useState<StreakHabitDraft[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const baselineRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    if (!open) {
      setDrafts(null);
      setErr(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await fetch("/api/planner/habit-types");
        const json = (await res.json()) as { habitTypes?: unknown[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? "Error cargando hábitos");
        const list = (json.habitTypes ?? []) as {
          id: string;
          name: string;
          color: string | null;
          track_in_streaks?: boolean;
        }[];
        if (cancelled) return;
        const rows: StreakHabitDraft[] = list.map((h) => ({
          id: h.id,
          name: h.name,
          color: h.color,
          track_in_streaks: h.track_in_streaks !== false,
        }));
        baselineRef.current = new Map(rows.map((r) => [r.id, r.track_in_streaks]));
        setDrafts(rows);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const toggle = (id: string) => {
    setDrafts((prev) =>
      prev ? prev.map((h) => (h.id === id ? { ...h, track_in_streaks: !h.track_in_streaks } : h)) : null,
    );
  };

  const save = async () => {
    if (!drafts) return;
    setSaving(true);
    setErr(null);
    try {
      for (const h of drafts) {
        const before = baselineRef.current.get(h.id);
        if (before === h.track_in_streaks) continue;
        const res = await fetch(`/api/planner/habit-types/${encodeURIComponent(h.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ track_in_streaks: h.track_in_streaks }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(json.error ?? "No se pudo guardar");
      }
      onAfterSave();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="streak-modal-title"
        className="flex max-h-[90vh] w-full max-w-md flex-col rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <h2 id="streak-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Hábitos en rachas
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Activa los que quieras ver en esta sección.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {loading && <p className="px-2 py-4 text-center text-sm text-zinc-400">Cargando…</p>}
          {err && <p className="px-2 py-2 text-sm text-rose-600 dark:text-rose-400">{err}</p>}
          {!loading && drafts && drafts.length === 0 && (
            <p className="px-2 py-4 text-center text-sm text-zinc-400">No hay tipos de hábito.</p>
          )}
          {drafts && drafts.length > 0 && (
            <ul className="flex flex-col gap-1">
              {drafts.map((h) => (
                <li key={h.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/80">
                    <input
                      type="checkbox"
                      checked={h.track_in_streaks}
                      onChange={() => toggle(h.id)}
                      className="h-4 w-4 rounded border-zinc-300 text-violet-600 focus:ring-violet-500"
                    />
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: h.color ?? "#8b5cf6" }}
                      aria-hidden
                    />
                    <span className="text-sm text-zinc-800 dark:text-zinc-100">{h.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving || loading || !drafts}
            onClick={() => void save()}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {saving ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  valueLines,
  hint,
  active,
  onClick,
}: {
  label: string;
  value?: string;
  valueLines?: string[];
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-4 text-left shadow-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${
        active
          ? "border-violet-400 ring-2 ring-violet-500/60 dark:border-violet-700 dark:ring-violet-500/40"
          : "border-zinc-200 dark:border-zinc-800"
      } bg-white dark:bg-zinc-900`}
    >
      <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      {valueLines && valueLines.length > 0 ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {valueLines.map((line, idx) => (
            <p key={idx} className="text-xl font-semibold leading-tight text-zinc-900 dark:text-zinc-50">
              {line}
            </p>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{value ?? "—"}</p>
      )}
      <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>
    </button>
  );
}

function ChartCard({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div
        className={
          action
            ? "mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
            : "mb-3"
        }
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

function EmptyMsg({ text }: { text: string }) {
  return (
    <div className="flex h-60 items-center justify-center">
      <p className="text-xs text-zinc-400">{text}</p>
    </div>
  );
}

const tooltipStyle = {
  background: "rgba(24,24,27,0.92)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  color: "#fafafa",
  fontSize: 12,
};
