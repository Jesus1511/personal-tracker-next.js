"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  ANALYZABLE_TABLES,
  type AnalysisRecord,
  type AnalyzableTable,
  type PromptType,
} from "@/lib/gemini/types";
import { localDateString } from "@/lib/planner/date";

/** Prompt guardado en Supabase para reutilizar. */
type SavedPrompt = {
  id: string;
  label: string;
  prompt_text: string;
  created_at: string;
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function weekRange(): { start: string; end: string } {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: localDateString(monday), end: localDateString(sunday) };
}

const ALL_TABLES_SELECTED = new Set<AnalyzableTable>(
  ANALYZABLE_TABLES.map((t) => t.key),
);

const REVIEW_LABELS: Record<string, { text: string; cls: string }> = {
  pending: {
    text: "Pendiente",
    cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  },
  successful: {
    text: "Exitosa",
    cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  },
  failed: {
    text: "Fallida",
    cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  },
};

const STATUS_LABELS: Record<string, { text: string; cls: string }> = {
  completed: {
    text: "Completado",
    cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
  },
  failed: {
    text: "Error",
    cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
  },
};

const PROMPT_OPTIONS: { key: PromptType; label: string }[] = [
  { key: "summary", label: "Resumen" },
  { key: "recommendations", label: "Recomendaciones" },
  { key: "custom", label: "Personalizado" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function AnalysisPage() {
  const defaultRange = weekRange();

  // Config state
  const [dateStart, setDateStart] = useState(defaultRange.start);
  const [dateEnd, setDateEnd] = useState(defaultRange.end);
  const [selectedTables, setSelectedTables] = useState<Set<AnalyzableTable>>(
    () => new Set(ALL_TABLES_SELECTED),
  );
  const [customPrompt, setCustomPrompt] = useState("");
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Analysis state
  const [current, setCurrent] = useState<AnalysisRecord | null>(null);
  const [history, setHistory] = useState<AnalysisRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // Review state
  const [reviewNotes, setReviewNotes] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);

  // Saved prompts state
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [newPromptLabel, setNewPromptLabel] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);

  /* ------ Fetch saved prompts ------ */
  const loadPrompts = useCallback(async () => {
    try {
      const res = await fetch("/api/planner/ai-prompts");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Error loading prompts");
      setSavedPrompts(json.prompts as SavedPrompt[]);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    loadPrompts();
  }, [loadPrompts]);

  /* ------ Save current prompt ------ */
  async function handleSavePrompt() {
    const text = customPrompt.trim();
    const label = newPromptLabel.trim();
    if (!text || !label) return;
    setSavingPrompt(true);
    try {
      const res = await fetch("/api/planner/ai-prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, promptText: text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Error saving prompt");
      setSavedPrompts((prev) => [json.prompt as SavedPrompt, ...prev]);
      setNewPromptLabel("");
      setShowSaveForm(false);
    } catch (e) {
      console.error(e);
    } finally {
      setSavingPrompt(false);
    }
  }

  /* ------ Delete saved prompt ------ */
  async function handleDeletePrompt(id: string) {
    try {
      const res = await fetch(`/api/planner/ai-prompts/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Error deleting prompt");
      }
      setSavedPrompts((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      console.error(e);
    }
  }

  /* ------ Fetch history on mount ------ */
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/planner/ai-analysis?limit=30");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Error loading history");
      setHistory(json.analyses);
    } catch (e) {
      console.error(e);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  /* ------ Run analysis ------ */
  async function handleAnalyze() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/planner/ai-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dateStart,
          dateEnd,
          tables: [...selectedTables],
          promptType: "custom",
          customPrompt,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Error running analysis");

      const analysis: AnalysisRecord = json.analysis;
      setCurrent(analysis);
      setReviewNotes("");
      setHistory((prev) => [analysis, ...prev]);

      if (analysis.status === "failed") {
        setError(analysis.failure_reason ?? "La llamada a la IA falló.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }

  /* ------ Update review status ------ */
  async function handleReview(reviewStatus: "successful" | "failed") {
    if (!current) return;
    setReviewSaving(true);
    try {
      const res = await fetch(`/api/planner/ai-analysis/${current.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewStatus, reviewNotes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);

      const updated: AnalysisRecord = json.analysis;
      setCurrent(updated);
      setHistory((prev) =>
        prev.map((a) => (a.id === updated.id ? updated : a)),
      );
    } catch (e) {
      console.error(e);
    } finally {
      setReviewSaving(false);
    }
  }

  /* ------ Toggle table selection ------ */
  function toggleTable(t: AnalyzableTable) {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  /* ------ Select from history ------ */
  function selectHistory(a: AnalysisRecord) {
    setCurrent(a);
    setReviewNotes(a.review_notes ?? "");
    setError(
      a.status === "failed" ? a.failure_reason ?? "La llamada falló." : null,
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */
  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      {/* ==================== LEFT COLUMN — configuración prioritaria ==================== */}
      <aside className="flex w-full flex-col gap-5  from-zinc-200/60 to-zinc-300/40 p-4 shadow-[inset_-1px_0_0_0_rgba(0,0,0,0.08)]  dark:shadow-[inset_-1px_0_0_0_rgba(255,255,255,0.04)] lg:min-h-0 lg:w-[min(100%,28rem)] lg:max-w-xl lg:flex-shrink-0  xl:w-[min(100%,34rem)]">
        {/* ---- Config Panel ---- */}
        <section className="rounded-2xl border border-zinc-300/80 bg-zinc-100/95 p-4 shadow-sm ring-1 ring-zinc-900/10 dark:border-zinc-700/80 dark:bg-zinc-900/80 dark:ring-zinc-950/50">
          <div className="mb-4 flex items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              Configurar análisis
            </h2>
            <span className="text-[10px] font-medium uppercase tracking-wider text-violet-600 dark:text-violet-400">
              Paso a paso
            </span>
          </div>

          {/* Date range */}
          <div className="mb-4 flex gap-3">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Desde
              </span>
              <input
                type="date"
                value={dateStart}
                onChange={(e) => setDateStart(e.target.value)}
                className="rounded-lg border border-zinc-400/70 bg-zinc-200/80 px-2.5 py-2 text-sm shadow-sm dark:border-zinc-600 dark:bg-zinc-800/90"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Hasta
              </span>
              <input
                type="date"
                value={dateEnd}
                onChange={(e) => setDateEnd(e.target.value)}
                className="rounded-lg border border-zinc-400/70 bg-zinc-200/80 px-2.5 py-2 text-sm shadow-sm dark:border-zinc-600 dark:bg-zinc-800/90"
              />
            </label>
          </div>

          {/* Table selector */}
          <fieldset className="mb-5">
            <legend className="mb-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Datos a incluir
            </legend>
            <div className="flex flex-wrap gap-2">
              {ANALYZABLE_TABLES.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleTable(key)}
                  className={`rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    selectedTables.has(key)
                      ? "border-zinc-800 bg-zinc-800 text-zinc-100 shadow-sm dark:border-zinc-500 dark:bg-zinc-600 dark:text-zinc-100"
                      : "border-zinc-400/80 bg-zinc-200/70 text-zinc-700 hover:border-zinc-500 dark:border-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:border-zinc-500"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="mb-4">
            <label className="mb-2 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Instrucciones para la IA{" "}
              <span className="font-normal text-zinc-400 dark:text-zinc-500">
                (opcional)
              </span>
            </label>
            <textarea
              ref={promptTextareaRef}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={6}
              placeholder="Opcional: qué quieres que haga la IA con los datos. Vacío = resumen breve por defecto. Plantillas abajo."
              className="min-h-[8.5rem] w-full resize-y rounded-lg border border-zinc-400/70 bg-zinc-200/80 px-3 py-2.5 text-sm leading-relaxed shadow-sm placeholder:text-zinc-500 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500/25 dark:border-zinc-600 dark:bg-zinc-800/90 dark:placeholder:text-zinc-500 dark:focus:border-zinc-500"
            />

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                Plantillas:
              </span>
              {savedPrompts.length === 0 && !showSaveForm && (
                <span className="text-[10px] italic text-zinc-400 dark:text-zinc-500">
                  Sin plantillas guardadas
                </span>
              )}
              {savedPrompts.map((p) => (
                <span
                  key={p.id}
                  className="group relative inline-flex items-center"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setCustomPrompt(p.prompt_text);
                      queueMicrotask(() =>
                        promptTextareaRef.current?.focus(),
                      );
                    }}
                    title={p.prompt_text}
                    className="rounded-md border border-zinc-400/70 bg-zinc-200/90 px-2 py-0.5 pr-5 text-[10px] font-medium text-zinc-700 shadow-sm transition-colors hover:border-violet-400 hover:bg-violet-200/50 hover:text-violet-900 dark:border-zinc-600 dark:bg-zinc-800/90 dark:text-zinc-300 dark:hover:border-violet-600 dark:hover:bg-violet-950/50 dark:hover:text-violet-200"
                  >
                    {p.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeletePrompt(p.id)}
                    title="Borrar plantilla"
                    className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-[10px] leading-none text-zinc-500 opacity-0 transition-opacity hover:bg-red-200/60 hover:text-red-700 group-hover:opacity-100 dark:text-zinc-400 dark:hover:bg-red-900/40 dark:hover:text-red-300"
                  >
                    ×
                  </button>
                </span>
              ))}
              {!showSaveForm ? (
                <button
                  type="button"
                  disabled={!customPrompt.trim()}
                  onClick={() => setShowSaveForm(true)}
                  title={
                    customPrompt.trim()
                      ? "Guardar prompt actual"
                      : "Escribe algo primero"
                  }
                  className="rounded-md border border-dashed border-zinc-400 bg-zinc-100/60 px-2 py-0.5 text-[10px] font-medium text-zinc-600 shadow-sm transition-colors hover:border-emerald-500 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:border-emerald-500 dark:hover:text-emerald-400"
                >
                  + Guardar
                </button>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <input
                    type="text"
                    autoFocus
                    value={newPromptLabel}
                    onChange={(e) => setNewPromptLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleSavePrompt();
                      } else if (e.key === "Escape") {
                        setShowSaveForm(false);
                        setNewPromptLabel("");
                      }
                    }}
                    placeholder="Nombre"
                    maxLength={40}
                    className="w-24 rounded-md border border-zinc-400/70 bg-zinc-200/90 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-600 dark:bg-zinc-800/90 dark:text-zinc-200"
                  />
                  <button
                    type="button"
                    disabled={!newPromptLabel.trim() || savingPrompt}
                    onClick={handleSavePrompt}
                    className="rounded-md bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-40"
                  >
                    {savingPrompt ? "…" : "OK"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowSaveForm(false);
                      setNewPromptLabel("");
                    }}
                    className="rounded-md border border-zinc-400/70 px-1.5 py-0.5 text-[10px] text-zinc-600 hover:bg-zinc-300/50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800/70"
                  >
                    ✕
                  </button>
                </span>
              )}
            </div>
          </div>

          {/* Analyze button */}
          <button
            type="button"
            disabled={loading || selectedTables.size === 0}
            onClick={handleAnalyze}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-100 shadow-md transition-opacity hover:opacity-90 disabled:opacity-40 dark:bg-zinc-600 dark:text-zinc-100"
          >
            {loading ? (
              <>
                <Spinner />
                Analizando…
              </>
            ) : (
              "Analizar con IA"
            )}
          </button>
        </section>

        {/* ---- History ---- */}
        <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-zinc-300/80 bg-zinc-200/40 p-3 dark:border-zinc-800 dark:bg-zinc-900/50">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Historial
          </h2>

          <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto">
            {historyLoading && (
              <p className="py-4 text-center text-xs text-zinc-400">
                Cargando…
              </p>
            )}
            {!historyLoading && history.length === 0 && (
              <p className="py-4 text-center text-xs text-zinc-400">
                Sin análisis previos
              </p>
            )}
            {history.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => selectHistory(a)}
                className={`rounded-lg border p-2.5 text-left transition-colors ${
                  current?.id === a.id
                    ? "border-zinc-600 bg-zinc-300/50 dark:border-zinc-500 dark:bg-zinc-800/80"
                    : "border-zinc-300/90 bg-zinc-200/30 hover:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/30 dark:hover:border-zinc-500"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">
                    {a.date_start} → {a.date_end}
                  </span>
                  <Badge {...REVIEW_LABELS[a.review_status]} />
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <Badge
                    {...(PROMPT_OPTIONS.find((p) => p.key === a.prompt_type)
                      ? {
                          text:
                            PROMPT_OPTIONS.find(
                              (p) => p.key === a.prompt_type,
                            )!.label,
                          cls: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400",
                        }
                      : {
                          text: a.prompt_type,
                          cls: "bg-zinc-100 text-zinc-600",
                        })}
                  />
                  <Badge {...STATUS_LABELS[a.status]} />
                </div>
                <span className="mt-1 block text-[10px] text-zinc-400">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </section>
      </aside>

      {/* ==================== MAIN COLUMN — resultado más discreto ==================== */}
      <section className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-zinc-100/40 p-4 lg:p-5 dark:bg-zinc-950/50">
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col lg:max-w-xl xl:max-w-2xl">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Resultado
          </p>

          {/* Error banner */}
          {error && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </div>
          )}

          {/* Loading skeleton */}
          {loading && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12">
              <Spinner size={28} />
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Consultando a Gemini…
              </p>
            </div>
          )}

          {/* Empty state */}
          {!loading && !current && (
            <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-zinc-400/80 bg-zinc-200/35 px-4 py-10 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
              <div className="mb-2 text-3xl opacity-25">&#x1F9E0;</div>
              <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
                Sin resultado aún
              </h3>
              <p className="mt-1 max-w-xs text-xs leading-relaxed text-zinc-500 dark:text-zinc-500">
                Configura fechas, datos y tu pregunta a la izquierda; el análisis
                aparecerá aquí.
              </p>
            </div>
          )}

          {/* Response viewer */}
          {!loading && current && (
            <div className="flex flex-col gap-3 rounded-xl border border-zinc-300/90 bg-zinc-200/50 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              {/* Metadata bar */}
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200/80 pb-2.5 dark:border-zinc-800">
                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {current.date_start} → {current.date_end}
                </span>
                <Badge {...STATUS_LABELS[current.status]} />
                <Badge {...REVIEW_LABELS[current.review_status]} />
                <span className="ml-auto text-[10px] text-zinc-400">
                  {new Date(current.created_at).toLocaleString()}
                </span>
              </div>

              {/* Tables analyzed */}
              <div className="flex flex-wrap gap-1">
                {current.tables_analyzed.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  >
                    {ANALYZABLE_TABLES.find((at) => at.key === t)?.label ?? t}
                  </span>
                ))}
              </div>

              {/* Markdown response */}
              {current.response_text && (
                <article className="prose prose-sm prose-zinc max-w-none text-zinc-700 dark:prose-invert dark:text-zinc-300">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {current.response_text}
                  </ReactMarkdown>
                </article>
              )}

              {current.status === "failed" && current.failure_reason && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
                  <strong>Error:</strong> {current.failure_reason}
                </div>
              )}

              {/* Review controls */}
              <div className="mt-1 rounded-lg border border-zinc-200/90 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  Evaluar análisis
                </h4>

                <textarea
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  rows={2}
                  placeholder="Notas opcionales (ej: las recomendaciones fueron útiles, datos incompletos…)"
                  className="mb-3 w-full resize-y rounded-md border border-zinc-400/70 bg-zinc-200/80 px-3 py-2 text-sm placeholder:text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/90 dark:placeholder:text-zinc-500"
                />

                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={reviewSaving}
                    onClick={() => handleReview("successful")}
                    className="flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400 dark:hover:bg-emerald-900/40"
                  >
                    Exitosa
                  </button>
                  <button
                    type="button"
                    disabled={reviewSaving}
                    onClick={() => handleReview("failed")}
                    className="flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-40 dark:border-red-700 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-900/40"
                  >
                    Fallida
                  </button>
                </div>
              </div>
          </div>
        )}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Small presentational helpers                                      */
/* ------------------------------------------------------------------ */

function Badge({ text, cls }: { text: string; cls: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {text}
    </span>
  );
}

function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="animate-spin"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
