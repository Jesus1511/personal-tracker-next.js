"use client";

import { useEffect, useRef, useState } from "react";

import { localDateString } from "@/lib/planner/date";
import { isTempId, makeTempId } from "@/lib/planner/temp-id";

import { DailyCalendar } from "./daily-calendar";
import { DailyTodoList } from "./daily-todo-list";
import { PlannedTimeSummary } from "./planned-time-summary";
import { ActualHabitBlock, ActualTaskBlock, HabitType, TaskItem, TaskType, TimeBlock } from "./types";

function todayDate() {
  return localDateString();
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(json.error ?? "Request failed");
  }
  return json;
}

export function PlannerPage() {
  const [selectedDate, setSelectedDate] = useState(todayDate);
  const [taskTypes, setTaskTypes] = useState<TaskType[]>([]);
  const [habitTypes, setHabitTypes] = useState<HabitType[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [timeBlocks, setTimeBlocks] = useState<TimeBlock[]>([]);
  const [actualHabitBlocks, setActualHabitBlocks] = useState<ActualHabitBlock[]>([]);
  const [actualTaskBlocks, setActualTaskBlocks] = useState<ActualTaskBlock[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [cloningPrevDay, setCloningPrevDay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);
  const taskTypesRef = useRef(taskTypes);
  const habitTypesRef = useRef(habitTypes);
  const tasksRef = useRef(tasks);
  taskTypesRef.current = taskTypes;
  habitTypesRef.current = habitTypes;
  tasksRef.current = tasks;

  const pendingTaskCreatesRef = useRef<Map<string, Promise<TaskItem>>>(new Map());
  const abortTaskCreateRef = useRef<Map<string, AbortController>>(new Map());
  const pendingTaskTypeCreatesRef = useRef<Map<string, Promise<TaskType>>>(new Map());
  const abortTaskTypeCreateRef = useRef<Map<string, AbortController>>(new Map());
  const pendingHabitTypeCreatesRef = useRef<Map<string, Promise<HabitType>>>(new Map());
  const abortHabitTypeCreateRef = useRef<Map<string, AbortController>>(new Map());

  async function loadTaskTypes() {
    const data = await apiRequest<{ taskTypes: TaskType[] }>("/api/planner/task-types");
    setTaskTypes(data.taskTypes);
  }

  async function loadHabitTypes() {
    const data = await apiRequest<{ habitTypes: HabitType[] }>("/api/planner/habit-types");
    setHabitTypes(data.habitTypes);
  }

  async function loadDailyData() {
    const [taskData, blockData, actualData, actualTaskData] = await Promise.all([
      apiRequest<{ tasks: TaskItem[] }>(`/api/planner/tasks?date=${selectedDate}`),
      apiRequest<{ timeBlocks: TimeBlock[] }>(`/api/planner/time-blocks?date=${selectedDate}`),
      apiRequest<{ actualHabitBlocks: ActualHabitBlock[] }>(`/api/planner/actual-habits?date=${selectedDate}`),
      apiRequest<{ actualTaskBlocks: ActualTaskBlock[] }>(`/api/planner/actual-tasks?date=${selectedDate}`),
    ]);
    setTasks(taskData.tasks);
    setTimeBlocks(blockData.timeBlocks);
    setActualHabitBlocks(actualData.actualHabitBlocks);
    setActualTaskBlocks(actualTaskData.actualTaskBlocks);
  }

  async function refreshAll() {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadTaskTypes(), loadHabitTypes(), loadDailyData()]);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load planner");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll().then(async () => {
      void syncActualTasks(selectedDate);
      // Rollover: si el día seleccionado es "hoy", movemos tareas pendientes de días anteriores.
      // Idempotente en servidor (no duplica hijas), así que es seguro llamarlo en cada montaje.
      if (selectedDate === todayDate()) {
        try {
          const res = await apiRequest<{ createdCount: number }>("/api/planner/tasks/rollover", {
            method: "POST",
            body: JSON.stringify({ date: selectedDate }),
          });
          if (res.createdCount > 0) {
            await loadDailyData();
          }
        } catch (rolloverError) {
          console.error("Rollover failed:", rolloverError);
        }
      }
    });
    return () => syncAbortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  async function resolveTaskId(id: string): Promise<string> {
    const inflight = pendingTaskCreatesRef.current.get(id);
    if (inflight) {
      const created = await inflight;
      return created.id;
    }
    return id;
  }

  async function resolveTaskTypeId(id: string): Promise<string> {
    const inflight = pendingTaskTypeCreatesRef.current.get(id);
    if (inflight) return (await inflight).id;
    return id;
  }

  async function resolveHabitTypeId(id: string): Promise<string> {
    const inflight = pendingHabitTypeCreatesRef.current.get(id);
    if (inflight) return (await inflight).id;
    return id;
  }

  async function syncActualTasks(date: string) {
    syncAbortRef.current?.abort();
    const ac = new AbortController();
    syncAbortRef.current = ac;
    setSyncing(true);
    try {
      const data = await apiRequest<{ actualTaskBlocks: ActualTaskBlock[] }>(
        "/api/planner/actual-tasks/sync",
        {
          method: "POST",
          body: JSON.stringify({ date }),
          signal: ac.signal,
        },
      );
      if (!ac.signal.aborted) {
        setActualTaskBlocks(data.actualTaskBlocks);
      }
    } catch (syncError) {
      if (!isAbortError(syncError)) {
        console.error("Actual task sync failed:", syncError);
      }
    } finally {
      if (!ac.signal.aborted) setSyncing(false);
    }
  }

  async function clonePreviousDay() {
    const prevDate = (() => {
      const d = new Date(selectedDate + "T00:00:00");
      d.setDate(d.getDate() - 1);
      return d.toISOString().slice(0, 10);
    })();

    setCloningPrevDay(true);
    try {
      const { timeBlocks: prevBlocks } = await apiRequest<{ timeBlocks: TimeBlock[] }>(
        `/api/planner/time-blocks?date=${prevDate}`,
      );
      if (prevBlocks.length === 0) return;

      const extractLocalTime = (iso: string) => {
        const d = new Date(iso);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      };

      await Promise.allSettled(
        prevBlocks.map((block) => {
          const startAt = new Date(`${selectedDate}T${extractLocalTime(block.start_at)}:00`).toISOString();
          const endAt = new Date(`${selectedDate}T${extractLocalTime(block.end_at)}:00`).toISOString();
          return apiRequest("/api/planner/time-blocks", {
            method: "POST",
            body: JSON.stringify({
              scheduledDate: selectedDate,
              startAt,
              endAt,
              entryType: block.entry_type,
              taskId: null,
              habitTypeId: block.entry_type === "habit" ? block.habit_type_id : null,
            }),
          });
        }),
      );

      await loadDailyData();
    } catch (cloneError) {
      setError(cloneError instanceof Error ? cloneError.message : "No se pudo clonar el día anterior");
    } finally {
      setCloningPrevDay(false);
    }
  }

  return (
    <main className="flex w-full flex-col gap-5 px-40 py-5 sm:px-6">
      <header className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-20 py-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Planner diario</h1>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            Tareas, hábitos y bloques de tiempo.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const d = new Date(selectedDate + "T00:00:00");
              d.setDate(d.getDate() - 1);
              setSelectedDate(d.toISOString().slice(0, 10));
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-100"
            aria-label="Día anterior"
          >
            ‹
          </button>
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => setSelectedDate(event.target.value)}
            className="h-9 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-600"
          />
          <button
            type="button"
            onClick={() => {
              const d = new Date(selectedDate + "T00:00:00");
              d.setDate(d.getDate() + 1);
              setSelectedDate(d.toISOString().slice(0, 10));
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:text-zinc-100"
            aria-label="Día siguiente"
          >
            ›
          </button>
        </div>
      </header>

      {error ? (
        <div className="shrink-0 rounded-lg border border-rose-200 bg-rose-50/80 px-4 py-2.5 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-zinc-400 dark:text-zinc-500">Cargando planner...</p>
        </div>
      ) : (
        <>
          <PlannedTimeSummary timeBlocks={timeBlocks} />

          {timeBlocks.length === 0 ? (
            <div className="flex items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-200 bg-zinc-50/60 py-4 dark:border-zinc-700 dark:bg-zinc-900/30">
              <p className="text-sm text-zinc-400 dark:text-zinc-500">Sin bloques planificados</p>
              <button
                type="button"
                disabled={cloningPrevDay}
                onClick={() => void clonePreviousDay()}
                className="flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 shadow-sm transition-colors hover:bg-violet-100 disabled:opacity-50 dark:border-violet-800 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50"
              >
                {cloningPrevDay ? "Clonando…" : "↩ Clonar día anterior"}
              </button>
            </div>
          ) : null}

          <section className="flex gap-5 justify-center">
          <DailyCalendar
            selectedDate={selectedDate}
            tasks={tasks}
            habits={habitTypes}
            timeBlocks={timeBlocks}
            onCreateBlock={async (input) => {
              const tempId = makeTempId();
              const task =
                input.entryType === "task" && input.taskId
                  ? tasksRef.current.find((t) => t.id === input.taskId) ?? null
                  : null;
              const habit =
                input.entryType === "habit" && input.habitTypeId
                  ? habitTypesRef.current.find((h) => h.id === input.habitTypeId) ?? null
                  : null;
              const optimistic: TimeBlock = {
                id: tempId,
                scheduled_date: selectedDate,
                start_at: input.startAt,
                end_at: input.endAt,
                entry_type: input.entryType,
                notes: null,
                task_id: input.taskId,
                habit_type_id: input.habitTypeId,
                task,
                habit_type: habit,
              };
              setTimeBlocks((prev) =>
                [...prev, optimistic].sort(
                  (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
                ),
              );
              setError(null);
              try {
                const data = await apiRequest<{ timeBlock: TimeBlock }>("/api/planner/time-blocks", {
                  method: "POST",
                  body: JSON.stringify({
                    scheduledDate: selectedDate,
                    ...input,
                  }),
                });
                setTimeBlocks((prev) => prev.map((b) => (b.id === tempId ? data.timeBlock : b)));
              } catch (requestError) {
                setTimeBlocks((prev) => prev.filter((b) => b.id !== tempId));
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onPatchBlock={async (id, patch) => {
              let snapshot: TimeBlock | undefined;
              setTimeBlocks((prev) => {
                snapshot = prev.find((b) => b.id === id);
                const next = prev.map((b) => {
                  if (b.id !== id) return b;
                  const updated = { ...b };
                  if (patch.startAt) updated.start_at = patch.startAt;
                  if (patch.endAt) updated.end_at = patch.endAt;
                  if ("taskId" in patch) {
                    updated.task_id = patch.taskId ?? null;
                    updated.task = patch.taskId
                      ? tasksRef.current.find((t) => t.id === patch.taskId) ?? null
                      : null;
                  }
                  if ("habitTypeId" in patch) {
                    updated.habit_type_id = patch.habitTypeId ?? null;
                    updated.habit_type = patch.habitTypeId
                      ? habitTypesRef.current.find((h) => h.id === patch.habitTypeId) ?? null
                      : null;
                  }
                  return updated;
                });
                return next.sort(
                  (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
                );
              });
              if (isTempId(id)) return;
              setError(null);
              try {
                const body: Record<string, unknown> = { scheduledDate: selectedDate };
                if (patch.startAt) body.startAt = patch.startAt;
                if (patch.endAt) body.endAt = patch.endAt;
                if ("taskId" in patch) body.taskId = patch.taskId;
                if ("habitTypeId" in patch) body.habitTypeId = patch.habitTypeId;
                const data = await apiRequest<{ timeBlock: TimeBlock }>(
                  `/api/planner/time-blocks/${id}`,
                  {
                    method: "PATCH",
                    body: JSON.stringify(body),
                  },
                );
                setTimeBlocks((prev) => {
                  const next = prev.map((b) => (b.id === id ? data.timeBlock : b));
                  return next.sort(
                    (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
                  );
                });
              } catch (requestError) {
                if (snapshot) {
                  setTimeBlocks((prev) => {
                    const next = prev.map((b) => (b.id === id ? snapshot! : b));
                    return next.sort(
                      (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
                    );
                  });
                }
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onDeleteBlock={async (id) => {
              let removed: TimeBlock | undefined;
              setTimeBlocks((prev) => {
                removed = prev.find((b) => b.id === id);
                return prev.filter((b) => b.id !== id);
              });
              if (isTempId(id)) return;
              setError(null);
              try {
                await apiRequest<{ ok: boolean }>(`/api/planner/time-blocks/${id}`, {
                  method: "DELETE",
                });
              } catch (requestError) {
                const r = removed;
                if (r) setTimeBlocks((prev) => [...prev, r]);
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onCreateHabitType={async ({ name, color }) => {
              const tempId = makeTempId();
              const ac = new AbortController();
              abortHabitTypeCreateRef.current.set(tempId, ac);
              setHabitTypes((prev) => [...prev, { id: tempId, name, color }]);
              setError(null);
              const promise = (async () => {
                try {
                  const data = await apiRequest<{ habitType: HabitType }>("/api/planner/habit-types", {
                    method: "POST",
                    body: JSON.stringify({ name, color }),
                    signal: ac.signal,
                  });
                  setHabitTypes((prev) => prev.map((h) => (h.id === tempId ? data.habitType : h)));
                  setError(null);
                  return data.habitType;
                } catch (requestError) {
                  if (isAbortError(requestError)) throw requestError;
                  setHabitTypes((prev) => prev.filter((h) => h.id !== tempId));
                  setError(requestError instanceof Error ? requestError.message : "Action failed");
                  throw requestError;
                } finally {
                  abortHabitTypeCreateRef.current.delete(tempId);
                  pendingHabitTypeCreatesRef.current.delete(tempId);
                }
              })();
              pendingHabitTypeCreatesRef.current.set(tempId, promise);
            }}
            onPatchHabitType={async (id, input) => {
              const hasName = "name" in input && input.name !== undefined;
              const hasColor = "color" in input;
              if (!hasName && !hasColor) return;

              let targetId = id;
              try {
                targetId = await resolveHabitTypeId(id);
              } catch {
                return;
              }
              let snapshot: HabitType | undefined;
              setHabitTypes((prev) => {
                snapshot = prev.find((h) => h.id === id || h.id === targetId);
                return prev.map((h) => {
                  if (h.id !== id && h.id !== targetId) return h;
                  return {
                    ...h,
                    ...(hasName ? { name: input.name! } : {}),
                    ...(hasColor ? { color: input.color ?? null } : {}),
                  };
                });
              });
              if (isTempId(targetId)) return;
              setError(null);
              try {
                const body: { name?: string; color?: string | null } = {};
                if (hasName) body.name = input.name!;
                if (hasColor) body.color = input.color ?? null;
                const data = await apiRequest<{ habitType: HabitType }>(
                  `/api/planner/habit-types/${targetId}`,
                  {
                    method: "PATCH",
                    body: JSON.stringify(body),
                  },
                );
                setHabitTypes((prev) =>
                  prev.map((h) =>
                    h.id === targetId || h.id === id ? data.habitType : h,
                  ),
                );
                void loadDailyData();
              } catch (requestError) {
                if (snapshot) {
                  setHabitTypes((prev) =>
                    prev.map((h) => (h.id === snapshot!.id ? snapshot! : h)),
                  );
                }
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onDeleteHabitType={async (id) => {
              const ac = abortHabitTypeCreateRef.current.get(id);
              if (ac) ac.abort();
              let removed: HabitType | undefined;
              setHabitTypes((prev) => {
                removed = prev.find((h) => h.id === id);
                return prev.filter((h) => h.id !== id);
              });
              if (isTempId(id)) {
                pendingHabitTypeCreatesRef.current.delete(id);
                return;
              }
              setError(null);
              try {
                await apiRequest<{ ok: boolean }>(`/api/planner/habit-types/${id}`, {
                  method: "DELETE",
                });
                void loadDailyData();
              } catch (requestError) {
                const r = removed;
                if (r) setHabitTypes((prev) => [...prev, r]);
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            actualHabitBlocks={actualHabitBlocks}
            onCreateActualHabit={async (input) => {
              const tempId = makeTempId();
              const habit =
                habitTypesRef.current.find((h) => h.id === input.habitTypeId) ?? null;
              const optimistic: ActualHabitBlock = {
                id: tempId,
                scheduled_date: selectedDate,
                start_at: input.startAt,
                end_at: input.endAt,
                habit_type_id: input.habitTypeId,
                description: input.description,
                planned_block_id: input.plannedBlockId ?? null,
                habit_type: habit,
              };
              setActualHabitBlocks((prev) =>
                [...prev, optimistic].sort(
                  (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
                ),
              );
              setError(null);
              try {
                const data = await apiRequest<{ actualHabitBlock: ActualHabitBlock }>(
                  "/api/planner/actual-habits",
                  {
                    method: "POST",
                    body: JSON.stringify({
                      scheduledDate: selectedDate,
                      ...input,
                    }),
                  },
                );
                setActualHabitBlocks((prev) =>
                  prev.map((b) => (b.id === tempId ? data.actualHabitBlock : b)),
                );
              } catch (requestError) {
                setActualHabitBlocks((prev) => prev.filter((b) => b.id !== tempId));
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onPatchActualHabit={async (id, patch) => {
              let snapshot: ActualHabitBlock | undefined;
              setActualHabitBlocks((prev) => {
                snapshot = prev.find((b) => b.id === id);
                const next = prev.map((b) => {
                  if (b.id !== id) return b;
                  const updated = { ...b };
                  if (patch.startAt) updated.start_at = patch.startAt;
                  if (patch.endAt) updated.end_at = patch.endAt;
                  if ("description" in patch && patch.description !== undefined) updated.description = patch.description;
                  return updated;
                });
                return next.sort(
                  (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
                );
              });
              if (isTempId(id)) return;
              setError(null);
              try {
                const body: Record<string, unknown> = { scheduledDate: selectedDate };
                if (patch.startAt) body.startAt = patch.startAt;
                if (patch.endAt) body.endAt = patch.endAt;
                if ("description" in patch) body.description = patch.description;
                const data = await apiRequest<{ actualHabitBlock: ActualHabitBlock }>(
                  `/api/planner/actual-habits/${id}`,
                  {
                    method: "PATCH",
                    body: JSON.stringify(body),
                  },
                );
                setActualHabitBlocks((prev) => {
                  const next = prev.map((b) => (b.id === id ? data.actualHabitBlock : b));
                  return next.sort(
                    (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
                  );
                });
              } catch (requestError) {
                if (snapshot) {
                  setActualHabitBlocks((prev) => {
                    const next = prev.map((b) => (b.id === id ? snapshot! : b));
                    return next.sort(
                      (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
                    );
                  });
                }
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onDeleteActualHabit={async (id) => {
              let removed: ActualHabitBlock | undefined;
              setActualHabitBlocks((prev) => {
                removed = prev.find((b) => b.id === id);
                return prev.filter((b) => b.id !== id);
              });
              if (isTempId(id)) return;
              setError(null);
              try {
                await apiRequest<{ ok: boolean }>(`/api/planner/actual-habits/${id}`, {
                  method: "DELETE",
                });
              } catch (requestError) {
                const r = removed;
                if (r) setActualHabitBlocks((prev) => [...prev, r]);
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            actualTaskBlocks={actualTaskBlocks}
            syncingActualTasks={syncing}
            onDeleteActualTask={async (id) => {
              let removed: ActualTaskBlock | undefined;
              setActualTaskBlocks((prev) => {
                removed = prev.find((b) => b.id === id);
                return prev.filter((b) => b.id !== id);
              });
              setError(null);
              try {
                await apiRequest<{ ok: boolean }>(`/api/planner/actual-tasks/${id}`, {
                  method: "DELETE",
                });
              } catch (requestError) {
                const r = removed;
                if (r) setActualTaskBlocks((prev) => [...prev, r]);
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onSyncActualTasks={() => syncActualTasks(selectedDate)}
          />

          <DailyTodoList
            selectedDate={selectedDate}
            tasks={tasks}
            taskTypes={taskTypes}
            onCreateTask={async ({ title, taskTypeId, afterTaskId }) => {
              const tempId = makeTempId();
              const ac = new AbortController();
              abortTaskCreateRef.current.set(tempId, ac);
              const tt = taskTypeId
                ? taskTypesRef.current.find((t) => t.id === taskTypeId) ?? null
                : null;
              const maxSort = tasksRef.current.reduce(
                (m, t) => Math.max(m, t.sort_order ?? 0),
                0,
              );
              const optimistic: TaskItem = {
                id: tempId,
                title,
                notes: null,
                done: false,
                points: 0,
                sort_order: maxSort + 1,
                scheduled_date: selectedDate,
                task_type_id: taskTypeId,
                task_type: tt,
              };
              setTasks((prev) => {
                if (afterTaskId) {
                  const idx = prev.findIndex((t) => t.id === afterTaskId);
                  if (idx !== -1) {
                    const next = [...prev];
                    next.splice(idx + 1, 0, optimistic);
                    return next;
                  }
                }
                return [...prev, optimistic];
              });
              setError(null);

              const promise = (async () => {
                try {
                  const data = await apiRequest<{ task: TaskItem }>("/api/planner/tasks", {
                    method: "POST",
                    body: JSON.stringify({
                      title,
                      taskTypeId,
                      scheduledDate: selectedDate,
                    }),
                    signal: ac.signal,
                  });
                  setTasks((prev) => prev.map((t) => (t.id === tempId ? data.task : t)));
                  setError(null);
                  return data.task;
                } catch (requestError) {
                  if (isAbortError(requestError)) throw requestError;
                  setTasks((prev) => prev.filter((t) => t.id !== tempId));
                  setError(
                    requestError instanceof Error ? requestError.message : "Action failed",
                  );
                  throw requestError;
                } finally {
                  abortTaskCreateRef.current.delete(tempId);
                  pendingTaskCreatesRef.current.delete(tempId);
                }
              })();

              pendingTaskCreatesRef.current.set(tempId, promise);
              return optimistic;
            }}
            onUpdateTask={async (id, { title }) => {
              let targetId = id;
              try {
                targetId = await resolveTaskId(id);
              } catch {
                return;
              }
              let snapshot: TaskItem | undefined;
              setTasks((prev) => {
                snapshot = prev.find((t) => t.id === targetId);
                return prev.map((t) => (t.id === targetId ? { ...t, title } : t));
              });
              if (isTempId(targetId)) return;
              setError(null);
              try {
                const data = await apiRequest<{ task: TaskItem }>(`/api/planner/tasks/${targetId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ title }),
                });
                setTasks((prev) => prev.map((t) => (t.id === targetId ? data.task : t)));
              } catch (requestError) {
                if (snapshot) {
                  setTasks((prev) => prev.map((t) => (t.id === targetId ? snapshot! : t)));
                }
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onChangeTaskPoints={async (id, points) => {
              let targetId = id;
              try {
                targetId = await resolveTaskId(id);
              } catch {
                return;
              }
              let snapshot: TaskItem | undefined;
              setTasks((prev) => {
                snapshot = prev.find((t) => t.id === targetId);
                return prev.map((t) => (t.id === targetId ? { ...t, points } : t));
              });
              if (isTempId(targetId)) return;
              setError(null);
              try {
                const data = await apiRequest<{ task: TaskItem }>(`/api/planner/tasks/${targetId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ points }),
                });
                setTasks((prev) => prev.map((t) => (t.id === targetId ? data.task : t)));
              } catch (requestError) {
                if (snapshot) {
                  setTasks((prev) => prev.map((t) => (t.id === targetId ? snapshot! : t)));
                }
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onChangeTaskType={async (id, taskTypeId) => {
              let targetId = id;
              try {
                targetId = await resolveTaskId(id);
              } catch {
                return;
              }
              const newType = taskTypeId
                ? (taskTypesRef.current.find((t) => t.id === taskTypeId) ?? null)
                : null;
              let snapshot: TaskItem | undefined;
              setTasks((prev) => {
                snapshot = prev.find((t) => t.id === targetId);
                return prev.map((t) =>
                  t.id === targetId ? { ...t, task_type_id: taskTypeId, task_type: newType } : t,
                );
              });
              if (isTempId(targetId)) return;
              setError(null);
              try {
                const data = await apiRequest<{ task: TaskItem }>(`/api/planner/tasks/${targetId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ taskTypeId }),
                });
                setTasks((prev) => prev.map((t) => (t.id === targetId ? data.task : t)));
              } catch (requestError) {
                if (snapshot) {
                  setTasks((prev) => prev.map((t) => (t.id === targetId ? snapshot! : t)));
                }
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onToggleTask={async (task) => {
              let targetId = task.id;
              try {
                targetId = await resolveTaskId(task.id);
              } catch {
                return;
              }
              const nextDone = !task.done;
              let snapshot: TaskItem | undefined;
              setTasks((prev) => {
                snapshot = prev.find((t) => t.id === targetId);
                return prev.map((t) => (t.id === targetId ? { ...t, done: nextDone } : t));
              });
              if (isTempId(targetId)) return;
              setError(null);
              try {
                const data = await apiRequest<{ task: TaskItem }>(`/api/planner/tasks/${targetId}`, {
                  method: "PATCH",
                  body: JSON.stringify({ done: nextDone }),
                });
                setTasks((prev) => prev.map((t) => (t.id === targetId ? data.task : t)));
              } catch (requestError) {
                if (snapshot) {
                  setTasks((prev) => prev.map((t) => (t.id === targetId ? snapshot! : t)));
                }
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onCompleteTaskWithFocus={async (task, rizeEntryId, pointsCompleted) => {
              let targetId = task.id;
              try {
                targetId = await resolveTaskId(task.id);
              } catch {
                return;
              }
              if (isTempId(targetId)) return;
              // Optimismo: sumo puntos localmente; done=true solo si alcanzo el total.
              const total = Math.max(0, task.points ?? 0);
              const prevDone = Math.min(total, task.points_done ?? 0);
              const nextDone = Math.min(total, prevDone + Math.max(0, pointsCompleted));
              const shouldBeDone = total === 0 || nextDone >= total;
              let snapshot: TaskItem | undefined;
              setTasks((prev) => {
                snapshot = prev.find((t) => t.id === targetId);
                return prev.map((t) =>
                  t.id === targetId
                    ? { ...t, done: shouldBeDone, points_done: nextDone }
                    : t,
                );
              });
              setError(null);
              try {
                const data = await apiRequest<{
                  task: TaskItem;
                  actualTaskBlock: ActualTaskBlock;
                }>(`/api/planner/tasks/${targetId}/complete-with-focus`, {
                  method: "POST",
                  body: JSON.stringify({
                    rizeEntryId,
                    scheduledDate: selectedDate,
                    pointsCompleted,
                  }),
                });
                setTasks((prev) => prev.map((t) => (t.id === targetId ? data.task : t)));
                setActualTaskBlocks((prev) => {
                  const rest = prev.filter(
                    (b) =>
                      b.rize_entry_id === null ||
                      b.rize_entry_id !== data.actualTaskBlock.rize_entry_id,
                  );
                  return [...rest, data.actualTaskBlock].sort(
                    (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
                  );
                });
              } catch (requestError) {
                if (snapshot) {
                  setTasks((prev) => prev.map((t) => (t.id === targetId ? snapshot! : t)));
                }
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onCompleteTaskPartial={async (task, pointsCompleted) => {
              let targetId = task.id;
              try {
                targetId = await resolveTaskId(task.id);
              } catch {
                return;
              }
              if (isTempId(targetId)) return;
              const total = Math.max(0, task.points ?? 0);
              const prevDone = Math.min(total, task.points_done ?? 0);
              const nextDone = Math.min(total, prevDone + Math.max(0, pointsCompleted));
              const shouldBeDone = total === 0 || nextDone >= total;
              let snapshot: TaskItem | undefined;
              setTasks((prev) => {
                snapshot = prev.find((t) => t.id === targetId);
                return prev.map((t) =>
                  t.id === targetId
                    ? { ...t, done: shouldBeDone, points_done: nextDone }
                    : t,
                );
              });
              setError(null);
              try {
                const data = await apiRequest<{
                  task: TaskItem;
                  actualTaskBlock: ActualTaskBlock;
                }>(`/api/planner/tasks/${targetId}/progress`, {
                  method: "POST",
                  body: JSON.stringify({
                    pointsCompleted,
                    scheduledDate: selectedDate,
                  }),
                });
                setTasks((prev) => prev.map((t) => (t.id === targetId ? data.task : t)));
                setActualTaskBlocks((prev) => {
                  const next = [...prev, data.actualTaskBlock];
                  return next.sort(
                    (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
                  );
                });
              } catch (requestError) {
                if (snapshot) {
                  setTasks((prev) => prev.map((t) => (t.id === targetId ? snapshot! : t)));
                }
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onDeleteTask={async (id) => {
              const ac = abortTaskCreateRef.current.get(id);
              if (ac) ac.abort();
              let removed: TaskItem | undefined;
              setTasks((prev) => {
                removed = prev.find((t) => t.id === id);
                return prev.filter((t) => t.id !== id);
              });
              if (isTempId(id)) {
                pendingTaskCreatesRef.current.delete(id);
                return;
              }
              setError(null);
              try {
                await apiRequest<{ ok: boolean }>(`/api/planner/tasks/${id}`, { method: "DELETE" });
              } catch (requestError) {
                const r = removed;
                if (r) setTasks((prev) => [...prev, r]);
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onReorderTasks={async (orderedIds) => {
              const snapshot = [...tasks];
              setTasks((prev) => {
                const byId = new Map(prev.map((t) => [t.id, t]));
                const reordered: TaskItem[] = [];
                for (const id of orderedIds) {
                  const t = byId.get(id);
                  if (t) reordered.push({ ...t, sort_order: reordered.length + 1 });
                }
                for (const t of prev) {
                  if (!orderedIds.includes(t.id)) reordered.push(t);
                }
                return reordered;
              });
              setError(null);
              try {
                await apiRequest<{ ok: boolean }>("/api/planner/tasks/reorder", {
                  method: "PATCH",
                  body: JSON.stringify({ orderedIds }),
                });
              } catch (requestError) {
                setTasks(snapshot);
                setError(requestError instanceof Error ? requestError.message : "Reorder failed");
              }
            }}
            onCreateTaskType={async ({ name, color }) => {
              const tempId = makeTempId();
              const ac = new AbortController();
              abortTaskTypeCreateRef.current.set(tempId, ac);
              setTaskTypes((prev) => [...prev, { id: tempId, name, color }]);
              setError(null);
              const promise = (async () => {
                try {
                  const data = await apiRequest<{ taskType: TaskType }>("/api/planner/task-types", {
                    method: "POST",
                    body: JSON.stringify({ name, color }),
                    signal: ac.signal,
                  });
                  setTaskTypes((prev) => prev.map((t) => (t.id === tempId ? data.taskType : t)));
                  setError(null);
                  return data.taskType;
                } catch (requestError) {
                  if (isAbortError(requestError)) throw requestError;
                  setTaskTypes((prev) => prev.filter((t) => t.id !== tempId));
                  setError(requestError instanceof Error ? requestError.message : "Action failed");
                  throw requestError;
                } finally {
                  abortTaskTypeCreateRef.current.delete(tempId);
                  pendingTaskTypeCreatesRef.current.delete(tempId);
                }
              })();
              pendingTaskTypeCreatesRef.current.set(tempId, promise);
            }}
            onPatchTaskType={async (id, input) => {
              const hasName = "name" in input && input.name !== undefined;
              const hasColor = "color" in input;
              if (!hasName && !hasColor) return;

              let targetId = id;
              try {
                targetId = await resolveTaskTypeId(id);
              } catch {
                return;
              }
              let snapshot: TaskType | undefined;
              setTaskTypes((prev) => {
                snapshot = prev.find((t) => t.id === id || t.id === targetId);
                return prev.map((t) => {
                  if (t.id !== id && t.id !== targetId) return t;
                  return {
                    ...t,
                    ...(hasName ? { name: input.name! } : {}),
                    ...(hasColor ? { color: input.color ?? null } : {}),
                  };
                });
              });
              if (isTempId(targetId)) return;
              setError(null);
              try {
                const body: { name?: string; color?: string | null } = {};
                if (hasName) body.name = input.name!;
                if (hasColor) body.color = input.color ?? null;
                const data = await apiRequest<{ taskType: TaskType }>(
                  `/api/planner/task-types/${targetId}`,
                  {
                    method: "PATCH",
                    body: JSON.stringify(body),
                  },
                );
                setTaskTypes((prev) =>
                  prev.map((t) =>
                    t.id === targetId || t.id === id ? data.taskType : t,
                  ),
                );
                void loadDailyData();
              } catch (requestError) {
                if (snapshot) {
                  setTaskTypes((prev) =>
                    prev.map((t) => (t.id === snapshot!.id ? snapshot! : t)),
                  );
                }
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
            onDeleteTaskType={async (id) => {
              const ac = abortTaskTypeCreateRef.current.get(id);
              if (ac) ac.abort();
              let removed: TaskType | undefined;
              setTaskTypes((prev) => {
                removed = prev.find((t) => t.id === id);
                return prev.filter((t) => t.id !== id);
              });
              if (isTempId(id)) {
                pendingTaskTypeCreatesRef.current.delete(id);
                return;
              }
              setError(null);
              try {
                await apiRequest<{ ok: boolean }>(`/api/planner/task-types/${id}`, {
                  method: "DELETE",
                });
                void loadDailyData();
              } catch (requestError) {
                const r = removed;
                if (r) setTaskTypes((prev) => [...prev, r]);
                setError(requestError instanceof Error ? requestError.message : "Action failed");
              }
            }}
          />
        </section>
        </>
      )}
    </main>
  );
}
