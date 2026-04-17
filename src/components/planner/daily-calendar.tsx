"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { plannerTintBackground } from "@/lib/planner/color-tint";
import { localDateString } from "@/lib/planner/date";
import { isTempId } from "@/lib/planner/temp-id";

import { KeepColorPickerDropdown } from "./keep-color-swatch";
import { ActualHabitBlock, ActualTaskBlock, HabitType, TaskItem, TimeBlock } from "./types";

type Props = {
  selectedDate: string;
  tasks: TaskItem[];
  habits: HabitType[];
  timeBlocks: TimeBlock[];
  onCreateBlock: (input: {
    startAt: string;
    endAt: string;
    entryType: "task" | "habit";
    taskId: string | null;
    habitTypeId: string | null;
  }) => Promise<void>;
  onPatchBlock: (id: string, input: { startAt?: string; endAt?: string; taskId?: string | null; habitTypeId?: string | null }) => Promise<void>;
  onDeleteBlock: (id: string) => Promise<void>;
  onCreateHabitType: (input: { name: string; color: string | null }) => Promise<void>;
  onPatchHabitType: (
    id: string,
    input: { name?: string; color?: string | null },
  ) => Promise<void>;
  onDeleteHabitType: (id: string) => Promise<void>;
  actualHabitBlocks: ActualHabitBlock[];
  onCreateActualHabit: (input: {
    startAt: string;
    endAt: string;
    habitTypeId: string;
    description: string;
    plannedBlockId?: string | null;
  }) => Promise<void>;
  onPatchActualHabit: (id: string, input: { startAt?: string; endAt?: string; description?: string }) => Promise<void>;
  onDeleteActualHabit: (id: string) => Promise<void>;
  actualTaskBlocks: ActualTaskBlock[];
  syncingActualTasks: boolean;
  onDeleteActualTask: (id: string) => Promise<void>;
  onSyncActualTasks: () => void;
};

const MINUTES_DAY = 24 * 60;
const SNAP_MINUTES = 15;
/** Hábitos planificados ya pasados y más cortos que esto usan franja compacta (completar visible a la derecha). */
const PAST_HABIT_COMPACT_MAX_MIN = 45;
/** Color fijo para bloques de foco Rize reales (no usa el color de categoría/tipo de la tarea). */
const RIZE_ACTUAL_TASK_COLOR = "#14caf3f5";
/** Altura minima por hora en el eje vertical (scroll si no cabe). */
const TIMELINE_MIN_PX_PER_HOUR = 64;
const TIMELINE_CONTENT_HEIGHT = 24 * TIMELINE_MIN_PX_PER_HOUR;

function toIsoFromDateAndTime(date: string, timeHHMM: string) {
  return new Date(`${date}T${timeHHMM}:00`).toISOString();
}

/** Hora en bloques (intervalo) —12 h con AM/PM segun locale. */
function clock(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Etiqueta en la regla de la izquierda (solo hora en punto). */
function hourRulerLabel(hour24: number): string {
  const d = new Date(2000, 0, 1, hour24, 0, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", hour12: true });
}

function minOfDay(iso: string) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function snapMinutes(value: number, step = SNAP_MINUTES): number {
  return Math.round(value / step) * step;
}

function minutesToHHMM(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_DAY - 1, totalMinutes));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function normalizeDragRange(a: number, b: number): { start: number; end: number } {
  let start = Math.min(a, b);
  let end = Math.max(a, b);
  start = snapMinutes(start);
  end = snapMinutes(end);
  if (end <= start) {
    end = Math.min(start + SNAP_MINUTES, MINUTES_DAY);
  }
  if (end - start < SNAP_MINUTES) {
    end = Math.min(start + SNAP_MINUTES, MINUTES_DAY);
  }
  return { start, end };
}

/** ISO UTC coherente con el resto del planner (fecha local + HH:MM). */
function isoFromDayMinutes(date: string, minutesTotal: number): string {
  const clamped = Math.max(0, Math.min(MINUTES_DAY - SNAP_MINUTES, minutesTotal));
  return new Date(`${date}T${minutesToHHMM(clamped)}:00`).toISOString();
}

type BlockLayout = TimeBlock & { top: number; height: number; startMin: number; endMin: number };

type ActualBlockLayout = ActualHabitBlock & { top: number; height: number; startMin: number; endMin: number };

type ActualTaskBlockLayout = ActualTaskBlock & { top: number; height: number; startMin: number; endMin: number };

export function DailyCalendar({
  selectedDate,
  tasks,
  habits,
  timeBlocks,
  onCreateBlock,
  onPatchBlock,
  onDeleteBlock,
  onCreateHabitType,
  onPatchHabitType,
  onDeleteHabitType,
  actualHabitBlocks,
  onCreateActualHabit,
  onPatchActualHabit,
  onDeleteActualHabit,
  actualTaskBlocks,
  syncingActualTasks,
  onDeleteActualTask,
  onSyncActualTasks,
}: Props) {
  const timelineRef = useRef<HTMLDivElement>(null);
  /** Área del día (altura fija); el scroll vive en el padre con padding — el hit-test debe usar este rect, no el del padre. */
  const timelineContentRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<HTMLDivElement>(null);
  const dragStartMinRef = useRef<number | null>(null);

  const [entryType, setEntryType] = useState<"task" | "habit">("task");
  const [taskId, setTaskId] = useState("");
  const [habitTypeId, setHabitTypeId] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [newHabitName, setNewHabitName] = useState("");
  const [newHabitColor, setNewHabitColor] = useState<string | null>(null);
  const [habitNameEdit, setHabitNameEdit] = useState<{ id: string; name: string } | null>(null);

  const [blockModalOpen, setBlockModalOpen] = useState(false);
  const [actualHabitModalOpen, setActualHabitModalOpen] = useState(false);
  const [actualHabitModalMode, setActualHabitModalMode] = useState<"new" | "complete">("new");
  const [actualHabitPlannedBlockId, setActualHabitPlannedBlockId] = useState<string | null>(null);
  const [actualHabitTypeId, setActualHabitTypeId] = useState("");
  const [actualDescription, setActualDescription] = useState("");
  const [actualStartTime, setActualStartTime] = useState("09:00");
  const [actualEndTime, setActualEndTime] = useState("10:00");
  const [editBlockId, setEditBlockId] = useState<string | null>(null);
  const [editBlockTaskId, setEditBlockTaskId] = useState("");
  const [editBlockHabitTypeId, setEditBlockHabitTypeId] = useState("");
  const [editBlockEntryType, setEditBlockEntryType] = useState<"task" | "habit">("task");

  const [editActualId, setEditActualId] = useState<string | null>(null);
  const [editActualDescription, setEditActualDescription] = useState("");

  const [habitsModalOpen, setHabitsModalOpen] = useState(false);
  const [dragStartMin, setDragStartMin] = useState<number | null>(null);
  const [dragCurrentMin, setDragCurrentMin] = useState<number | null>(null);
  const [dragInPast, setDragInPast] = useState(false);
  const [blockDragPreview, setBlockDragPreview] = useState<{
    id: string;
    startMin: number;
    endMin: number;
  } | null>(null);
  const [actualBlockDragPreview, setActualBlockDragPreview] = useState<{
    id: string;
    startMin: number;
    endMin: number;
  } | null>(null);

  const getMinutesFromClientY = useCallback((clientY: number) => {
    const content = timelineContentRef.current;
    if (!content) return 0;
    const rect = content.getBoundingClientRect();
    const y = clientY - rect.top;
    const h = content.clientHeight || TIMELINE_CONTENT_HEIGHT;
    const ratio = Math.max(0, Math.min(1, y / h));
    return ratio * MINUTES_DAY;
  }, []);

  const previewStyle = useMemo(() => {
    if (dragStartMin === null || dragCurrentMin === null) return null;
    const a = Math.min(dragStartMin, dragCurrentMin);
    const b = Math.max(dragStartMin, dragCurrentMin);
    const top = (a / MINUTES_DAY) * 100;
    const height = Math.max(((b - a) / MINUTES_DAY) * 100, 0.35);
    return { top, height };
  }, [dragStartMin, dragCurrentMin]);

  /** Tareas del día por id: el calendario muestra bloques de tarea según `tasks`, no copias en `block.task`. */
  const taskById = useMemo(() => {
    const m = new Map<string, TaskItem>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  const blocks = useMemo((): BlockLayout[] => {
    return timeBlocks.map((block) => {
      let startMin = minOfDay(block.start_at);
      let endMin = Math.max(startMin + SNAP_MINUTES, minOfDay(block.end_at));
      if (blockDragPreview?.id === block.id) {
        startMin = blockDragPreview.startMin;
        endMin = blockDragPreview.endMin;
      }
      return {
        ...block,
        startMin,
        endMin,
        top: (startMin / MINUTES_DAY) * 100,
        height: Math.max(((endMin - startMin) / MINUTES_DAY) * 100, 1.5),
      };
    });
  }, [timeBlocks, blockDragPreview]);

  const actualBlocks = useMemo((): ActualBlockLayout[] => {
    return actualHabitBlocks.map((block) => {
      let startMin = minOfDay(block.start_at);
      let endMin = Math.max(startMin + SNAP_MINUTES, minOfDay(block.end_at));
      if (actualBlockDragPreview?.id === block.id) {
        startMin = actualBlockDragPreview.startMin;
        endMin = actualBlockDragPreview.endMin;
      }
      return {
        ...block,
        startMin,
        endMin,
        top: (startMin / MINUTES_DAY) * 100,
        height: Math.max(((endMin - startMin) / MINUTES_DAY) * 100, 1.5),
      };
    });
  }, [actualHabitBlocks, actualBlockDragPreview]);

  const actualTaskBlockLayouts = useMemo((): ActualTaskBlockLayout[] => {
    return actualTaskBlocks.map((block) => {
      const startMin = minOfDay(block.start_at);
      const endMin = Math.max(startMin + SNAP_MINUTES, minOfDay(block.end_at));
      return {
        ...block,
        startMin,
        endMin,
        top: (startMin / MINUTES_DAY) * 100,
        height: Math.max(((endMin - startMin) / MINUTES_DAY) * 100, 1.5),
      };
    });
  }, [actualTaskBlocks]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const { isPastDay, nowMinutes } = useMemo(() => {
    const today = localDateString(new Date(nowMs));
    const pastDay = selectedDate < today;
    const minutes =
      !pastDay && selectedDate === today
        ? new Date(nowMs).getHours() * 60 + new Date(nowMs).getMinutes()
        : null;
    return { isPastDay: pastDay, nowMinutes: minutes };
  }, [selectedDate, nowMs]);

  const blockAdjustSessionRef = useRef(false);

  const beginBlockAdjust = useCallback(
    (
      block: BlockLayout,
      mode: "move" | "resize-top" | "resize-bottom",
      clientY: number,
    ) => {
      if (isTempId(block.id) || blockAdjustSessionRef.current) return;
      blockAdjustSessionRef.current = true;

      const originStart = block.startMin;
      const originEnd = block.endMin;
      const grabMin = getMinutesFromClientY(clientY);
      let lastStart = originStart;
      let lastEnd = originEnd;

      const applyPreview = (startMin: number, endMin: number) => {
        let s = startMin;
        let e = endMin;
        if (e - s < SNAP_MINUTES) e = s + SNAP_MINUTES;
        s = Math.max(0, s);
        e = Math.min(MINUTES_DAY, e);
        if (e - s < SNAP_MINUTES) {
          s = Math.max(0, e - SNAP_MINUTES);
        }
        lastStart = s;
        lastEnd = e;
        setBlockDragPreview({ id: block.id, startMin: s, endMin: e });
      };

      setBlockDragPreview({ id: block.id, startMin: originStart, endMin: originEnd });

      const onMove = (ev: PointerEvent) => {
        const m = getMinutesFromClientY(ev.clientY);
        if (mode === "resize-top") {
          let start = snapMinutes(m);
          const end = originEnd;
          start = Math.min(start, end - SNAP_MINUTES);
          start = Math.max(0, start);
          applyPreview(start, end);
        } else if (mode === "resize-bottom") {
          const start = originStart;
          let end = snapMinutes(m);
          end = Math.max(end, start + SNAP_MINUTES);
          end = Math.min(MINUTES_DAY, end);
          applyPreview(start, end);
        } else {
          const delta = m - grabMin;
          let ns = snapMinutes(originStart + delta);
          let ne = snapMinutes(originEnd + delta);
          if (ne - ns < SNAP_MINUTES) ne = ns + SNAP_MINUTES;
          if (ns < 0) {
            ne -= ns;
            ns = 0;
          }
          if (ne > MINUTES_DAY) {
            ns -= ne - MINUTES_DAY;
            ne = MINUTES_DAY;
          }
          ns = Math.max(0, ns);
          if (ne - ns < SNAP_MINUTES) ne = Math.min(ns + SNAP_MINUTES, MINUTES_DAY);
          applyPreview(ns, ne);
        }
      };

      const onUp = () => {
        blockAdjustSessionRef.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setBlockDragPreview(null);
        if (lastStart !== originStart || lastEnd !== originEnd) {
          void onPatchBlock(block.id, {
            startAt: isoFromDayMinutes(selectedDate, lastStart),
            endAt: isoFromDayMinutes(selectedDate, lastEnd),
          });
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [getMinutesFromClientY, onPatchBlock, selectedDate],
  );

  const beginActualBlockAdjust = useCallback(
    (
      block: ActualBlockLayout,
      mode: "move" | "resize-top" | "resize-bottom",
      clientY: number,
    ) => {
      if (isTempId(block.id) || blockAdjustSessionRef.current) return;
      blockAdjustSessionRef.current = true;

      const originStart = block.startMin;
      const originEnd = block.endMin;
      const grabMin = getMinutesFromClientY(clientY);
      let lastStart = originStart;
      let lastEnd = originEnd;

      const applyPreview = (startMin: number, endMin: number) => {
        let s = startMin;
        let e = endMin;
        if (e - s < SNAP_MINUTES) e = s + SNAP_MINUTES;
        s = Math.max(0, s);
        e = Math.min(MINUTES_DAY, e);
        if (e - s < SNAP_MINUTES) {
          s = Math.max(0, e - SNAP_MINUTES);
        }
        lastStart = s;
        lastEnd = e;
        setActualBlockDragPreview({ id: block.id, startMin: s, endMin: e });
      };

      setActualBlockDragPreview({ id: block.id, startMin: originStart, endMin: originEnd });

      const onMove = (ev: PointerEvent) => {
        const m = getMinutesFromClientY(ev.clientY);
        if (mode === "resize-top") {
          let start = snapMinutes(m);
          const end = originEnd;
          start = Math.min(start, end - SNAP_MINUTES);
          start = Math.max(0, start);
          applyPreview(start, end);
        } else if (mode === "resize-bottom") {
          const start = originStart;
          let end = snapMinutes(m);
          end = Math.max(end, start + SNAP_MINUTES);
          end = Math.min(MINUTES_DAY, end);
          applyPreview(start, end);
        } else {
          const delta = m - grabMin;
          let ns = snapMinutes(originStart + delta);
          let ne = snapMinutes(originEnd + delta);
          if (ne - ns < SNAP_MINUTES) ne = ns + SNAP_MINUTES;
          if (ns < 0) {
            ne -= ns;
            ns = 0;
          }
          if (ne > MINUTES_DAY) {
            ns -= ne - MINUTES_DAY;
            ne = MINUTES_DAY;
          }
          ns = Math.max(0, ns);
          if (ne - ns < SNAP_MINUTES) ne = Math.min(ns + SNAP_MINUTES, MINUTES_DAY);
          applyPreview(ns, ne);
        }
      };

      const onUp = () => {
        blockAdjustSessionRef.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setActualBlockDragPreview(null);
        if (lastStart !== originStart || lastEnd !== originEnd) {
          void onPatchActualHabit(block.id, {
            startAt: isoFromDayMinutes(selectedDate, lastStart),
            endAt: isoFromDayMinutes(selectedDate, lastEnd),
          });
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [getMinutesFromClientY, onPatchActualHabit, selectedDate],
  );

  function openBlockModal(nextStart: string, nextEnd: string) {
    setStartTime(nextStart);
    setEndTime(nextEnd);
    if (tasks.length > 0) {
      setEntryType("task");
      setTaskId((prev) => (prev && tasks.some((t) => t.id === prev) ? prev : tasks[0].id));
      setHabitTypeId("");
    } else if (habits.length > 0) {
      setEntryType("habit");
      setHabitTypeId((prev) => (prev && habits.some((h) => h.id === prev) ? prev : habits[0].id));
      setTaskId("");
    } else {
      setEntryType("task");
      setTaskId("");
      setHabitTypeId("");
    }
    setBlockModalOpen(true);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-time-block]") || target.closest("[data-actual-block]")) return;

    const m = getMinutesFromClientY(event.clientY);
    const inPast = isPastDay || (nowMinutes !== null && m < nowMinutes);
    setDragInPast(inPast);
    dragStartMinRef.current = m;
    setDragStartMin(m);
    setDragCurrentMin(m);
    interactionRef.current?.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragStartMinRef.current === null) return;
    setDragCurrentMin(getMinutesFromClientY(event.clientY));
  }

  function openActualHabitModal(nextStart: string, nextEnd: string, plannedBlockId?: string | null, preselectedHabitTypeId?: string) {
    setActualStartTime(nextStart);
    setActualEndTime(nextEnd);
    setActualDescription("");
    setActualHabitPlannedBlockId(plannedBlockId ?? null);
    if (plannedBlockId && preselectedHabitTypeId) {
      setActualHabitModalMode("complete");
      setActualHabitTypeId(preselectedHabitTypeId);
    } else {
      setActualHabitModalMode("new");
      setActualHabitTypeId((prev) => (prev && habits.some((h) => h.id === prev) ? prev : habits[0]?.id ?? ""));
    }
    setActualHabitModalOpen(true);
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    try {
      interactionRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }

    const startRaw = dragStartMinRef.current;
    const wasPast = dragInPast;
    dragStartMinRef.current = null;
    setDragStartMin(null);
    setDragCurrentMin(null);
    setDragInPast(false);

    if (startRaw === null) return;

    const endRaw = getMinutesFromClientY(event.clientY);
    const { start, end } = normalizeDragRange(startRaw, endRaw);

    if (wasPast) {
      openActualHabitModal(minutesToHHMM(start), minutesToHHMM(end));
    } else {
      openBlockModal(minutesToHHMM(start), minutesToHHMM(end));
    }
  }

  useEffect(() => {
    if (!blockModalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setBlockModalOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [blockModalOpen]);

  useEffect(() => {
    if (!habitsModalOpen) setHabitNameEdit(null);
  }, [habitsModalOpen]);

  useEffect(() => {
    if (!habitsModalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setHabitsModalOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [habitsModalOpen]);

  async function handleConfirmBlock(event: FormEvent) {
    event.preventDefault();
    await onCreateBlock({
      startAt: toIsoFromDateAndTime(selectedDate, startTime),
      endAt: toIsoFromDateAndTime(selectedDate, endTime),
      entryType,
      taskId: entryType === "task" ? taskId || null : null,
      habitTypeId: entryType === "habit" ? habitTypeId || null : null,
    });
    setBlockModalOpen(false);
  }

  useEffect(() => {
    if (!actualHabitModalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setActualHabitModalOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actualHabitModalOpen]);

  async function handleConfirmActualHabit(event: FormEvent) {
    event.preventDefault();
    if (!actualHabitTypeId || !actualDescription.trim()) return;
    await onCreateActualHabit({
      startAt: toIsoFromDateAndTime(selectedDate, actualStartTime),
      endAt: toIsoFromDateAndTime(selectedDate, actualEndTime),
      habitTypeId: actualHabitTypeId,
      description: actualDescription.trim(),
      plannedBlockId: actualHabitPlannedBlockId,
    });
    setActualHabitModalOpen(false);
  }

  function openEditBlockModal(block: BlockLayout) {
    setEditBlockId(block.id);
    setEditBlockEntryType(block.entry_type);
    setEditBlockTaskId(block.task_id ?? "");
    setEditBlockHabitTypeId(block.habit_type_id ?? "");
  }

  async function handleSaveEditBlock(event: FormEvent) {
    event.preventDefault();
    if (!editBlockId) return;
    const patch: { taskId?: string | null; habitTypeId?: string | null } = {};
    const block = timeBlocks.find((b) => b.id === editBlockId);
    if (!block) return;
    if (editBlockEntryType === "task") {
      if (editBlockTaskId !== (block.task_id ?? "")) {
        patch.taskId = editBlockTaskId || null;
      }
    } else {
      if (editBlockHabitTypeId !== (block.habit_type_id ?? "")) {
        patch.habitTypeId = editBlockHabitTypeId || null;
      }
    }
    if (Object.keys(patch).length > 0) {
      await onPatchBlock(editBlockId, patch);
    }
    setEditBlockId(null);
  }

  useEffect(() => {
    if (!editBlockId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setEditBlockId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editBlockId]);

  function openEditActualModal(block: ActualBlockLayout) {
    setEditActualId(block.id);
    setEditActualDescription(block.description);
  }

  async function handleSaveEditActual(event: FormEvent) {
    event.preventDefault();
    if (!editActualId) return;
    const trimmed = editActualDescription.trim();
    if (!trimmed) return;
    const block = actualHabitBlocks.find((b) => b.id === editActualId);
    if (block && trimmed !== block.description) {
      await onPatchActualHabit(editActualId, { description: trimmed });
    }
    setEditActualId(null);
  }

  useEffect(() => {
    if (!editActualId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setEditActualId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editActualId]);

  async function handleCreateHabitType(event: FormEvent) {
    event.preventDefault();
    if (!newHabitName.trim()) return;
    await onCreateHabitType({ name: newHabitName.trim(), color: newHabitColor });
    setNewHabitName("");
    setNewHabitColor(null);
  }

  useEffect(() => {
    if (habitsModalOpen) setNewHabitColor(null);
  }, [habitsModalOpen]);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 w-180">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Calendario</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSyncActualTasks}
            disabled={syncingActualTasks}
            title="Sincronizar tiempos reales"
            className="shrink-0 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <span className={syncingActualTasks ? "inline-block animate-spin" : ""}>⟳</span>{" "}
            Sincronizar
          </button>
          <button
            type="button"
            onClick={() => setHabitsModalOpen(true)}
            className="shrink-0 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Hábitos
          </button>
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-100 dark:border-zinc-800/80">
        <div
          ref={timelineRef}
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain bg-zinc-50/50 dark:bg-zinc-900/30 pt-5"
        >
          <div
            ref={timelineContentRef}
            className="relative w-full"
            style={{ height: TIMELINE_CONTENT_HEIGHT }}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={`half-${h}`}
                className="pointer-events-none absolute left-0 right-0 border-t border-zinc-100 dark:border-zinc-800/50"
                style={{ top: `${((h + 0.5) / 24) * 100}%` }}
                aria-hidden
              />
            ))}
            {Array.from({ length: 24 }, (_, i) => i).map((hour) => (
              <div
                key={hour}
                className="pointer-events-none absolute left-0 right-0 border-t border-zinc-200/80 dark:border-zinc-700/60"
                style={{ top: `${(hour / 24) * 100}%` }}
              >
                <span className="absolute -translate-y-1/2 pl-2 pr-1.5 text-[10px] tabular-nums text-zinc-400 dark:text-zinc-500">
                  {hourRulerLabel(hour)}
                </span>
              </div>
            ))}

          {(isPastDay || nowMinutes !== null) ? (
            <div
              className="pointer-events-none absolute left-0 right-0 top-0 z-[3] bg-zinc-400/[0.06] dark:bg-zinc-400/[0.08]"
              style={{
                height: isPastDay ? "100%" : `${(nowMinutes! / MINUTES_DAY) * 100}%`,
              }}
              aria-hidden
            />
          ) : null}
          {nowMinutes !== null ? (
            <div
              className="pointer-events-none absolute left-0 right-0 z-[4] flex items-center"
              style={{ top: `${(nowMinutes / MINUTES_DAY) * 100}%` }}
              aria-hidden
            >
              <span className="ml-1 h-2 w-2 shrink-0 rounded-full bg-red-400 dark:bg-red-500" />
              <span className="h-px flex-1 bg-red-400 dark:bg-red-500" />
            </div>
          ) : null}

          <div
            ref={interactionRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className="absolute left-16 right-2 top-0 z-[5] h-full touch-none select-none"
            style={{ cursor: "crosshair" }}
            aria-label="Arrastra para seleccionar intervalo de tiempo"
          />

          {previewStyle ? (
            <div
              className={`pointer-events-none absolute z-[6] rounded-lg border-2 border-dashed ${
                dragInPast
                  ? "border-emerald-400 bg-emerald-100/30 dark:bg-emerald-900/20"
                  : "border-violet-400 bg-violet-100/30 dark:bg-violet-900/20"
              }`}
              style={{
                top: `${previewStyle.top}%`,
                height: `${previewStyle.height}%`,
                left: dragInPast ? "55%" : undefined,
                right: dragInPast ? "2px" : undefined,
                ...(dragInPast ? {} : { left: "4rem", right: "0.5rem" }),
              }}
            />
          ) : null}

          {blocks.map((block) => {
            const linkedTask =
              block.entry_type === "task" && block.task_id
                ? taskById.get(block.task_id)
                : null;
            const tint =
              block.entry_type === "task"
                ? (linkedTask?.task_type?.color ?? null)
                : (block.habit_type?.color ?? null);
            const dragging = blockDragPreview?.id === block.id;
            const startIso = isoFromDayMinutes(selectedDate, block.startMin);
            const endIso = isoFromDayMinutes(selectedDate, block.endMin);
            const isPast = isPastDay || (nowMinutes !== null && block.endMin <= nowMinutes);
            const canAdjust = !isTempId(block.id) && !isPast;
            const durationMin = block.endMin - block.startMin;
            const pastShortHabit =
              isPast &&
              block.entry_type === "habit" &&
              Boolean(block.habit_type_id) &&
              durationMin < PAST_HABIT_COMPACT_MAX_MIN;

            const shellClass = `group absolute left-16 right-2 z-10 text-xs shadow-sm transition-opacity ${
              tint
                ? "border-black/10 text-zinc-800 dark:border-white/10 dark:text-zinc-100"
                : "border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-900/40 dark:text-violet-100"
            } ${dragging ? "z-20 ring-2 ring-violet-400 ring-offset-1 dark:ring-offset-zinc-950" : ""} ${isPast ? "pointer-events-none opacity-50" : ""}`;

            const completarBtn = (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openActualHabitModal(
                    minutesToHHMM(block.startMin),
                    minutesToHHMM(block.endMin),
                    block.id,
                    block.habit_type_id!,
                  );
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="pointer-events-auto shrink-0 rounded px-1 py-0.5 text-[10px] font-medium text-emerald-600/90 transition-colors hover:text-emerald-600 dark:text-emerald-400/90 dark:hover:text-emerald-400"
              >
                completar
              </button>
            );

            if (pastShortHabit) {
              const centerTopPct = ((block.startMin + block.endMin) / 2 / MINUTES_DAY) * 100;
              return (
                <div
                  key={block.id}
                  data-time-block
                  className={`${shellClass} flex flex-row items-center gap-2 overflow-visible rounded-lg border px-2.5 py-1`}
                  style={{
                    top: `${centerTopPct}%`,
                    transform: "translateY(-50%)",
                    height: "auto",
                    ...(tint ? { backgroundColor: plannerTintBackground(tint) } : {}),
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium leading-tight">{block.habit_type?.name}</p>
                    <p className="text-[10px] opacity-70">
                      {clock(startIso)} – {clock(endIso)}
                    </p>
                  </div>
                  {completarBtn}
                </div>
              );
            }

            return (
              <div
                key={block.id}
                data-time-block
                className={`${shellClass} flex flex-col overflow-hidden rounded-lg border`}
                style={{
                  top: `${block.top}%`,
                  height: `${block.height}%`,
                  ...(tint ? { backgroundColor: plannerTintBackground(tint) } : {}),
                }}
              >
                {canAdjust ? (
                  <button
                    type="button"
                    aria-label="Estirar inicio"
                    className="h-1.5 w-full shrink-0 cursor-ns-resize touch-none bg-black/[0.04] hover:bg-black/[0.08] dark:bg-white/[0.06] dark:hover:bg-white/[0.12]"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      beginBlockAdjust(block, "resize-top", e.clientY);
                    }}
                  />
                ) : (
                  <div className="h-0.5 shrink-0" aria-hidden />
                )}
                <div
                  className={`relative flex min-h-0 flex-1 flex-col px-2.5 py-1 ${canAdjust ? "cursor-grab active:cursor-grabbing" : ""}`}
                  onPointerDown={(e) => {
                    if (!canAdjust) return;
                    if ((e.target as HTMLElement).closest("button")) return;
                    e.stopPropagation();
                    beginBlockAdjust(block, "move", e.clientY);
                  }}
                >
                  <div
                    className={
                      isPast && block.entry_type === "habit" && block.habit_type_id ? "pr-[4.25rem]" : undefined
                    }
                  >
                    <div className="flex items-start justify-between gap-1">
                      <p className="min-w-0 truncate font-medium leading-tight">
                        {block.entry_type === "task"
                          ? (linkedTask?.title ?? "Tarea")
                          : block.habit_type?.name}
                      </p>
                      {canAdjust ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditBlockModal(block);
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="shrink-0 rounded p-0.5 text-[10px] leading-none opacity-0 transition-opacity group-hover:opacity-70 hover:!opacity-100"
                          aria-label="Editar asignación"
                        >
                          ✎
                        </button>
                      ) : null}
                    </div>
                    <p className="text-[10px] opacity-70">
                      {clock(startIso)} – {clock(endIso)}
                    </p>
                  </div>
                  {!isPast ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteBlock(block.id);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="mt-auto self-start text-[10px] text-rose-600/80 transition-colors hover:text-rose-600 dark:text-rose-400/80"
                    >
                      quitar
                    </button>
                  ) : null}
                  {isPast && block.entry_type === "habit" && block.habit_type_id ? (
                    <div className="pointer-events-none absolute inset-y-0 right-2 z-[1] flex items-center">
                      <div className="pointer-events-auto">{completarBtn}</div>
                    </div>
                  ) : null}
                </div>
                {canAdjust ? (
                  <button
                    type="button"
                    aria-label="Estirar fin"
                    className="h-1.5 w-full shrink-0 cursor-ns-resize touch-none bg-black/[0.04] hover:bg-black/[0.08] dark:bg-white/[0.06] dark:hover:bg-white/[0.12]"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      beginBlockAdjust(block, "resize-bottom", e.clientY);
                    }}
                  />
                ) : (
                  <div className="h-1 shrink-0" aria-hidden />
                )}
              </div>
            );
          })}

          {actualBlocks.map((block) => {
            const tint = block.habit_type?.color ?? null;
            const dragging = actualBlockDragPreview?.id === block.id;
            const startIso = isoFromDayMinutes(selectedDate, block.startMin);
            const endIso = isoFromDayMinutes(selectedDate, block.endMin);
            const canAdjustActual = !isTempId(block.id);
            const durationMin = block.endMin - block.startMin;
            /** Un solo paso de rejilla (15 min): dibujar como línea + fila de texto para que se lea. */
            const isLineMode = durationMin <= SNAP_MINUTES;

            const shellClass = `group/actual absolute z-[11] text-xs shadow-sm ${
              tint
                ? "border-black/20 text-zinc-800 dark:border-white/20 dark:text-zinc-100"
                : "border-emerald-300 text-emerald-900 dark:border-emerald-700 dark:text-emerald-100"
            } ${dragging ? "z-20 ring-2 ring-emerald-400 ring-offset-1 dark:ring-offset-zinc-950" : ""}`;

            if (isLineMode) {
              const centerTopPct = ((block.startMin + block.endMin) / 2 / MINUTES_DAY) * 100;
              return (
                <div
                  key={`actual-${block.id}`}
                  data-actual-block
                  className={`${shellClass} flex flex-col overflow-visible rounded-sm border border-dashed ${
                    tint ? "" : "bg-emerald-500/[0.07] dark:bg-emerald-400/[0.08]"
                  }`}
                  style={{
                    top: `${centerTopPct}%`,
                    transform: "translateY(-50%)",
                    left: "55%",
                    right: "2px",
                    height: "auto",
                    ...(tint ? { backgroundColor: plannerTintBackground(tint, 0.2) } : {}),
                  }}
                >
                  {canAdjustActual ? (
                    <button
                      type="button"
                      aria-label="Estirar inicio"
                      className="h-0.5 w-full shrink-0 cursor-ns-resize touch-none bg-zinc-400/20 hover:bg-zinc-400/40 dark:bg-zinc-500/25 dark:hover:bg-zinc-500/45"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        beginActualBlockAdjust(block, "resize-top", e.clientY);
                      }}
                    />
                  ) : null}
                  <div
                    className={`flex items-center gap-1.5 px-1.5 py-px leading-none ${canAdjustActual ? "cursor-grab active:cursor-grabbing" : ""}`}
                    onPointerDown={(e) => {
                      if (!canAdjustActual) return;
                      if ((e.target as HTMLElement).closest("button")) return;
                      e.stopPropagation();
                      beginActualBlockAdjust(block, "move", e.clientY);
                    }}
                  >
                    <span
                      className={`h-px min-w-[1.25rem] shrink-0 rounded-full ${
                        tint ? "" : "bg-emerald-500 dark:bg-emerald-400"
                      }`}
                      style={tint ? { backgroundColor: plannerTintBackground(tint, 0.9) } : undefined}
                      aria-hidden
                    />
                    <span className="text-[9px] font-semibold uppercase tracking-wide opacity-55">Real</span>
                    <span
                      className="min-w-0 max-w-[40%] truncate text-[10px] font-medium"
                      title={block.description ? `${block.habit_type?.name ?? ""} — ${block.description}` : block.habit_type?.name}
                    >
                      {block.habit_type?.name}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums opacity-65">
                      {clock(startIso)}–{clock(endIso)}
                    </span>
                    <span className="h-px min-w-0 flex-1 rounded-full bg-current opacity-20" aria-hidden />
                    {canAdjustActual ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditActualModal(block);
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="shrink-0 rounded p-0.5 text-[10px] leading-none text-zinc-500 opacity-0 transition-opacity group-hover/actual:opacity-70 hover:!opacity-100 dark:text-zinc-400"
                        aria-label="Editar descripción"
                      >
                        ✎
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteActualHabit(block.id);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="shrink-0 rounded p-0.5 text-[10px] leading-none text-rose-600/80 opacity-0 transition-opacity group-hover/actual:opacity-70 hover:!opacity-100 dark:text-rose-400/80"
                      aria-label="Quitar hábito real"
                    >
                      ×
                    </button>
                  </div>
                  {canAdjustActual ? (
                    <button
                      type="button"
                      aria-label="Estirar fin"
                      className="h-0.5 w-full shrink-0 cursor-ns-resize touch-none bg-zinc-400/20 hover:bg-zinc-400/40 dark:bg-zinc-500/25 dark:hover:bg-zinc-500/45"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        beginActualBlockAdjust(block, "resize-bottom", e.clientY);
                      }}
                    />
                  ) : null}
                </div>
              );
            }

            return (
              <div
                key={`actual-${block.id}`}
                data-actual-block
                className={`${shellClass} flex flex-col overflow-hidden rounded-lg border-2 border-dashed ${
                  tint ? "" : "bg-emerald-50 dark:bg-emerald-900/40"
                }`}
                style={{
                  top: `${block.top}%`,
                  height: `${block.height}%`,
                  left: "55%",
                  right: "2px",
                  ...(tint ? { backgroundColor: plannerTintBackground(tint, 0.65) } : {}),
                }}
              >
                {canAdjustActual ? (
                  <button
                    type="button"
                    aria-label="Estirar inicio"
                    className="h-1.5 w-full shrink-0 cursor-ns-resize touch-none bg-black/[0.04] hover:bg-black/[0.08] dark:bg-white/[0.06] dark:hover:bg-white/[0.12]"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      beginActualBlockAdjust(block, "resize-top", e.clientY);
                    }}
                  />
                ) : (
                  <div className="h-0.5 shrink-0" aria-hidden />
                )}
                <div
                  className={`flex min-h-0 flex-1 flex-col px-2 py-1 ${canAdjustActual ? "cursor-grab active:cursor-grabbing" : ""}`}
                  onPointerDown={(e) => {
                    if (!canAdjustActual) return;
                    if ((e.target as HTMLElement).closest("button")) return;
                    e.stopPropagation();
                    beginActualBlockAdjust(block, "move", e.clientY);
                  }}
                >
                  <div className="flex items-start justify-between gap-1">
                    <div className="flex min-w-0 items-center gap-1">
                      <span className="text-[9px] font-semibold uppercase tracking-wider opacity-60">Real</span>
                      <p className="truncate font-medium leading-tight">{block.habit_type?.name}</p>
                    </div>
                    {canAdjustActual ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditActualModal(block);
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="shrink-0 rounded p-0.5 text-[10px] leading-none opacity-0 transition-opacity group-hover/actual:opacity-70 hover:!opacity-100"
                        aria-label="Editar descripción"
                      >
                        ✎
                      </button>
                    ) : null}
                  </div>
                  <p className="text-[10px] opacity-70">
                    {clock(startIso)} – {clock(endIso)}
                  </p>
                  {block.description ? (
                    <p className="mt-0.5 truncate text-[10px] italic opacity-80">{block.description}</p>
                  ) : null}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteActualHabit(block.id);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="mt-auto self-start text-[10px] text-rose-600/80 transition-colors hover:text-rose-600 dark:text-rose-400/80"
                  >
                    quitar
                  </button>
                </div>
                {canAdjustActual ? (
                  <button
                    type="button"
                    aria-label="Estirar fin"
                    className="h-1.5 w-full shrink-0 cursor-ns-resize touch-none bg-black/[0.04] hover:bg-black/[0.08] dark:bg-white/[0.06] dark:hover:bg-white/[0.12]"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      beginActualBlockAdjust(block, "resize-bottom", e.clientY);
                    }}
                  />
                ) : (
                  <div className="h-1 shrink-0" aria-hidden />
                )}
              </div>
            );
          })}

          {actualTaskBlockLayouts.map((block) => {
            const startIso = isoFromDayMinutes(selectedDate, block.startMin);
            const endIso = isoFromDayMinutes(selectedDate, block.endMin);
            const label = block.task?.title ?? block.rize_title;
            const isMatched = block.planned_block_id !== null;
            const pts = block.points_completed ?? 0;
            return (
              <div
                key={`actual-task-${block.id}`}
                data-actual-block
                className="group/actual absolute z-[11] flex flex-col overflow-hidden rounded-lg border-2 border-dashed border-black/20 text-xs text-zinc-800 shadow-sm dark:border-white/20 dark:text-zinc-100"
                style={{
                  top: `${block.top}%`,
                  height: `${block.height}%`,
                  left: "55%",
                  right: "2px",
                  backgroundColor: plannerTintBackground(RIZE_ACTUAL_TASK_COLOR, 0.65),
                }}
              >
                <div className="h-0.5 shrink-0" aria-hidden />
                <div className="flex min-h-0 flex-1 flex-col px-2 py-1">
                  <div className="flex items-start justify-between gap-1">
                    <div className="flex min-w-0 items-center gap-1">
                      <span className={`text-[9px] font-semibold uppercase tracking-wider ${isMatched ? "opacity-60" : "opacity-80"}`}>
                        {isMatched ? "Real" : "Extra"}
                      </span>
                      <p className="truncate font-medium leading-tight">{label}</p>
                    </div>
                    {pts > 0 ? (
                      <span
                        className="shrink-0 rounded-full bg-black/15 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums dark:bg-white/20"
                        title={`${pts} puntos imputados en este bloque`}
                      >
                        +{pts} pts
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[10px] opacity-70">
                    {clock(startIso)} – {clock(endIso)}
                  </p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteActualTask(block.id);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="mt-auto self-start text-[10px] text-rose-600/80 transition-colors hover:text-rose-600 dark:text-rose-400/80"
                  >
                    quitar
                  </button>
                </div>
                <div className="h-1 shrink-0" aria-hidden />
              </div>
            );
          })}
          </div>
        </div>
      </div>

      {blockModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setBlockModalOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="block-modal-title"
            className="relative z-10 w-full max-w-sm rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 id="block-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Nuevo bloque
              </h3>
              <button
                type="button"
                onClick={() => setBlockModalOpen(false)}
                className="rounded-md p-1 text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <form className="mt-4 grid gap-3" onSubmit={handleConfirmBlock}>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Inicio
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    step={60 * SNAP_MINUTES}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </label>
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Fin
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    step={60 * SNAP_MINUTES}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </label>
              </div>

              <select
                value={entryType}
                onChange={(event) => setEntryType(event.target.value as "task" | "habit")}
                className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-800 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              >
                <option value="task">Tarea</option>
                <option value="habit">Hábito</option>
              </select>

              {entryType === "task" ? (
                <select
                  value={taskId}
                  onChange={(event) => setTaskId(event.target.value)}
                  className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-800 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                >
                  <option value="">Selecciona tarea...</option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={habitTypeId}
                  onChange={(event) => setHabitTypeId(event.target.value)}
                  className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-800 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                >
                  <option value="">Selecciona hábito...</option>
                  {habits.map((habit) => (
                    <option key={habit.id} value={habit.id}>
                      {habit.name}
                    </option>
                  ))}
                </select>
              )}

              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setBlockModalOpen(false)}
                  className="rounded-lg border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-violet-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-violet-700 disabled:opacity-50 dark:bg-violet-500 dark:hover:bg-violet-600"
                >
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {actualHabitModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setActualHabitModalOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="actual-habit-modal-title"
            className="relative z-10 w-full max-w-sm rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 id="actual-habit-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                {actualHabitModalMode === "complete" ? "Completar hábito" : "Hábito realizado"}
              </h3>
              <button
                type="button"
                onClick={() => setActualHabitModalOpen(false)}
                className="rounded-md p-1 text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <form className="mt-4 grid gap-3" onSubmit={handleConfirmActualHabit}>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Inicio
                  <input
                    type="time"
                    value={actualStartTime}
                    onChange={(e) => setActualStartTime(e.target.value)}
                    step={60 * SNAP_MINUTES}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </label>
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Fin
                  <input
                    type="time"
                    value={actualEndTime}
                    onChange={(e) => setActualEndTime(e.target.value)}
                    step={60 * SNAP_MINUTES}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                </label>
              </div>

              <select
                value={actualHabitTypeId}
                onChange={(e) => setActualHabitTypeId(e.target.value)}
                disabled={actualHabitModalMode === "complete"}
                className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-800 shadow-sm disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              >
                <option value="">Selecciona hábito...</option>
                {habits.map((habit) => (
                  <option key={habit.id} value={habit.id}>
                    {habit.name}
                  </option>
                ))}
              </select>

              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Descripción
                <textarea
                  value={actualDescription}
                  onChange={(e) => setActualDescription(e.target.value)}
                  placeholder="¿Qué hiciste exactamente?"
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </label>

              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setActualHabitModalOpen(false)}
                  className="rounded-lg border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={!actualHabitTypeId || !actualDescription.trim()}
                  className="rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500 dark:hover:bg-emerald-600"
                >
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {editBlockId !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setEditBlockId(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-block-modal-title"
            className="relative z-10 w-full max-w-sm rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 id="edit-block-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Editar bloque
              </h3>
              <button
                type="button"
                onClick={() => setEditBlockId(null)}
                className="rounded-md p-1 text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <form className="mt-4 grid gap-3" onSubmit={handleSaveEditBlock}>
              {editBlockEntryType === "task" ? (
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Tarea asignada
                  <select
                    value={editBlockTaskId}
                    onChange={(e) => setEditBlockTaskId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-800 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                  >
                    <option value="">Selecciona tarea...</option>
                    {tasks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Hábito asignado
                  <select
                    value={editBlockHabitTypeId}
                    onChange={(e) => setEditBlockHabitTypeId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-800 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                  >
                    <option value="">Selecciona hábito...</option>
                    {habits.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditBlockId(null)}
                  className="rounded-lg border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-violet-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-violet-700 disabled:opacity-50 dark:bg-violet-500 dark:hover:bg-violet-600"
                >
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {editActualId !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setEditActualId(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-actual-modal-title"
            className="relative z-10 w-full max-w-sm rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <h3 id="edit-actual-modal-title" className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Editar descripción
              </h3>
              <button
                type="button"
                onClick={() => setEditActualId(null)}
                className="rounded-md p-1 text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <form className="mt-4 grid gap-3" onSubmit={handleSaveEditActual}>
              <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Descripción
                <textarea
                  value={editActualDescription}
                  onChange={(e) => setEditActualDescription(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </label>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditActualId(null)}
                  className="rounded-lg border border-zinc-200 px-3.5 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={!editActualDescription.trim()}
                  className="rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500 dark:hover:bg-emerald-600"
                >
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {habitsModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="presentation"
        >
          <button
            type="button"
            aria-label="Cerrar modal"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setHabitsModalOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="habits-modal-title"
            className="relative z-10 w-full max-w-md rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-950"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 id="habits-modal-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                Habitos predefinidos
              </h3>
              <button
                type="button"
                onClick={() => setHabitsModalOpen(false)}
                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                aria-label="Cerrar"
              >
                ×
              </button>
            </div>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Crea o elimina habitos. Se usan al asignar bloques de tipo habito.
            </p>
            <form className="mt-3 space-y-2" onSubmit={handleCreateHabitType}>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[12rem] flex-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  Nuevo habito
                  <input
                    value={newHabitName}
                    onChange={(event) => setNewHabitName(event.target.value)}
                    placeholder="Nombre..."
                    className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Color</span>
                  <KeepColorPickerDropdown
                    value={newHabitColor}
                    onChange={setNewHabitColor}
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
              {habits.length === 0 ? (
                <li className="text-sm text-zinc-500 dark:text-zinc-400">No hay habitos aun.</li>
              ) : null}
              {habits.map((habit) => (
                <li
                  key={habit.id}
                  className="group flex items-center gap-2 rounded-md border border-zinc-100 px-2 py-1.5 text-sm dark:border-zinc-800"
                >
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full border border-zinc-300 dark:border-zinc-600 ${
                      habit.color ? "" : "bg-zinc-200/80 dark:bg-zinc-700/80"
                    }`}
                    style={habit.color ? { backgroundColor: plannerTintBackground(habit.color) } : undefined}
                    aria-hidden
                  />
                  {habitNameEdit?.id === habit.id ? (
                    <input
                      autoFocus
                      value={habitNameEdit.name}
                      onChange={(e) =>
                        setHabitNameEdit({ id: habit.id, name: e.target.value })
                      }
                      onBlur={(e) => {
                        const draft = e.target.value.trim();
                        setHabitNameEdit(null);
                        if (draft && draft !== habit.name) {
                          void onPatchHabitType(habit.id, { name: draft });
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") {
                          setHabitNameEdit(null);
                          e.stopPropagation();
                        }
                      }}
                      className="min-w-0 flex-1 rounded border border-violet-400 bg-white px-2 py-0.5 text-sm dark:bg-zinc-900"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate font-medium">{habit.name}</span>
                  )}
                  <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                    {habitNameEdit?.id !== habit.id ? (
                      <button
                        type="button"
                        onClick={() => setHabitNameEdit({ id: habit.id, name: habit.name })}
                        className="rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                      >
                        Editar
                      </button>
                    ) : null}
                    <KeepColorPickerDropdown
                      value={habit.color}
                      onChange={(color) => void onPatchHabitType(habit.id, { color })}
                      size="sm"
                      align="right"
                    />
                    <button
                      type="button"
                      onClick={() => onDeleteHabitType(habit.id)}
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
