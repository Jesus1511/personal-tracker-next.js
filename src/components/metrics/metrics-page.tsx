"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { localDateString } from "@/lib/planner/date";

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
};

type RangePreset = 7 | 30 | 90;

function rangeFromPreset(days: RangePreset) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  return { start: localDateString(start), end: localDateString(end) };
}

/** Short MM-DD label for axis ticks so strings don't overlap. */
function shortDate(iso: string) {
  return iso.slice(5); // "MM-DD"
}

const HEATMAP_LEVEL_CLASS = [
  "bg-zinc-100 dark:bg-zinc-800/60",
  "bg-red-200 dark:bg-red-900/40",
  "bg-amber-200 dark:bg-amber-900/50",
  "bg-emerald-300 dark:bg-emerald-800/60",
  "bg-emerald-500 dark:bg-emerald-500",
];

const TASK_TYPE_FALLBACK_PALETTE = [
  "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#3b82f6", "#ec4899", "#14b8a6",
];

export function MetricsPage() {
  const [preset, setPreset] = useState<RangePreset>(30);
  const [data, setData] = useState<MetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (days: RangePreset) => {
    setLoading(true);
    setError(null);
    try {
      const { start, end } = rangeFromPreset(days);
      const res = await fetch(`/api/planner/metrics?start=${start}&end=${end}`);
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
    void load(preset);
  }, [preset, load]);

  /* ------------- derived KPI summary tiles ------------- */
  const summary = useMemo(() => {
    if (!data) return null;
    const totalPlanned = data.pointsByDay.reduce((s, d) => s + d.planned, 0);
    const totalCompleted = data.pointsByDay.reduce((s, d) => s + d.completed, 0);
    const totalPlannedHrs = data.hoursByDay.reduce((s, d) => s + d.plannedHours, 0);
    const totalActualHrs = data.hoursByDay.reduce((s, d) => s + d.actualHours, 0);
    const completionPct = totalPlanned > 0 ? Math.round((totalCompleted / totalPlanned) * 100) : null;
    const focusEfficiency = totalPlannedHrs > 0 ? Math.round((totalActualHrs / totalPlannedHrs) * 100) : null;
    return {
      totalCompleted,
      totalPlanned,
      completionPct,
      totalActualHrs: +totalActualHrs.toFixed(1),
      totalPlannedHrs: +totalPlannedHrs.toFixed(1),
      focusEfficiency,
    };
  }, [data]);

  const heatmapWeeks = useMemo(() => {
    if (!data) return [] as { date: string; hours: number; level: number }[][];
    // Group days into columns of 7 (weeks), starting from the earliest day.
    const items = data.focusHeatmap;
    const weeks: { date: string; hours: number; level: number }[][] = [];
    for (let i = 0; i < items.length; i += 7) weeks.push(items.slice(i, i + 7));
    return weeks;
  }, [data]);

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

        <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
          {([7, 30, 90] as RangePreset[]).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setPreset(d)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                preset === d
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </header>

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
              <SummaryTile
                label="Puntos completados"
                value={`${summary.totalCompleted} / ${summary.totalPlanned}`}
                hint={summary.completionPct !== null ? `${summary.completionPct}% cumplimiento` : "Sin planificación"}
              />
              <SummaryTile
                label="Horas de foco real"
                value={`${summary.totalActualHrs}h`}
                hint={`vs ${summary.totalPlannedHrs}h planificadas`}
              />
              <SummaryTile
                label="Eficiencia de foco"
                value={summary.focusEfficiency !== null ? `${summary.focusEfficiency}%` : "—"}
                hint="Horas reales / planificadas"
              />
              <SummaryTile
                label="Hábitos activos"
                value={`${data.habitStreaks.length}`}
                hint={`Mejor racha: ${Math.max(0, ...data.habitStreaks.map((h) => h.bestStreak))}d`}
              />
            </section>
          )}

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

            {/* 2. Habit adherence */}
            <ChartCard title="Adherencia de hábitos" subtitle="% actual vs planificado por tipo">
              {data.habitAdherence.length === 0 ? (
                <EmptyMsg text="No hay hábitos planificados ni realizados en este rango." />
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(240, data.habitAdherence.length * 36)}>
                  <BarChart
                    data={data.habitAdherence.map((h) => ({ ...h, adherence: h.adherencePct ?? 0 }))}
                    layout="vertical"
                    margin={{ top: 5, right: 8, left: 16, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" strokeOpacity={0.4} horizontal={false} />
                    <XAxis type="number" domain={[0, 100]} fontSize={10} />
                    <YAxis type="category" dataKey="name" width={110} fontSize={11} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${v}%`} />
                    <Bar dataKey="adherence" name="Adherencia" radius={[0, 4, 4, 0]}>
                      {data.habitAdherence.map((h, i) => (
                        <Cell key={h.habitTypeId} fill={h.color ?? TASK_TYPE_FALLBACK_PALETTE[i % TASK_TYPE_FALLBACK_PALETTE.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            {/* 3. Focus heatmap */}
            <ChartCard title="Mapa de calor de foco real" subtitle="Horas de foco por día (verde/rojo = mucho/poco)">
              <div className="flex items-start gap-2 overflow-x-auto py-2">
                <div className="flex flex-col gap-1 pt-[10px] text-[9px] text-zinc-400">
                  <span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span>
                </div>
                <div className="flex gap-1">
                  {heatmapWeeks.map((week, wi) => (
                    <div key={wi} className="flex flex-col gap-1">
                      {week.map((day) => (
                        <div
                          key={day.date}
                          title={`${day.date}: ${day.hours}h`}
                          className={`h-3 w-3 rounded-sm ${HEATMAP_LEVEL_CLASS[day.level]}`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-2 flex items-center gap-2 text-[10px] text-zinc-400">
                <span>Menos</span>
                {HEATMAP_LEVEL_CLASS.map((c, i) => (
                  <span key={i} className={`h-3 w-3 rounded-sm ${c}`} />
                ))}
                <span>Más</span>
              </div>
            </ChartCard>

            {/* 4. Planned vs actual hours */}
            <ChartCard title="Horas planificadas vs reales" subtitle="Bloques de tarea cada día">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.hoursByDay} margin={{ top: 5, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" strokeOpacity={0.4} />
                  <XAxis dataKey="date" tickFormatter={shortDate} fontSize={10} />
                  <YAxis fontSize={10} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${v}h`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="plannedHours" name="Planificado" fill="#94a3b8" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="actualHours" name="Real" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* 5. Task type distribution */}
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
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${v}h`} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            {/* 6. Habit streaks */}
            <ChartCard title="Rachas de hábitos" subtitle="Racha actual y mejor del rango">
              {data.habitStreaks.length === 0 ? (
                <EmptyMsg text="Completa hábitos reales para ver tus rachas." />
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
          </section>
        </>
      ) : null}
    </main>
  );
}

/* ----- small presentational helpers kept in-file ----- */

function SummaryTile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{value}</p>
      <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h3>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
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
