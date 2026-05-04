"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  ANALYZABLE_TABLES,
  type AnalysisRecord,
  type AnalyzableTable,
  filterAnalyzableTableKeys,
  labelAnalyzedTableKey,
  type PromptType,
} from "@/lib/gemini/types";
import {
  CLAUDE_MODEL_OPTIONS,
  DEFAULT_CLAUDE_MODEL_ID,
  isAllowedClaudeModelId,
} from "@/lib/gemini/claude-models";
import { localDateString } from "@/lib/planner/date";

/** Prompt guardado en Supabase para reutilizar. */
type SavedPrompt = {
  id: string;
  label: string;
  prompt_text: string;
  created_at: string;
};

type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const AI_ANALYSIS_CHAT_KEY = "planner:ai-analysis:chat-thread-v1";

type PersistedChatV1 = {
  v: 1;
  dateStart: string;
  dateEnd: string;
  tables: string[];
  model: string;
  messages: ChatMsg[];
  composerPrimed: boolean;
  chatDraft: string;
};

function newChatMsgId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function normalizeStoredChatMsg(raw: unknown, i: number): ChatMsg | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const role = o.role;
  const content = o.content;
  const id = o.id;
  if (role !== "user" && role !== "assistant") return null;
  if (typeof content !== "string") return null;
  return {
    id: typeof id === "string" && id.length > 0 ? id : `legacy-${i}-${role}`,
    role,
    content,
  };
}

const DEFAULT_CHAT_SEED =
  "Analiza estos datos brevemente en español (Markdown) según tu criterio de asistente de productividad.";

/** Primer turno del hilo: pregunta + respuesta del análisis (contexto para el chat). */
function initialThreadFromAnalysis(
  analysis: AnalysisRecord,
  userLine: string,
): ChatMsg[] {
  if (analysis.status !== "completed") return [];
  const reply = analysis.response_text?.trim();
  if (!reply) return [];
  const u =
    userLine.trim() ||
    analysis.prompt_text?.trim() ||
    DEFAULT_CHAT_SEED;
  return [
    { id: newChatMsgId(), role: "user", content: u },
    {
      id: newChatMsgId(),
      role: "assistant",
      content: analysis.response_text ?? "",
    },
  ];
}

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

const AI_ANALYSIS_LAST_QUERY_KEY = "planner:ai-analysis:last-query";

function persistLastAiQuery(
  dateStart: string,
  dateEnd: string,
  tables: Set<AnalyzableTable>,
  claudeModel: string,
) {
  try {
    const keys = filterAnalyzableTableKeys([...tables]);
    if (keys.length === 0) return;
    localStorage.setItem(
      AI_ANALYSIS_LAST_QUERY_KEY,
      JSON.stringify({
        dateStart,
        dateEnd,
        tables: keys,
        claudeModel,
      }),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

const USER_BUBBLE_MAX_LINES = 7;

function UserChatBubble({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [isLong, setIsLong] = useState(false);
  const pRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const el = pRef.current;
    if (!el) return;
    const fs = parseFloat(getComputedStyle(el).fontSize) || 14;
    const lhRaw = getComputedStyle(el).lineHeight;
    const lh =
      lhRaw === "normal" ? fs * 1.25 : parseFloat(lhRaw) || fs * 1.25;
    setIsLong(el.scrollHeight > USER_BUBBLE_MAX_LINES * lh + 1);
    setExpanded(false);
  }, [content]);

  return (
    <div className="rounded-lg border border-violet-300/70 bg-violet-50/95 px-3 py-2 text-sm text-zinc-800 shadow-sm dark:border-violet-800/70 dark:bg-violet-950/35 dark:text-zinc-200">
      <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400">
        Tú
      </span>
      <p
        ref={pRef}
        className={`break-words whitespace-pre-wrap leading-relaxed ${
          isLong && !expanded ? "line-clamp-7" : ""
        }`}
      >
        {content}
      </p>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-violet-600 underline-offset-2 hover:text-violet-800 hover:underline dark:text-violet-400 dark:hover:text-violet-300"
        >
          {expanded ? "Ver menos" : "Ver más"}
        </button>
      )}
    </div>
  );
}

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
  const [claudeModel, setClaudeModel] = useState(DEFAULT_CLAUDE_MODEL_ID);
  const [storageHydrated, setStorageHydrated] = useState(false);

  useEffect(() => {
    setSelectedTables((prev) => {
      const nextArr = filterAnalyzableTableKeys([...prev]);
      const sameLen = prev.size === nextArr.length;
      const allKept =
        sameLen && nextArr.every((t) => prev.has(t));
      if (allKept) return prev;
      return nextArr.length > 0
        ? new Set(nextArr)
        : new Set(ALL_TABLES_SELECTED);
    });
  }, []);

  const [customPrompt, setCustomPrompt] = useState("");
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Analysis state
  const [current, setCurrent] = useState<AnalysisRecord | null>(null);
  const [history, setHistory] = useState<AnalysisRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [deletingHistoryId, setDeletingHistoryId] = useState<string | null>(
    null,
  );

  // Saved prompts state
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [newPromptLabel, setNewPromptLabel] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);

  const previewTablesKey = useMemo(
    () => [...selectedTables].sort().join(","),
    [selectedTables],
  );
  const [previewJsonText, setPreviewJsonText] = useState<string | null>(null);
  const [previewRows, setPreviewRows] = useState<Record<string, number> | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatDraft, setChatDraft] = useState(DEFAULT_CHAT_SEED);
  const [chatSending, setChatSending] = useState(false);
  const [chatStreamingText, setChatStreamingText] = useState("");
  const [chatSendJson, setChatSendJson] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  /** Chat visible una vez que hay análisis completado o mensajes restaurados. */
  const hasChatSession =
    (current !== null && current.status !== "failed") ||
    chatMessages.length > 0 ||
    chatSending ||
    !!chatStreamingText;

  /* ------ localStorage: última query + hilo de chat (evita pisar chat al hidratar) ------ */
  useLayoutEffect(() => {
    if (storageHydrated) return;
    setStorageHydrated(true);

    let ds = defaultRange.start;
    let de = defaultRange.end;
    let model = DEFAULT_CLAUDE_MODEL_ID;
    let tables = filterAnalyzableTableKeys([...ALL_TABLES_SELECTED]);

    try {
      const rawQ = localStorage.getItem(AI_ANALYSIS_LAST_QUERY_KEY);
      if (rawQ) {
        const q = JSON.parse(rawQ) as {
          dateStart?: string;
          dateEnd?: string;
          tables?: string[];
          claudeModel?: string;
        };
        if (
          typeof q.dateStart === "string" &&
          q.dateStart.length > 0 &&
          typeof q.dateEnd === "string" &&
          q.dateEnd.length > 0
        ) {
          ds = q.dateStart;
          de = q.dateEnd;
        }
        const t = filterAnalyzableTableKeys(q.tables ?? []);
        if (t.length > 0) tables = t;
        if (
          typeof q.claudeModel === "string" &&
          isAllowedClaudeModelId(q.claudeModel)
        ) {
          model = q.claudeModel;
        }
      }
    } catch {
      /* ignore */
    }

    let messages: ChatMsg[] = [];
    let primed = false;
    let draft = DEFAULT_CHAT_SEED;

    try {
      const rawC = localStorage.getItem(AI_ANALYSIS_CHAT_KEY);
      if (rawC) {
        const data = JSON.parse(rawC) as PersistedChatV1;
        if (data.v === 1) {
          const wantKey = [...tables].sort().join(",");
          const gotKey = [...filterAnalyzableTableKeys(data.tables ?? [])]
            .sort()
            .join(",");
          if (
            data.dateStart === ds &&
            data.dateEnd === de &&
            data.model === model &&
            wantKey === gotKey
          ) {
            messages = (data.messages ?? [])
              .map((m, i) => normalizeStoredChatMsg(m, i))
              .filter((x): x is ChatMsg => x !== null);
            primed = data.composerPrimed ?? messages.length > 0;
            if (typeof data.chatDraft === "string") draft = data.chatDraft;
          }
        }
      }
    } catch {
      /* ignore */
    }

    setDateStart(ds);
    setDateEnd(de);
    setSelectedTables(new Set(tables));
    setClaudeModel(model);
    setChatMessages(messages);
    setChatDraft(draft);
  }, [storageHydrated, defaultRange.start, defaultRange.end]);

  useLayoutEffect(() => {
    if (!storageHydrated) return;
    const tables = filterAnalyzableTableKeys([...selectedTables]);
    if (tables.length === 0) {
      setChatMessages([]);
      setChatDraft(DEFAULT_CHAT_SEED);
      return;
    }
    try {
      const raw = localStorage.getItem(AI_ANALYSIS_CHAT_KEY);
      if (!raw) {
        setChatMessages([]);
        setChatDraft(DEFAULT_CHAT_SEED);
        return;
      }
      const data = JSON.parse(raw) as PersistedChatV1;
      if (data.v !== 1) return;
      const wantKey = [...tables].sort().join(",");
      const gotKey = [...filterAnalyzableTableKeys(data.tables ?? [])]
        .sort()
        .join(",");
      if (
        data.dateStart === dateStart &&
        data.dateEnd === dateEnd &&
        data.model === claudeModel &&
        wantKey === gotKey
      ) {
        const msgs = (data.messages ?? [])
          .map((m, i) => normalizeStoredChatMsg(m, i))
          .filter((x): x is ChatMsg => x !== null);
        setChatMessages(msgs);
        if (typeof data.chatDraft === "string") {
          setChatDraft(data.chatDraft);
        }
      } else {
        setChatMessages([]);
        setChatDraft(DEFAULT_CHAT_SEED);
      }
    } catch {
      /* ignore */
    }
  }, [storageHydrated, dateStart, dateEnd, claudeModel, previewTablesKey, selectedTables]);

  useEffect(() => {
    if (!storageHydrated) return;
    const tables = filterAnalyzableTableKeys([...selectedTables]);
    if (tables.length === 0) {
      try {
        localStorage.removeItem(AI_ANALYSIS_CHAT_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      const payload: PersistedChatV1 = {
        v: 1,
        dateStart,
        dateEnd,
        tables,
        model: claudeModel,
        messages: chatMessages,
        composerPrimed: chatMessages.length > 0,
        chatDraft,
      };
      localStorage.setItem(AI_ANALYSIS_CHAT_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }, [
    chatDraft,
    chatMessages,
    claudeModel,
    dateEnd,
    dateStart,
    previewTablesKey,
    selectedTables,
    storageHydrated,
  ]);

  /* ------ Chat scroll ------ */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, chatStreamingText]);

  useEffect(() => {
    if (selectedTables.size === 0) {
      setPreviewJsonText(null);
      setPreviewRows(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }

    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setPreviewLoading(true);
        setPreviewError(null);
        try {
          const params = new URLSearchParams({
            dateStart,
            dateEnd,
            tables: previewTablesKey,
          });
          const res = await fetch(
            `/api/planner/ai-analysis/preview?${params.toString()}`,
            { signal: ac.signal },
          );
          const json = (await res.json()) as {
            error?: string;
            payload?: unknown;
            rowsFetched?: Record<string, number>;
          };
          if (!res.ok) {
            throw new Error(json.error ?? `HTTP ${res.status}`);
          }
          setPreviewJsonText(JSON.stringify(json.payload, null, 2));
          setPreviewRows(json.rowsFetched ?? null);
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setPreviewJsonText(null);
          setPreviewRows(null);
          setPreviewError(e instanceof Error ? e.message : "Error de vista previa");
        } finally {
          if (!ac.signal.aborted) setPreviewLoading(false);
        }
      })();
    }, 400);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [dateStart, dateEnd, previewTablesKey, selectedTables.size]);

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
          model: claudeModel,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Error running analysis");

      const analysis: AnalysisRecord = json.analysis;
      setCurrent(analysis);
      setHistory((prev) => [analysis, ...prev]);
      persistLastAiQuery(dateStart, dateEnd, selectedTables, claudeModel);
      setChatMessages(initialThreadFromAnalysis(analysis, customPrompt));

      if (analysis.status === "failed") {
        setError(analysis.failure_reason ?? "La llamada a la IA falló.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }

  function handleNewChat() {
    setChatMessages(
      current?.status === "completed"
        ? initialThreadFromAnalysis(current, current.prompt_text)
        : [],
    );
    setChatStreamingText("");
    const seed = customPrompt.trim() || DEFAULT_CHAT_SEED;
    setChatDraft(seed);
    setError(null);
    try {
      localStorage.removeItem(AI_ANALYSIS_CHAT_KEY);
    } catch {
      /* ignore */
    }
  }

  /* ------ Streaming chat ------ */
  async function handleChatSend() {
    const text = chatDraft.trim();
    if (!text || chatSending) return;
    if (selectedTables.size === 0) return;

    const userMsg: ChatMsg = { id: newChatMsgId(), role: "user", content: text };
    const outbound: ChatMsg[] = [...chatMessages, userMsg];
    setChatMessages(outbound);
    setChatDraft("");
    setChatSending(true);
    setChatStreamingText("");
    try {
      const res = await fetch("/api/planner/ai-analysis/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dateStart,
          dateEnd,
          tables: [...selectedTables],
          messages: outbound.map(({ role, content }) => ({ role, content })),
          model: claudeModel,
          sendJson: chatSendJson,
        }),
      });

      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: unknown;
        };
        const msg =
          typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
        throw new Error(msg);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("Sin cuerpo de respuesta.");

      const dec = new TextDecoder();
      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        flushSync(() => {
          setChatStreamingText(acc);
        });
      }
      acc += dec.decode();

      const assistantMsg: ChatMsg = {
        id: newChatMsgId(),
        role: "assistant",
        content: acc,
      };
      setChatMessages((prev) => [...prev, assistantMsg]);
      setChatStreamingText("");
      persistLastAiQuery(dateStart, dateEnd, selectedTables, claudeModel);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error";
      setChatMessages((prev) => [
        ...prev,
        {
          id: newChatMsgId(),
          role: "assistant",
          content: `**Error:** ${msg}`,
        },
      ]);
      setChatStreamingText("");
    } finally {
      setChatSending(false);
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
    setChatMessages(
      a.status === "completed"
        ? initialThreadFromAnalysis(a, a.prompt_text)
        : [],
    );
    setChatStreamingText("");
    setChatDraft(DEFAULT_CHAT_SEED);
    setError(
      a.status === "failed" ? a.failure_reason ?? "La llamada falló." : null,
    );
  }

  async function deleteHistoryItem(id: string, e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (deletingHistoryId !== null) return;
    setDeletingHistoryId(id);
    try {
      const res = await fetch(`/api/planner/ai-analysis/${id}`, {
        method: "DELETE",
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setHistory((prev) => prev.filter((x) => x.id !== id));
      if (current?.id === id) {
        setCurrent(null);
        setChatMessages([]);
        setChatStreamingText("");
        setChatDraft(DEFAULT_CHAT_SEED);
        setError(null);
        try {
          localStorage.removeItem(AI_ANALYSIS_CHAT_KEY);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error ? err.message : "No se pudo eliminar el análisis.",
      );
    } finally {
      setDeletingHistoryId(null);
    }
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

          <details
            className="mb-5 rounded-xl border border-amber-200/80 bg-amber-50/50 p-3 dark:border-amber-900/50 dark:bg-amber-950/25"
          >
            <summary className="cursor-pointer select-none text-xs font-semibold text-amber-900 dark:text-amber-200">
              Vista previa del JSON que recibe Claude (por día + catálogos)
            </summary>
            <p className="mt-2 text-[10px] leading-relaxed text-amber-900/80 dark:text-amber-200/80">
              Mismo objeto que va dentro del bloque JSON del system prompt (chat
              y análisis). Cambia al tocar fechas o tablas.
            </p>
            {previewRows && (
              <div className="mt-2 flex flex-wrap gap-1">
                {Object.entries(previewRows).map(([k, n]) => (
                  <span
                    key={k}
                    className="rounded-md bg-amber-100/90 px-1.5 py-0.5 font-mono text-[10px] text-amber-950 dark:bg-amber-900/50 dark:text-amber-100"
                  >
                    {k}:{n}
                  </span>
                ))}
              </div>
            )}
            {previewLoading && (
              <p className="mt-2 text-[11px] text-amber-800/80 dark:text-amber-300/80">
                Cargando vista previa…
              </p>
            )}
            {previewError && (
              <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">
                {previewError}
              </p>
            )}
            {previewJsonText && !previewLoading && (
              <pre className="mt-2 max-h-[min(50vh,22rem)] overflow-auto rounded-lg border border-amber-200/60 bg-white/90 p-2 font-mono text-[10px] leading-snug text-zinc-800 dark:border-amber-900/40 dark:bg-zinc-950/80 dark:text-zinc-200">
                {previewJsonText}
              </pre>
            )}
          </details>

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
            <label className="mt-2 flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Modelo Claude
              </span>
              <select
                value={claudeModel}
                onChange={(e) => setClaudeModel(e.target.value)}
                className="rounded-lg border border-zinc-400/70 bg-zinc-200/80 px-2.5 py-2 text-sm shadow-sm dark:border-zinc-600 dark:bg-zinc-800/90"
              >
                {CLAUDE_MODEL_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label} ({o.id})
                  </option>
                ))}
              </select>
            </label>

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
            {history.map((a) => {
              const deleting = deletingHistoryId === a.id;
              return (
              <div
                key={a.id}
                className={`group relative flex rounded-lg border transition-colors ${
                  current?.id === a.id
                    ? "border-zinc-600 bg-zinc-300/50 dark:border-zinc-500 dark:bg-zinc-800/80"
                    : "border-zinc-300/90 bg-zinc-200/30 hover:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/30 dark:hover:border-zinc-500"
                } ${deleting ? "pointer-events-none" : ""}`}
              >
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => selectHistory(a)}
                  className="min-w-0 flex-1 p-2.5 pr-9 text-left disabled:cursor-wait"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">
                      {a.date_start} → {a.date_end}
                    </span>
                    <span className="text-[10px] text-zinc-400">
                      {new Date(a.created_at).toLocaleString()}
                    </span>
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
                </button>
                <button
                  type="button"
                  title="Eliminar del historial"
                  aria-label="Eliminar del historial"
                  disabled={deletingHistoryId !== null}
                  onClick={(e) => void deleteHistoryItem(a.id, e)}
                  className="absolute right-1.5 top-1.5 rounded-md p-1 text-[11px] font-medium text-red-600 opacity-0 shadow-sm ring-1 ring-zinc-300/80 transition-opacity hover:bg-red-50 focus:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-0 disabled:group-hover:opacity-0 dark:text-red-400 dark:ring-zinc-600 dark:hover:bg-red-950/50"
                >
                  ✕
                </button>
                {deleting && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-zinc-200/80 dark:bg-zinc-900/75">
                    <Spinner size={22} />
                  </div>
                )}
              </div>
              );
            })}
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
                Consultando a Claude…
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

          {/* Un bloque: metadatos + hilo (mismas burbujas para 1ª respuesta y siguientes) */}
          {!loading && current && current.status === "completed" && (
            <div className="flex flex-col gap-3 rounded-xl border border-zinc-300/90 bg-zinc-200/50 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200/80 pb-2.5 dark:border-zinc-800">
                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {current.date_start} → {current.date_end}
                </span>
                <Badge {...STATUS_LABELS[current.status]} />
                <span className="ml-auto text-[10px] text-zinc-400">
                  {new Date(current.created_at).toLocaleString()}
                </span>
              </div>

              <div className="flex flex-wrap gap-1">
                {current.tables_analyzed.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  >
                    {labelAnalyzedTableKey(t)}
                  </span>
                ))}
              </div>

              {hasChatSession && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200/80 pt-3 dark:border-zinc-800">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-400">
                      Conversación
                    </span>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setChatSendJson((v) => !v)}
                        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                          chatSendJson
                            ? "border-violet-500/70 bg-violet-100 text-violet-800 dark:border-violet-600 dark:bg-violet-950/60 dark:text-violet-300"
                            : "border-zinc-300 bg-zinc-100 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400"
                        }`}
                      >
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${chatSendJson ? "bg-violet-500" : "bg-zinc-400 dark:bg-zinc-500"}`}
                        />
                        Pasar JSON
                      </button>
                      {chatMessages.length > 2 && (
                        <button
                          type="button"
                          disabled={chatSending}
                          onClick={handleNewChat}
                          className="text-[11px] font-medium text-zinc-500 underline-offset-2 hover:text-violet-600 hover:underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-violet-300"
                        >
                          Nuevo chat
                        </button>
                      )}
                    </div>
                  </div>

                  {(chatMessages.length > 0 || chatSending || chatStreamingText) && (
                    <div className="space-y-2">
                      {chatMessages.map((m) =>
                        m.role === "user" ? (
                          <UserChatBubble key={m.id} content={m.content} />
                        ) : (
                          <div
                            key={m.id}
                            className="rounded-lg border border-zinc-200 bg-zinc-50/95 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/60"
                          >
                            <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                              Asistente
                            </span>
                            <article className="prose prose-sm prose-zinc max-w-none text-zinc-700 dark:prose-invert dark:text-zinc-300">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {m.content}
                              </ReactMarkdown>
                            </article>
                          </div>
                        ),
                      )}
                      {chatSending && !chatStreamingText && (
                        <div className="flex items-center gap-2 px-2 py-2 text-xs text-zinc-500">
                          <Spinner size={14} /> Generando…
                        </div>
                      )}
                      {chatStreamingText && (
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/60">
                          <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                            Asistente
                          </span>
                          <article className="prose prose-sm prose-zinc max-w-none text-zinc-700 opacity-95 dark:prose-invert dark:text-zinc-300">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {chatStreamingText}
                            </ReactMarkdown>
                          </article>
                        </div>
                      )}
                      <div ref={chatEndRef} />
                    </div>
                  )}

                  <textarea
                    rows={3}
                    value={chatDraft}
                    disabled={chatSending}
                    placeholder="Tu mensaje (Enter envía · Shift+Enter línea nueva)"
                    onChange={(e) => setChatDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" || e.shiftKey) return;
                      e.preventDefault();
                      void handleChatSend();
                    }}
                    className="w-full resize-y rounded-lg border border-zinc-400/70 bg-zinc-50/95 px-3 py-2 text-sm placeholder:text-zinc-500 disabled:opacity-55 dark:border-zinc-600 dark:bg-zinc-900/85 dark:placeholder:text-zinc-600"
                  />
                  <button
                    type="button"
                    disabled={
                      !chatDraft.trim() ||
                      chatSending ||
                      selectedTables.size === 0
                    }
                    onClick={() => void handleChatSend()}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white shadow-md hover:bg-violet-800 disabled:opacity-40 dark:bg-violet-600 dark:hover:bg-violet-500"
                  >
                    {chatSending ? (
                      <>
                        <Spinner size={16} /> Enviando…
                      </>
                    ) : (
                      "Enviar"
                    )}
                  </button>
                </>
              )}
            </div>
          )}

          {!loading && current && current.status === "failed" && (
            <div className="flex flex-col gap-3 rounded-xl border border-zinc-300/90 bg-zinc-200/50 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200/80 pb-2.5 dark:border-zinc-800">
                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {current.date_start} → {current.date_end}
                </span>
                <Badge {...STATUS_LABELS[current.status]} />
                <span className="ml-auto text-[10px] text-zinc-400">
                  {new Date(current.created_at).toLocaleString()}
                </span>
              </div>
              {current.failure_reason && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
                  <strong>Error:</strong> {current.failure_reason}
                </div>
              )}
            </div>
          )}

          {/* Hilo restaurado sin `current` (p. ej. recarga) */}
          {hasChatSession && !current && (
            <div className="mt-6 shrink-0 space-y-3 rounded-xl border border-zinc-300/90 bg-zinc-200/50 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-400">
                  Conversación
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setChatSendJson((v) => !v)}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                      chatSendJson
                        ? "border-violet-500/70 bg-violet-100 text-violet-800 dark:border-violet-600 dark:bg-violet-950/60 dark:text-violet-300"
                        : "border-zinc-300 bg-zinc-100 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400"
                    }`}
                  >
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${chatSendJson ? "bg-violet-500" : "bg-zinc-400 dark:bg-zinc-500"}`}
                    />
                    Pasar JSON
                  </button>
                  {chatMessages.length > 2 && (
                    <button
                      type="button"
                      disabled={chatSending}
                      onClick={handleNewChat}
                      className="text-[11px] font-medium text-zinc-500 underline-offset-2 hover:text-violet-600 hover:underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:text-violet-300"
                    >
                      Nuevo chat
                    </button>
                  )}
                </div>
              </div>

              {(chatMessages.length > 0 || chatSending || chatStreamingText) && (
                <div className="space-y-2">
                  {chatMessages.map((m) =>
                    m.role === "user" ? (
                      <UserChatBubble key={m.id} content={m.content} />
                    ) : (
                      <div
                        key={m.id}
                        className="rounded-lg border border-zinc-200 bg-zinc-50/95 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/60"
                      >
                        <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                          Asistente
                        </span>
                        <article className="prose prose-sm prose-zinc max-w-none text-zinc-700 dark:prose-invert dark:text-zinc-300">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {m.content}
                          </ReactMarkdown>
                        </article>
                      </div>
                    ),
                  )}
                  {chatSending && !chatStreamingText && (
                    <div className="flex items-center gap-2 px-2 py-2 text-xs text-zinc-500">
                      <Spinner size={14} /> Generando…
                    </div>
                  )}
                  {chatStreamingText && (
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50/95 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/60">
                      <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                        Asistente
                      </span>
                      <article className="prose prose-sm prose-zinc max-w-none text-zinc-700 opacity-95 dark:prose-invert dark:text-zinc-300">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {chatStreamingText}
                        </ReactMarkdown>
                      </article>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
              )}

              <textarea
                rows={3}
                value={chatDraft}
                disabled={chatSending}
                placeholder="Tu mensaje (Enter envía · Shift+Enter línea nueva)"
                onChange={(e) => setChatDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey) return;
                  e.preventDefault();
                  void handleChatSend();
                }}
                className="w-full resize-y rounded-lg border border-zinc-400/70 bg-zinc-50/95 px-3 py-2 text-sm placeholder:text-zinc-500 disabled:opacity-55 dark:border-zinc-600 dark:bg-zinc-900/85 dark:placeholder:text-zinc-600"
              />
              <button
                type="button"
                disabled={
                  !chatDraft.trim() ||
                  chatSending ||
                  selectedTables.size === 0
                }
                onClick={() => void handleChatSend()}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white shadow-md hover:bg-violet-800 disabled:opacity-40 dark:bg-violet-600 dark:hover:bg-violet-500"
              >
                {chatSending ? (
                  <>
                    <Spinner size={16} /> Enviando…
                  </>
                ) : (
                  "Enviar"
                )}
              </button>
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
