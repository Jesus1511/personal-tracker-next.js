"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { plannerTintBackground } from "@/lib/planner/color-tint";
import { addCalendarDays, localDateString } from "@/lib/planner/date";
import { focusBlocksFetchDate, isLockedByCarryChild, isPastListDay } from "@/lib/planner/task-locks";
import { isTempId } from "@/lib/planner/temp-id";

import { KeepColorPickerDropdown } from "./keep-color-swatch";
import { ActualTaskBlock, RizeTimeEntryOption, TaskItem, TaskType } from "./types";

type Props = {
  selectedDate: string;
  tasks: TaskItem[];
  taskTypes: TaskType[];
  onCreateTask: (input: { title: string; taskTypeId: string | null; afterTaskId?: string }) => Promise<TaskItem | undefined>;
  onUpdateTask: (id: string, input: { title: string }) => Promise<void>;
  onChangeTaskPoints: (id: string, points: number) => Promise<void>;
  onChangeTaskType: (id: string, taskTypeId: string | null) => Promise<void>;
  onToggleTask: (task: TaskItem) => Promise<void>;
  onCompleteTaskWithFocus: (
    task: TaskItem,
    rizeEntryId: string,
    pointsCompleted: number,
    blockScheduledDate?: string,
  ) => Promise<void>;
  /** Registra avance parcial sin vincular a un bloque Rize. */
  onCompleteTaskPartial: (task: TaskItem, pointsCompleted: number) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  /** Crea copia en scheduled_date+1 con parent_task_id; el origen sigue pendiente. */
  onCarryTaskToNextDay: (task: TaskItem) => Promise<void>;
  /** Mientras se envía el POST de “pasar al día siguiente”. */
  carryingToNextTaskId?: string | null;
  onReorderTasks: (orderedIds: string[]) => Promise<void>;
  onCreateTaskType: (input: { name: string; color: string | null; contributesToMain?: boolean }) => Promise<void>;
  onPatchTaskType: (id: string, input: { name?: string; color?: string | null; contributesToMain?: boolean }) => Promise<void>;
  onDeleteTaskType: (id: string) => Promise<void>;
};

const DAILY_POINTS = 10;

function nextDayShortLabel(scheduledDate: string) {
  const next = addCalendarDays(String(scheduledDate).slice(0, 10), 1);
  return new Date(`${next}T12:00:00`).toLocaleDateString("es", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function focusClock(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Opciones del modal de enfoque: solo bloques vinculados a una entrada Rize (id no nulo). */
function actualTaskBlocksToFocusOptions(blocks: ActualTaskBlock[]): RizeTimeEntryOption[] {
  return blocks
    .filter((b): b is ActualTaskBlock & { rize_entry_id: string } => b.rize_entry_id != null)
    .map((b) => {
      const ms = new Date(b.end_at).getTime() - new Date(b.start_at).getTime();
      return {
        id: b.rize_entry_id,
        title: b.rize_title?.trim() || "Sin título",
        startTime: b.start_at,
        endTime: b.end_at,
        durationSeconds: Math.max(0, Math.round(ms / 1000)),
      };
    });
}

export function DailyTodoList({
  selectedDate,
  tasks,
  taskTypes,
  onCreateTask,
  onUpdateTask,
  onChangeTaskPoints,
  onChangeTaskType,
  onToggleTask,
  onCompleteTaskWithFocus,
  onCompleteTaskPartial,
  onDeleteTask,
  onCarryTaskToNextDay,
  carryingToNextTaskId = null,
  onReorderTasks,
  onCreateTaskType,
  onPatchTaskType,
  onDeleteTaskType,
}: Props) {
  const [taskTypeId, setTaskTypeId] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskTypeName, setNewTaskTypeName] = useState("");
  const [newTaskTypeColor, setNewTaskTypeColor] = useState<string | null>(null);
  const [taskTypesModalOpen, setTaskTypesModalOpen] = useState(false);
  const [taskTypeNameEdit, setTaskTypeNameEdit] = useState<{ id: string; name: string } | null>(null);
  const [openTypeMenuFor, setOpenTypeMenuFor] = useState<string | null>(null);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const [openPointsFor, setOpenPointsFor] = useState<string | null>(null);
  const pointsMenuRef = useRef<HTMLDivElement>(null);
  const [openTaskMenuFor, setOpenTaskMenuFor] = useState<string | null>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);

  /** Per-task edit drafts, keyed by task ID. Only populated while the user is editing. */
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragNodeRef = useRef<HTMLLIElement | null>(null);

  const [focusPickTask, setFocusPickTask] = useState<TaskItem | null>(null);
  const [focusEntries, setFocusEntries] = useState<RizeTimeEntryOption[]>([]);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);
  const [focusSubmitting, setFocusSubmitting] = useState(false);
  const [selectedRizeId, setSelectedRizeId] = useState<string | null>(null);
  /** Puntos a imputar en este bloque. Por defecto, los restantes de la tarea. */
  const [focusPointsToAdd, setFocusPointsToAdd] = useState(1);

  const isPastList = useMemo(() => isPastListDay(selectedDate), [selectedDate]);

  const activeTasks = useMemo(() => tasks.filter((t) => !t.done), [tasks]);
  const completedTasks = useMemo(() => tasks.filter((t) => t.done), [tasks]);

  const lockedActiveTasks = useMemo(
    () => activeTasks.filter((t) => isLockedByCarryChild(t) || isPastList),
    [activeTasks, isPastList],
  );
  const editableActiveTasks = useMemo(
    () => activeTasks.filter((t) => !isLockedByCarryChild(t) && !isPastList),
    [activeTasks, isPastList],
  );

  const budgetDots = useMemo(() => {
    return Array.from({ length: DAILY_POINTS }, (_, i) => {
      let acc = 0;
      for (const task of activeTasks) {
        const pts = task.points ?? 0;
        if (pts > 0 && i >= acc && i < acc + pts) {
          return { color: task.task_type?.color ?? null };
        }
        acc += pts;
      }
      return null;
    });
  }, [activeTasks]);

  useEffect(() => {
    setNewTaskTitle("");
    setEditDrafts({});
    setFocusPickTask(null);
  }, [selectedDate]);

  useEffect(() => {
    if (!focusPickTask) return;
    setSelectedRizeId(null);
    setFocusError(null);
    setFocusLoading(true);
    const total = Math.max(0, focusPickTask.points ?? 0);
    const done = Math.min(total, focusPickTask.points_done ?? 0);
    const remaining = Math.max(0, total - done);
    // Si la tarea tiene puntos, el stepper arranca en lo que falta; si no tiene, en 0.
    setFocusPointsToAdd(total > 0 ? Math.max(1, remaining) : 0);
    void (async () => {
      try {
        const blockDate = focusBlocksFetchDate(focusPickTask, selectedDate);
        const res = await fetch(
          `/api/planner/actual-tasks?date=${encodeURIComponent(blockDate)}`,
        );
        const json = (await res.json()) as { actualTaskBlocks?: ActualTaskBlock[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? "No se pudieron cargar los bloques.");
        setFocusEntries(actualTaskBlocksToFocusOptions(json.actualTaskBlocks ?? []));
      } catch (e) {
        setFocusError(e instanceof Error ? e.message : "Error de red");
        setFocusEntries([]);
      } finally {
        setFocusLoading(false);
      }
    })();
  }, [focusPickTask, selectedDate]);

  useEffect(() => {
    if (!focusPickTask) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !focusSubmitting) setFocusPickTask(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusPickTask, focusSubmitting]);

  useEffect(() => {
    if (taskTypes.length === 0) {
      setTaskTypeId("");
      return;
    }
    setTaskTypeId((prev) =>
      prev && taskTypes.some((t) => t.id === prev) ? prev : taskTypes[0].id,
    );
  }, [taskTypes]);

  function startEdit(task: TaskItem) {
    setEditDrafts((prev) => ({ ...prev, [task.id]: task.title }));
  }

  async function commitEdit(task: TaskItem) {
    const raw = (editDrafts[task.id] ?? task.title).trim();
    setEditDrafts((prev) => {
      const next = { ...prev };
      delete next[task.id];
      return next;
    });
    if (raw === "") {
      await onDeleteTask(task.id);
    } else if (raw !== task.title) {
      await onUpdateTask(task.id, { title: raw });
    }
  }

  async function addTaskFromComposer() {
    const title = newTaskTitle.trim();
    if (!title) return;
    const lastTask = activeTasks[activeTasks.length - 1];
    setNewTaskTitle("");
    await onCreateTask({
      title,
      taskTypeId: taskTypeId || null,
      afterTaskId: lastTask?.id,
    });
  }

  async function handleCreateTaskType(event: FormEvent) {
    event.preventDefault();
    if (!newTaskTypeName.trim()) return;
    await onCreateTaskType({ name: newTaskTypeName.trim(), color: newTaskTypeColor });
    setNewTaskTypeName("");
    setNewTaskTypeColor(null);
  }

  function handleDragStart(taskId: string, e: React.PointerEvent<HTMLSpanElement>) {
    const li = (e.target as HTMLElement).closest("li");
    if (!li) return;
    dragNodeRef.current = li;
    setDragId(taskId);
    li.style.opacity = "0.4";
  }

  function handleDragEnter(taskId: string) {
    if (!dragId || taskId === dragId) return;
    setDragOverId(taskId);
  }

  function handleDragEnd() {
    if (dragNodeRef.current) dragNodeRef.current.style.opacity = "";
    if (dragId && dragOverId && dragId !== dragOverId) {
      const ids = activeTasks.map((t) => t.id);
      const fromIdx = ids.indexOf(dragId);
      const toIdx = ids.indexOf(dragOverId);
      if (fromIdx !== -1 && toIdx !== -1) {
        ids.splice(fromIdx, 1);
        ids.splice(toIdx, 0, dragId);
        void onReorderTasks(ids);
      }
    }
    setDragId(null);
    setDragOverId(null);
    dragNodeRef.current = null;
  }

  useEffect(() => {
    if (!dragId) return;
    function onPointerUp() {
      handleDragEnd();
    }
    window.addEventListener("pointerup", onPointerUp);
    return () => window.removeEventListener("pointerup", onPointerUp);
  });

  useEffect(() => {
    if (taskTypesModalOpen) setNewTaskTypeColor(null);
  }, [taskTypesModalOpen]);

  useEffect(() => {
    if (!taskTypesModalOpen) setTaskTypeNameEdit(null);
  }, [taskTypesModalOpen]);

  useEffect(() => {
    if (!taskTypesModalOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setTaskTypesModalOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [taskTypesModalOpen]);

  useEffect(() => {
    if (!openTypeMenuFor) return;
    function onMouseDown(e: MouseEvent) {
      if (!typeMenuRef.current?.contains(e.target as Node)) {
        setOpenTypeMenuFor(null);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [openTypeMenuFor]);

  useEffect(() => {
    if (!openPointsFor) return;
    function onMouseDown(e: MouseEvent) {
      if (!pointsMenuRef.current?.contains(e.target as Node)) {
        setOpenPointsFor(null);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [openPointsFor]);

  useEffect(() => {
    if (!openTaskMenuFor) return;
    function onMouseDown(e: MouseEvent) {
      if (!taskMenuRef.current?.contains(e.target as Node)) {
        setOpenTaskMenuFor(null);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [openTaskMenuFor]);

  function renderActiveTaskRow(task: TaskItem) {
    const pts = task.points ?? 0;
    const usedByOthers = activeTasks
      .filter((t) => t.id !== task.id)
      .reduce((s, t) => s + (t.points ?? 0), 0);
    const maxAvailable = DAILY_POINTS - usedByOthers;
    const isEditing = task.id in editDrafts;
    const tLocked = isLockedByCarryChild(task);
    const tRead = tLocked || isPastList;

    return (
      <li
        key={task.id}
        className={`group flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${
          dragOverId === task.id ? "ring-2 ring-violet-400 ring-offset-1 dark:ring-offset-zinc-950" : ""
        }`}
        onPointerEnter={() => handleDragEnter(task.id)}
      >
        {!tRead && (
          <span
            className="shrink-0 cursor-grab touch-none select-none text-zinc-300 transition-colors hover:text-zinc-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:text-zinc-400"
            onPointerDown={(e) => handleDragStart(task.id, e)}
            aria-label="Reordenar"
          >
            ⠿
          </span>
        )}
        <input
          type="checkbox"
          checked={task.done}
          onChange={() => {
            if (tLocked) return;
            setFocusPickTask(task);
          }}
          disabled={tLocked}
          className="h-4 w-4 shrink-0 rounded border-zinc-300 dark:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={task.title.trim() ? `Marcar hecha: ${task.title}` : "Marcar hecha"}
        />
        <input
          type="text"
          readOnly={tRead}
          value={isEditing ? editDrafts[task.id] : task.title}
          onFocus={() => !tRead && !isEditing && startEdit(task)}
          onChange={(e) =>
            !tRead &&
            setEditDrafts((prev) => ({ ...prev, [task.id]: e.target.value }))
          }
          onBlur={() => isEditing && void commitEdit(task)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="min-w-0 flex-1 border-0 bg-transparent py-0.5 text-sm text-zinc-800 outline-none placeholder:text-zinc-300 dark:text-zinc-200 dark:placeholder:text-zinc-600"
        />
        {task.carry_next_child_id ? (
          <span
            className="shrink-0 text-[9px] font-medium text-zinc-400 dark:text-zinc-500"
            title="Ya existe una copia enlazada al día siguiente"
          >
            → copia
          </span>
        ) : null}

        {(task.points_done ?? 0) > 0 && pts > 0 ? (
          <span
            className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold tabular-nums"
            style={{
              backgroundColor: plannerTintBackground(
                task.task_type?.color ?? "#7c3aed",
                0.25,
              ),
              color: "currentcolor",
            }}
            aria-label={`Progreso ${task.points_done}/${pts} puntos`}
            title={`${task.points_done}/${pts} puntos ya hechos`}
          >
            {task.points_done}/{pts}
          </span>
        ) : null}

        {!tRead && (
          <div
            ref={openPointsFor === task.id ? pointsMenuRef : null}
            className="relative shrink-0"
          >
            <button
              type="button"
              onClick={() => {
                setOpenPointsFor((prev) => (prev === task.id ? null : task.id));
                setOpenTypeMenuFor(null);
                setOpenTaskMenuFor(null);
              }}
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold transition-colors ${
                pts > 0
                  ? "text-white dark:text-zinc-900"
                  : "border border-zinc-200 text-zinc-300 hover:border-zinc-300 hover:text-zinc-400 dark:border-zinc-700 dark:text-zinc-600"
              }`}
              style={
                pts > 0
                  ? { backgroundColor: plannerTintBackground(task.task_type?.color ?? "#7c3aed") }
                  : undefined
              }
              aria-label="Asignar puntos"
            >
              {pts > 0 ? pts : "·"}
            </button>
            {openPointsFor === task.id ? (
              <div className="absolute right-0 top-full z-30 mt-1 flex gap-1 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                {Array.from({ length: DAILY_POINTS }, (_, i) => {
                  const n = i + 1;
                  const isActive = n <= pts;
                  const isAvailable = !isActive && n <= maxAvailable;
                  return (
                    <button
                      key={n}
                      type="button"
                      disabled={!isActive && !isAvailable}
                      onClick={() => {
                        void onChangeTaskPoints(task.id, n === pts ? 0 : n);
                        setOpenPointsFor(null);
                      }}
                      className={`h-4 w-4 rounded-full transition-colors ${
                        isActive
                          ? "opacity-100"
                          : isAvailable
                            ? "opacity-25 hover:opacity-60"
                            : "cursor-not-allowed opacity-10"
                      }`}
                      style={
                        isActive
                          ? { backgroundColor: plannerTintBackground(task.task_type?.color ?? "#7c3aed") }
                          : { backgroundColor: plannerTintBackground("#a1a1aa") }
                      }
                      aria-label={`${n}`}
                    />
                  );
                })}
              </div>
            ) : null}
          </div>
        )}

        <div
          ref={openTypeMenuFor === task.id ? typeMenuRef : null}
          className="relative shrink-0"
        >
          <button
            type="button"
            disabled={tRead}
            onClick={() => {
              setOpenTypeMenuFor((prev) => (prev === task.id ? null : task.id));
              setOpenPointsFor(null);
              setOpenTaskMenuFor(null);
            }}
            className={`w-30 truncate rounded-full px-2 py-0.5 text-center text-[10px] font-medium ${
              tRead ? "cursor-default" : "transition-opacity hover:opacity-80"
            } ${
              task.task_type?.color
                ? "text-zinc-800 dark:text-zinc-100"
                : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
            }`}
            style={
              task.task_type?.color
                ? { backgroundColor: plannerTintBackground(task.task_type.color) }
                : undefined
            }
            aria-label="Cambiar tipo de tarea"
          >
            {task.task_type?.contributes_to_main && <span className="mr-0.5">★</span>}
            {task.task_type?.name ?? "···"}
          </button>
          {openTypeMenuFor === task.id ? (
            <div className="absolute right-0 top-full z-20 mt-1 min-w-[9rem] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              <button
                type="button"
                onClick={() => {
                  void onChangeTaskType(task.id, null);
                  setOpenTypeMenuFor(null);
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-zinc-400 hover:bg-zinc-50 dark:text-zinc-500 dark:hover:bg-zinc-800"
              >
                Sin tipo
              </button>
              {taskTypes.map((tt) => (
                <button
                  key={tt.id}
                  type="button"
                  onClick={() => {
                    void onChangeTaskType(task.id, tt.id);
                    setOpenTypeMenuFor(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${tt.color ? "" : "bg-zinc-300 dark:bg-zinc-600"}`}
                    style={tt.color ? { backgroundColor: plannerTintBackground(tt.color) } : undefined}
                  />
                  <span className="flex-1">{tt.name}</span>
                  {tt.contributes_to_main && (
                    <span className="text-violet-500 dark:text-violet-400" title="Contribuye al objetivo principal">★</span>
                  )}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {isTempId(task.id) && isPastList ? null : (
          <div
            ref={openTaskMenuFor === task.id ? taskMenuRef : null}
            className="relative shrink-0"
          >
            <button
              type="button"
              aria-label="Más acciones"
              onClick={() => {
                setOpenTaskMenuFor((p) => (p === task.id ? null : task.id));
                setOpenTypeMenuFor(null);
                setOpenPointsFor(null);
              }}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-200/80 hover:text-zinc-600 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            >
              ⋮
            </button>
            {openTaskMenuFor === task.id ? (
              <div className="absolute right-0 top-full z-40 mt-1 min-w-[12rem] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                {!isTempId(task.id) && !tLocked ? (
                  carryingToNextTaskId === task.id ? (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-300 border-t-violet-500 dark:border-zinc-600 dark:border-t-violet-400" />
                      Enviando…
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        void onCarryTaskToNextDay(task).finally(() => setOpenTaskMenuFor(null));
                      }}
                      className="w-full px-3 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      Pasar a {nextDayShortLabel(task.scheduled_date)}
                    </button>
                  )
                ) : null}
                {!tRead ? (
                  <button
                    type="button"
                    onClick={() => {
                      void onDeleteTask(task.id).finally(() => setOpenTaskMenuFor(null));
                    }}
                    className="w-full px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                  >
                    Eliminar
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </li>
    );
  }

  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 w-180">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Tareas</h2>
        <button
          type="button"
          onClick={() => setTaskTypesModalOpen(true)}
          className="shrink-0 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Tipos
        </button>
      </div>

      <div className="mt-3 flex items-center gap-[3px] px-1">
        {budgetDots.map((dot, i) => (
          <div
            key={i}
            className={`h-[5px] flex-1 rounded-full transition-colors ${
              dot !== null ? "" : "bg-zinc-200 dark:bg-zinc-700"
            }`}
            style={
              dot !== null
                ? { backgroundColor: plannerTintBackground(dot.color ?? "#7c3aed") }
                : undefined
            }
          />
        ))}
      </div>

      <div className="mt-3 flex flex-col rounded-lg">
        <div className="px-1 py-1.5">
          {lockedActiveTasks.length > 0 && (
            <ul className="space-y-0.5 opacity-60">
              {lockedActiveTasks.map((task) => renderActiveTaskRow(task))}
            </ul>
          )}
          {lockedActiveTasks.length > 0 && editableActiveTasks.length > 0 && <br />}
          <ul className="space-y-0.5">
            {editableActiveTasks.map((task) => renderActiveTaskRow(task))}
          </ul>

          {!isPastList ? (
            <div className="mt-1 flex items-center gap-2 rounded-md px-2 py-1">
              <input
                type="text"
                value={newTaskTitle}
                onChange={(e) =>
                  setNewTaskTitle(e.target.value.replace(/\r\n|\r|\n/g, " "))
                }
                className="min-w-0 flex-1 border-0 bg-transparent py-0.5 text-sm text-zinc-800 outline-none placeholder:text-zinc-300 dark:text-zinc-200 dark:placeholder:text-zinc-600"
                placeholder="Nueva tarea…"
                aria-label="Nueva tarea"
              />
              <button
                type="button"
                onClick={() => void addTaskFromComposer()}
                className="shrink-0 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-violet-700 disabled:opacity-50"
                disabled={!newTaskTitle.trim()}
              >
                Añadir
              </button>
            </div>
          ) : null}

          {completedTasks.length > 0 ? (
            <>
              <div className="mx-2 my-3 border-t border-zinc-100 dark:border-zinc-800" />
              <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                Completadas
              </p>
              <ul className="space-y-0.5">
                {completedTasks.map((task) => {
                  const isEditing = task.id in editDrafts;
                  const ctLocked = isLockedByCarryChild(task);
                  const ctRead = ctLocked || isPastList;
                  return (
                    <li
                      key={task.id}
                      className="group flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                    >
                      <input
                        type="checkbox"
                        checked={task.done}
                        onChange={() => !ctRead && void onToggleTask(task)}
                        disabled={ctRead}
                        className="h-4 w-4 shrink-0 rounded border-zinc-300 dark:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`Desmarcar: ${task.title}`}
                      />
                      <input
                        type="text"
                        readOnly={ctRead}
                        value={isEditing ? editDrafts[task.id] : task.title}
                        onFocus={() => !ctRead && !isEditing && startEdit(task)}
                        onChange={(e) =>
                          !ctRead &&
                          setEditDrafts((prev) => ({ ...prev, [task.id]: e.target.value }))
                        }
                        onBlur={() => isEditing && void commitEdit(task)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                        className="min-w-0 flex-1 border-0 bg-transparent py-0.5 text-sm text-zinc-400 line-through outline-none ring-0 dark:text-zinc-600"
                      />
                      {(task.points ?? 0) > 0 ? (
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold opacity-50"
                          style={{
                            backgroundColor: plannerTintBackground(task.task_type?.color ?? "#7c3aed"),
                            color: "white",
                          }}
                        >
                          {task.points}
                        </span>
                      ) : null}
                      {task.task_type ? (
                        <span
                          className="w-30 truncate rounded-full px-2 py-0.5 text-center text-[10px] font-medium opacity-50"
                          style={{ backgroundColor: plannerTintBackground(task.task_type.color ?? "#a1a1aa") }}
                        >
                          {task.task_type.name}
                        </span>
                      ) : null}
                      {!ctRead ? (
                        <div
                          ref={openTaskMenuFor === task.id ? taskMenuRef : null}
                          className="relative shrink-0"
                        >
                          <button
                            type="button"
                            aria-label="Más acciones"
                            onClick={() => {
                              setOpenTaskMenuFor((p) => (p === task.id ? null : task.id));
                              setOpenTypeMenuFor(null);
                              setOpenPointsFor(null);
                            }}
                            className="flex h-7 w-6 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-200/80 hover:text-zinc-600 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                          >
                            ⋮
                          </button>
                          {openTaskMenuFor === task.id ? (
                            <div className="absolute right-0 top-full z-40 mt-1 min-w-[10rem] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                              <button
                                type="button"
                                onClick={() => {
                                  void onDeleteTask(task.id).finally(() => setOpenTaskMenuFor(null));
                                }}
                                className="w-full px-3 py-2 text-left text-xs text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                              >
                                Eliminar
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      {focusPickTask ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            disabled={focusSubmitting}
            onClick={() => !focusSubmitting && setFocusPickTask(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="focus-pick-title"
            className="relative z-10 flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-zinc-200/80 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 border-b border-zinc-100 p-5 dark:border-zinc-800">
              <h3
                id="focus-pick-title"
                className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
              >
                Vincular bloque de enfoque
              </h3>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Elige el bloque de enfoque ya sincronizado en el calendario para{" "}
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  {focusPickTask.title}
                </span>
                .
                {isPastList ? (
                  <span className="mt-1 block text-amber-700 dark:text-amber-300">
                    Día pasado: solo puedes vincular un bloque Rize; no editar la tarea aquí con avance
                    sin vincular.
                  </span>
                ) : null}
              </p>
              {isTempId(focusPickTask.id) ? (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                  Espera a que la tarea termine de guardarse para vincular un bloque, o complétala sin
                  vincular.
                </p>
              ) : null}

              {(() => {
                const total = Math.max(0, focusPickTask.points ?? 0);
                if (total === 0) return null;
                const done = Math.min(total, focusPickTask.points_done ?? 0);
                const remaining = Math.max(0, total - done);
                const max = Math.max(1, remaining);
                const value = Math.max(1, Math.min(max, focusPointsToAdd));
                return (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                        Puntos hechos en este bloque
                      </p>
                      <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                        Llevas {done}/{total}. Si no completas hoy, los restantes se moverán a mañana.
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        disabled={focusSubmitting || value <= 1}
                        onClick={() => setFocusPointsToAdd((v) => Math.max(1, v - 1))}
                        className="h-7 w-7 rounded-md border border-zinc-200 text-sm font-semibold text-zinc-600 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                        aria-label="Restar"
                      >
                        −
                      </button>
                      <span className="w-8 text-center text-sm font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                        {value}
                      </span>
                      <button
                        type="button"
                        disabled={focusSubmitting || value >= max}
                        onClick={() => setFocusPointsToAdd((v) => Math.min(max, v + 1))}
                        className="h-7 w-7 rounded-md border border-zinc-200 text-sm font-semibold text-zinc-600 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                        aria-label="Sumar"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              {focusLoading ? (
                <p className="text-sm text-zinc-400 dark:text-zinc-500">Cargando bloques...</p>
              ) : focusError ? (
                <p className="text-sm text-rose-600 dark:text-rose-400">{focusError}</p>
              ) : focusEntries.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  No hay bloques sincronizados para este día. Pulsa ⟳ junto al calendario para traer
                  los focos desde Rize a Supabase y vuelve a abrir esta ventana.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {focusEntries.map((e) => {
                    const durMin = Math.max(1, Math.round(e.durationSeconds / 60));
                    const sel = selectedRizeId === e.id;
                    return (
                      <li key={e.id}>
                        <button
                          type="button"
                          disabled={focusSubmitting || isTempId(focusPickTask.id)}
                          onClick={() => setSelectedRizeId(e.id)}
                          className={`w-full rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                            sel
                              ? "border-violet-500 bg-violet-50 dark:border-violet-500 dark:bg-violet-950/40"
                              : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                          } disabled:opacity-50`}
                        >
                          <span className="block font-medium text-zinc-900 dark:text-zinc-50">
                            {e.title}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-zinc-500 dark:text-zinc-400">
                            {focusClock(e.startTime)} – {focusClock(e.endTime)} · {durMin} min
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-100 p-4 dark:border-zinc-800">
              <button
                type="button"
                disabled={focusSubmitting}
                onClick={() => setFocusPickTask(null)}
                className="rounded-lg border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={focusSubmitting || isPastList}
                onClick={() => {
                  void (async () => {
                    if (!focusPickTask) return;
                    setFocusSubmitting(true);
                    try {
                      const total = Math.max(0, focusPickTask.points ?? 0);
                      if (total === 0) {
                        // Tareas sin puntos: conserva UX anterior (toggle simple).
                        await onToggleTask(focusPickTask);
                      } else {
                        await onCompleteTaskPartial(focusPickTask, focusPointsToAdd);
                      }
                      setFocusPickTask(null);
                    } finally {
                      setFocusSubmitting(false);
                    }
                  })();
                }}
                className="rounded-lg border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                {focusPickTask.points > 0 ? "Guardar avance sin vincular" : "Completar sin vincular"}
              </button>
              <button
                type="button"
                disabled={
                  focusSubmitting ||
                  !selectedRizeId ||
                  isTempId(focusPickTask.id) ||
                  focusLoading ||
                  !!focusError
                }
                onClick={() => {
                  void (async () => {
                    if (!focusPickTask || !selectedRizeId) return;
                    setFocusSubmitting(true);
                    try {
                      const b = focusBlocksFetchDate(focusPickTask, selectedDate);
                      await onCompleteTaskWithFocus(
                        focusPickTask,
                        selectedRizeId,
                        focusPointsToAdd,
                        b !== String(focusPickTask.scheduled_date).slice(0, 10) ? b : undefined,
                      );
                      setFocusPickTask(null);
                    } finally {
                      setFocusSubmitting(false);
                    }
                  })();
                }}
                className="rounded-lg bg-violet-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-violet-700 disabled:opacity-50 dark:bg-violet-500 dark:hover:bg-violet-600"
              >
                {focusSubmitting
                  ? "Guardando..."
                  : focusPickTask.points > 0
                    ? "Guardar avance y vincular"
                    : "Completar y vincular"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {taskTypesModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="presentation"
        >
          <button
            type="button"
            aria-label="Cerrar modal"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setTaskTypesModalOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-types-modal-title"
            className="relative z-10 w-full max-w-md rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 id="task-types-modal-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                Tipos de tarea
              </h3>
              <button
                type="button"
                onClick={() => setTaskTypesModalOpen(false)}
                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Crea o elimina tipos. Los cambios se reflejan en el selector al crear tareas.
            </p>
            <form className="mt-3 space-y-2" onSubmit={handleCreateTaskType}>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[12rem] flex-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Nuevo tipo
                  <input
                    value={newTaskTypeName}
                    onChange={(event) => setNewTaskTypeName(event.target.value)}
                    placeholder="Nombre..."
                    className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Color</span>
                  <KeepColorPickerDropdown
                    value={newTaskTypeColor}
                    onChange={setNewTaskTypeColor}
                    size="md"
                    align="left"
                  />
                </div>
                <button
                  type="submit"
                  className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700"
                >
                  Agregar
                </button>
              </div>
            </form>
            <ul className="mt-3 max-h-60 space-y-1 overflow-y-auto">
              {taskTypes.length === 0 ? (
                <li className="text-sm text-zinc-500 dark:text-zinc-400">No hay tipos aun.</li>
              ) : null}
              {taskTypes.map((taskType) => (
                <li
                  key={taskType.id}
                  className="group flex items-center gap-2 rounded-md border border-zinc-100 px-2 py-1.5 text-sm dark:border-zinc-800"
                >
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full border border-zinc-300 dark:border-zinc-600 ${
                      taskType.color ? "" : "bg-zinc-200/80 dark:bg-zinc-700/80"
                    }`}
                    style={
                      taskType.color
                        ? { backgroundColor: plannerTintBackground(taskType.color) }
                        : undefined
                    }
                    aria-hidden
                  />
                  {taskTypeNameEdit?.id === taskType.id ? (
                    <input
                      autoFocus
                      value={taskTypeNameEdit.name}
                      onChange={(e) =>
                        setTaskTypeNameEdit({ id: taskType.id, name: e.target.value })
                      }
                      onBlur={(e) => {
                        const draft = e.target.value.trim();
                        setTaskTypeNameEdit(null);
                        if (draft && draft !== taskType.name) {
                          void onPatchTaskType(taskType.id, { name: draft });
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") {
                          setTaskTypeNameEdit(null);
                          e.stopPropagation();
                        }
                      }}
                      className="min-w-0 flex-1 rounded border bg-white px-2 py-0.5 text-sm dark:bg-zinc-900"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate font-medium">{taskType.name}</span>
                  )}
                  <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                    {taskTypeNameEdit?.id !== taskType.id ? (
                      <button
                        type="button"
                        onClick={() =>
                          setTaskTypeNameEdit({ id: taskType.id, name: taskType.name })
                        }
                        className="rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                      >
                        Editar
                      </button>
                    ) : null}
                    <KeepColorPickerDropdown
                      value={taskType.color}
                      onChange={(color) => void onPatchTaskType(taskType.id, { color })}
                      size="sm"
                      align="right"
                    />
                    <button
                      type="button"
                      title={taskType.contributes_to_main ? "Quitar de main" : "Contribuye al main"}
                      onClick={() =>
                        void onPatchTaskType(taskType.id, {
                          contributesToMain: !taskType.contributes_to_main,
                        })
                      }
                      className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                        taskType.contributes_to_main
                          ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"
                          : "text-zinc-400 hover:bg-zinc-100 dark:text-zinc-600 dark:hover:bg-zinc-800"
                      }`}
                    >
                      ★
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDeleteTaskType(taskType.id)}
                      className="rounded px-1.5 py-0.5 text-xs text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                    >
                      Eliminar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
