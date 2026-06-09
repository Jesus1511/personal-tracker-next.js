"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  CLAUDE_MODEL_OPTIONS,
  DEFAULT_CLAUDE_MODEL_ID,
  isAllowedClaudeModelId,
} from "@/lib/gemini/claude-models";
import type { PlanAction } from "@/lib/gemini/planner-tools";

// ── Types ────────────────────────────────────────────────────────────────────

type WriteMode = "plan" | "agent";
type ChatMsg = { id: string; role: "user" | "assistant"; content: string };
type ToolCallInfo = { name: string; input: Record<string, unknown> };

type ChatSummary = {
  id: string;
  created_at: string;
  updated_at: string;
  title: string;
  mode: WriteMode;
  model: string;
  message_count: number;
};

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Ahora";
  if (m < 60) return `Hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h}h`;
  return new Date(iso).toLocaleDateString("es", { day: "numeric", month: "short" });
}

function formatToolChip(t: ToolCallInfo): string {
  if (t.name === "query_table") {
    const i = t.input as { table?: string; date_start?: string; date_end?: string };
    return `${i.table ?? "tabla"}${i.date_start ? ` ${i.date_start}` : ""}`;
  }
  if (t.name === "query_lookup_catalogs") return "catálogos";
  if (t.name === "create_task") return `crear tarea "${(t.input.title as string) ?? ""}"`;
  if (t.name === "update_task") return "actualizar tarea";
  if (t.name === "delete_task") return "eliminar tarea";
  if (t.name === "create_time_block") {
    const i = t.input as { entry_type?: string; start_time?: string; end_time?: string };
    return `bloque ${i.entry_type ?? ""} ${i.start_time ?? ""}–${i.end_time ?? ""}`;
  }
  if (t.name === "delete_time_block") return "eliminar bloque";
  if (t.name === "apply_routine") return `aplicar rutina → ${(t.input.target_date as string) ?? ""}`;
  if (t.name === "set_daily_goal") return `meta ${(t.input.date as string) ?? ""}`;
  if (t.name === "update_ai_context") return "actualizar contexto";
  return t.name;
}

const TOOL_RE = /\x01TOOL:([^\n]*)\n/g;
const PLAN_RE = /\x01PLAN:([^\n]*)\n/g;
const EXEC_RE = /\x01EXEC:([^\n]*)\n/g;
const CTX_RE = /\x01CTX_UPDATED\n/g;

function stripStreamMarkers(raw: string): string {
  return raw
    .replace(TOOL_RE, "")
    .replace(PLAN_RE, "")
    .replace(EXEC_RE, "")
    .replace(CTX_RE, "");
}

// ── Status icons ─────────────────────────────────────────────────────────────

function PlanStatusIcon({ status }: { status: PlanAction["status"] }) {
  if (status === "pending") return <span className="text-zinc-400">○</span>;
  if (status === "running")
    return (
      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
    );
  if (status === "done") return <span className="text-emerald-500">✓</span>;
  return <span className="text-red-500">✗</span>;
}

// ── Main component ────────────────────────────────────────────────────────────

export function PlannerWidget() {
  const [open, setOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mode, setMode] = useState<WriteMode>("plan");
  const [model, setModel] = useState(DEFAULT_CLAUDE_MODEL_ID);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallInfo[]>([]);
  const [planActions, setPlanActions] = useState<PlanAction[]>([]);
  const [executing, setExecuting] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [aiContext, setAiContext] = useState("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const planActionsRef = useRef(planActions);
  planActionsRef.current = planActions;

  const isBusy = streaming || executing;
  const canSend = draft.trim().length > 0 && !isBusy;
  const pendingPlan = planActions.filter((a) => a.status === "pending");

  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 50);
  }, [open, currentChatId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamingText, streaming]);

  const loadAiContext = useCallback(async () => {
    try {
      const res = await fetch("/api/planner/scratchpad?id=ai_context");
      if (!res.ok) return;
      const data = (await res.json()) as { content?: string };
      setAiContext(typeof data.content === "string" ? data.content : "");
    } catch { /* ignore */ }
  }, []);

  const loadChats = useCallback(async () => {
    setChatsLoading(true);
    try {
      const res = await fetch("/api/planner/ai-planner/chats?limit=60");
      const json = (await res.json()) as { chats?: ChatSummary[] };
      if (res.ok) setChatList(json.chats ?? []);
    } catch { /* ignore */ } finally {
      setChatsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadAiContext();
      void loadChats();
    }
  }, [open, loadAiContext, loadChats]);

  const persistChat = useCallback(
    async (
      chatId: string,
      nextMessages: ChatMsg[],
      nextPlanActions: PlanAction[],
      nextMode = mode,
      nextModel = model,
    ) => {
      try {
        await fetch(`/api/planner/ai-planner/chats/${chatId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: nextMessages,
            plan_actions: nextPlanActions,
            mode: nextMode,
            model: nextModel,
          }),
        });
        void loadChats();
      } catch { /* ignore */ }
    },
    [loadChats, mode, model],
  );

  const ensureChatId = useCallback(
    async (firstUserText: string, initialMessages: ChatMsg[]): Promise<string> => {
      if (currentChatId) return currentChatId;

      const res = await fetch("/api/planner/ai-planner/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          model,
          messages: initialMessages,
          title: firstUserText.trim().split("\n")[0]?.slice(0, 54),
        }),
      });
      const json = (await res.json()) as { chat?: { id: string } };
      if (!res.ok || !json.chat?.id) throw new Error("No se pudo crear el chat");
      setCurrentChatId(json.chat.id);
      void loadChats();
      return json.chat.id;
    },
    [currentChatId, mode, model, loadChats],
  );

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || isBusy) return;

    const userMsg: ChatMsg = { id: uid(), role: "user", content: text };
    const outbound = [...messages, userMsg];
    setMessages(outbound);
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    setStreaming(true);
    setStreamingText("");
    setActiveToolCalls([]);
    setExecError(null);

    let chatId = currentChatId;
    let collectedPlanActions = [...planActionsRef.current];

    try {
      chatId = await ensureChatId(text, outbound);

      const res = await fetch("/api/planner/ai-planner/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: outbound.map(({ role, content }) => ({ role, content })),
          mode,
          model,
          aiContext: aiContext || undefined,
        }),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("Sin respuesta");
      const dec = new TextDecoder();
      let rawAcc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawAcc += dec.decode(value, { stream: true });

        const tools: ToolCallInfo[] = [];
        TOOL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TOOL_RE.exec(rawAcc)) !== null) {
          try { tools.push(JSON.parse(m[1]) as ToolCallInfo); } catch { /* skip */ }
        }

        PLAN_RE.lastIndex = 0;
        while ((m = PLAN_RE.exec(rawAcc)) !== null) {
          try {
            const action = JSON.parse(m[1]) as PlanAction;
            if (!collectedPlanActions.some((a) => a.id === action.id)) {
              collectedPlanActions = [...collectedPlanActions, action];
              flushSync(() => setPlanActions(collectedPlanActions));
            }
          } catch { /* skip */ }
        }

        if (CTX_RE.test(rawAcc)) void loadAiContext();

        flushSync(() => {
          if (tools.length > 0) setActiveToolCalls(tools);
          setStreamingText(stripStreamMarkers(rawAcc));
        });
      }

      rawAcc += dec.decode();
      const finalText = stripStreamMarkers(rawAcc).trim();
      const finalMessages: ChatMsg[] = [
        ...outbound,
        { id: uid(), role: "assistant", content: finalText },
      ];

      setMessages(finalMessages);
      setStreamingText("");
      setActiveToolCalls([]);

      if (chatId) {
        void persistChat(chatId, finalMessages, collectedPlanActions);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error";
      const errMessages: ChatMsg[] = [
        ...outbound,
        { id: uid(), role: "assistant", content: `**Error:** ${msg}` },
      ];
      setMessages(errMessages);
      setStreamingText("");
      setActiveToolCalls([]);
      if (chatId) void persistChat(chatId, errMessages, collectedPlanActions);
    } finally {
      setStreaming(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  async function executeAllPlan() {
    if (executing) return;
    setExecuting(true);
    setExecError(null);

    let nextActions = [...planActions];
    const pending = nextActions.filter((a) => a.status === "pending");

    for (const action of pending) {
      nextActions = nextActions.map((a) =>
        a.id === action.id ? { ...a, status: "running" as const } : a,
      );
      setPlanActions(nextActions);

      try {
        const opts: RequestInit = {
          method: action.method,
          headers: { "Content-Type": "application/json" },
        };
        if (action.method !== "DELETE" && action.method !== "GET") {
          opts.body = JSON.stringify(action.body);
        }

        const res = await fetch(action.endpoint, opts);
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }

        nextActions = nextActions.map((a) =>
          a.id === action.id ? { ...a, status: "done" as const } : a,
        );
        setPlanActions(nextActions);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Error";
        nextActions = nextActions.map((a) =>
          a.id === action.id ? { ...a, status: "error" as const, error: msg } : a,
        );
        setPlanActions(nextActions);
        setExecError(`Falló: ${action.label} — ${msg}`);
        break;
      }
    }

    if (currentChatId) {
      void persistChat(currentChatId, messages, nextActions);
    }
    setExecuting(false);
  }

  function clearPlan() {
    setPlanActions([]);
    setExecError(null);
    if (currentChatId) void persistChat(currentChatId, messages, []);
  }

  function startNewChat() {
    setCurrentChatId(null);
    setMessages([]);
    setDraft("");
    setStreamingText("");
    setActiveToolCalls([]);
    setPlanActions([]);
    setExecError(null);
    textareaRef.current?.focus();
  }

  async function selectChat(id: string) {
    if (id === currentChatId || isBusy) return;
    try {
      const res = await fetch(`/api/planner/ai-planner/chats/${id}`);
      const json = (await res.json()) as {
        chat?: {
          id: string;
          mode: WriteMode;
          model: string;
          messages: ChatMsg[];
          plan_actions: PlanAction[];
        };
      };
      if (!res.ok || !json.chat) return;

      setCurrentChatId(json.chat.id);
      setMessages(Array.isArray(json.chat.messages) ? json.chat.messages : []);
      setMode(json.chat.mode === "agent" ? "agent" : "plan");
      if (isAllowedClaudeModelId(json.chat.model)) setModel(json.chat.model);
      setPlanActions(
        Array.isArray(json.chat.plan_actions)
          ? json.chat.plan_actions.map((a) => ({ ...a, status: a.status ?? "pending" }))
          : [],
      );
      setDraft("");
      setStreamingText("");
      setActiveToolCalls([]);
      setExecError(null);
    } catch { /* ignore */ }
  }

  async function deleteChat(id: string, e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (deletingChatId) return;
    setDeletingChatId(id);
    try {
      await fetch(`/api/planner/ai-planner/chats/${id}`, { method: "DELETE" });
      setChatList((prev) => prev.filter((c) => c.id !== id));
      if (currentChatId === id) startNewChat();
    } catch { /* ignore */ } finally {
      setDeletingChatId(null);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-violet-600 text-white shadow-lg transition-all hover:scale-105 hover:bg-violet-700 active:scale-95 ${open ? "pointer-events-none opacity-0" : "opacity-100"}`}
        aria-label="Abrir planificador IA"
        title="Planificador IA"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6">
          <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
          <path d="M12 6v6l4 2" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]"
          onClick={() => setOpen(false)}
        />
      )}

      <div
        className={`fixed right-0 top-0 z-50 flex h-full w-full max-w-[min(960px,94vw)] flex-col bg-white shadow-2xl transition-transform duration-300 dark:bg-zinc-950 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex min-h-0 flex-1">
          {/* Chat history sidebar */}
          {sidebarOpen && (
            <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50 md:w-64">
              <div className="border-b border-zinc-200 p-3 dark:border-zinc-800">
                <button
                  onClick={startNewChat}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-3 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-violet-700"
                >
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                    <path d="M10 3a1 1 0 0 1 1 1v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H4a1 1 0 1 1 0-2h5V4a1 1 0 0 1 1-1z" />
                  </svg>
                  Nueva conversación
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-2">
                {chatsLoading && chatList.length === 0 && (
                  <p className="px-2 py-4 text-center text-xs text-zinc-400">Cargando…</p>
                )}
                {!chatsLoading && chatList.length === 0 && (
                  <p className="px-2 py-4 text-center text-xs text-zinc-400">Sin conversaciones aún</p>
                )}
                {chatList.map((c) => (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => void selectChat(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") void selectChat(c.id);
                    }}
                    className={`group mb-1 flex w-full cursor-pointer items-start gap-2 rounded-xl px-3 py-2.5 text-left transition ${
                      currentChatId === c.id
                        ? "bg-violet-100 dark:bg-violet-950/50"
                        : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                        {c.title}
                      </p>
                      <p className="mt-0.5 text-[11px] text-zinc-400">
                        {timeAgo(c.updated_at)} · {c.mode === "plan" ? "Plan" : "Agente"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => void deleteChat(c.id, e)}
                      disabled={deletingChatId === c.id}
                      className="shrink-0 rounded p-1 text-zinc-300 opacity-0 transition hover:text-red-500 group-hover:opacity-100 disabled:opacity-50"
                      title="Eliminar"
                    >
                      <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                        <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5zm1.5.75a1.25 1.25 0 0 0-1.25 1.25v.443a41.03 41.03 0 0 1 4.5 0V3.75a1.25 1.25 0 0 0-1.25-1.25h-2.5z" clipRule="evenodd" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </aside>
          )}

          {/* Main chat column */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Header */}
            <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <button
                onClick={() => setSidebarOpen((v) => !v)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                title={sidebarOpen ? "Ocultar historial" : "Mostrar historial"}
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                  <path fillRule="evenodd" d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75zm0 5.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75zm0 5.5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75z" clipRule="evenodd" />
                </svg>
              </button>

              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-xs font-bold text-white">
                IA
              </div>
              <span className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
                Planificador IA
              </span>

              <div className="ml-auto flex items-center gap-2">
                <div className="flex rounded-lg border border-zinc-200 p-0.5 text-sm dark:border-zinc-700">
                  <button
                    onClick={() => setMode("plan")}
                    className={`rounded-md px-3 py-1 font-medium transition-colors ${
                      mode === "plan"
                        ? "bg-violet-600 text-white"
                        : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                    }`}
                  >
                    Plan
                  </button>
                  <button
                    onClick={() => setMode("agent")}
                    className={`rounded-md px-3 py-1 font-medium transition-colors ${
                      mode === "agent"
                        ? "bg-violet-600 text-white"
                        : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                    }`}
                  >
                    Agente
                  </button>
                </div>

                <select
                  value={model}
                  onChange={(e) => {
                    if (isAllowedClaudeModelId(e.target.value)) setModel(e.target.value);
                  }}
                  className="rounded-lg border border-zinc-200 bg-transparent px-2 py-1 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
                >
                  {CLAUDE_MODEL_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>

                <button
                  onClick={() => setOpen(false)}
                  className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
                >
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 0 1 1.414 0L10 8.586l4.293-4.293a1 1 0 1 1 1.414 1.414L11.414 10l4.293 4.293a1 1 0 0 1-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 0 1-1.414-1.414L8.586 10 4.293 5.707a1 1 0 0 1 0-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>

            <div
              className={`shrink-0 px-4 py-2 text-sm ${
                mode === "plan"
                  ? "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
                  : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
              }`}
            >
              {mode === "plan"
                ? "Modo Plan: Claude propone acciones que tú ejecutas con un clic."
                : "Modo Agente: Claude ejecuta acciones directamente al decidirlas."}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-5">
              <div className="mx-auto max-w-3xl space-y-5">
                {messages.length === 0 && !streaming && (
                  <div className="flex flex-col items-center gap-4 py-16 text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-100 text-3xl dark:bg-violet-950/60">
                      {mode === "plan" ? "📋" : "⚡"}
                    </div>
                    <p className="text-base font-medium text-zinc-700 dark:text-zinc-300">
                      {mode === "plan" ? "¿Qué quieres planificar?" : "¿Qué quieres hacer?"}
                    </p>
                    <p className="max-w-md text-sm leading-relaxed text-zinc-400">
                      {mode === "plan"
                        ? "Describe tu objetivo y Claude preparará un plan con acciones concretas para que las revises."
                        : "Dile a Claude qué cambios hacer y los ejecutará de inmediato en tu planner."}
                    </p>
                  </div>
                )}

                {messages.map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className="flex justify-end">
                      <div className="max-w-[82%] rounded-2xl rounded-tr-sm bg-violet-600 px-4 py-3 text-[15px] text-white shadow-sm">
                        <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                      </div>
                    </div>
                  ) : (
                    <div key={m.id} className="flex gap-3">
                      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-[11px] font-bold text-white">
                        IA
                      </div>
                      <div className="max-w-[88%] rounded-2xl rounded-tl-sm border border-zinc-200 bg-white px-4 py-3 text-[15px] shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
                        <article className="prose prose-sm prose-zinc max-w-none dark:prose-invert">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                        </article>
                      </div>
                    </div>
                  ),
                )}

                {streaming && (
                  <div className="flex gap-3">
                    <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-[11px] font-bold text-white">
                      IA
                    </div>
                    <div className="max-w-[88%] space-y-2">
                      {activeToolCalls.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {activeToolCalls.map((t, i) => (
                            <span
                              key={i}
                              className="flex items-center gap-1 rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-700 dark:bg-violet-950/60 dark:text-violet-300"
                            >
                              🔧 {formatToolChip(t)}
                            </span>
                          ))}
                        </div>
                      )}
                      {streamingText ? (
                        <div className="rounded-2xl rounded-tl-sm border border-zinc-200 bg-white px-4 py-3 text-[15px] shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
                          <article className="prose prose-sm prose-zinc max-w-none dark:prose-invert">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
                          </article>
                        </div>
                      ) : (
                        <div className="flex w-20 items-center gap-1.5 rounded-2xl rounded-tl-sm border border-zinc-200 bg-white px-5 py-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
                          <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
                          <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
                          <span className="h-2.5 w-2.5 animate-bounce rounded-full bg-zinc-400" />
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Plan panel */}
            {mode === "plan" && planActions.length > 0 && (
              <div className="shrink-0 border-t border-zinc-200 dark:border-zinc-800">
                <div className="mx-auto flex max-w-3xl items-center justify-between px-5 pt-3 pb-1">
                  <span className="text-sm font-semibold text-zinc-600 dark:text-zinc-400">
                    Plan ({planActions.length})
                  </span>
                  <button
                    onClick={clearPlan}
                    disabled={executing}
                    className="text-sm text-zinc-400 hover:text-zinc-600 disabled:opacity-50"
                  >
                    Limpiar
                  </button>
                </div>
                <div className="mx-auto max-h-48 max-w-3xl overflow-y-auto px-5 pb-2">
                  {planActions.map((a) => (
                    <div
                      key={a.id}
                      className="mb-1.5 flex items-start gap-2 rounded-lg px-2 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    >
                      <span className="mt-0.5 shrink-0">
                        <PlanStatusIcon status={a.status} />
                      </span>
                      <span
                        className={`leading-snug ${
                          a.status === "done"
                            ? "text-zinc-400 line-through"
                            : "text-zinc-700 dark:text-zinc-300"
                        }`}
                      >
                        {a.label}
                      </span>
                    </div>
                  ))}
                </div>
                {execError && <p className="mx-auto max-w-3xl px-5 pb-1 text-sm text-red-500">{execError}</p>}
                {pendingPlan.length > 0 && (
                  <div className="mx-auto max-w-3xl px-5 pb-4">
                    <button
                      onClick={() => void executeAllPlan()}
                      disabled={isBusy}
                      className="w-full rounded-xl bg-violet-600 px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-50"
                    >
                      {executing
                        ? "Ejecutando..."
                        : `Ejecutar plan (${pendingPlan.length})`}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Input */}
            <div className="shrink-0 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div className="mx-auto max-w-3xl">
                <div className="flex items-end gap-3 rounded-2xl border border-zinc-300 bg-zinc-50 px-4 py-3 transition-colors focus-within:border-violet-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-violet-500">
                  <textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      autoResize(e.target);
                    }}
                    onKeyDown={handleKeyDown}
                    disabled={isBusy}
                    placeholder={
                      mode === "plan"
                        ? "Describe tu plan (Ej: planifica mi semana…)"
                        : "Dí qué hacer (Ej: crea tarea 'Gym' para mañana…)"
                    }
                    rows={1}
                    className="max-h-40 flex-1 resize-none bg-transparent text-[15px] leading-relaxed text-zinc-800 placeholder-zinc-400 outline-none dark:text-zinc-100"
                  />
                  <button
                    onClick={() => void handleSend()}
                    disabled={!canSend}
                    className="mb-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white transition hover:bg-violet-700 disabled:opacity-40"
                    aria-label="Enviar"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 rotate-90">
                      <path d="M10.894 2.553a1 1 0 0 0-1.788 0l-7 14a1 1 0 0 0 1.169 1.409l5-1.429A1 1 0 0 0 9 15.571V11a1 1 0 1 1 2 0v4.571a1 1 0 0 0 .725.962l5 1.428a1 1 0 0 0 1.17-1.408l-7-14z" />
                    </svg>
                  </button>
                </div>
                <p className="mt-2 text-center text-xs text-zinc-400">
                  Enter para enviar · Shift+Enter para nueva línea
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
