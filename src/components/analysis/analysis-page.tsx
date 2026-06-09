"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { type AnalysisRecord } from "@/lib/gemini/types";
import {
  CLAUDE_MODEL_OPTIONS,
  DEFAULT_CLAUDE_MODEL_ID,
  isAllowedClaudeModelId,
} from "@/lib/gemini/claude-models";

type SavedPrompt = { id: string; label: string; prompt_text: string };
type ChatMsg = { id: string; role: "user" | "assistant"; content: string };
type ToolCallInfo = { name: string; input: Record<string, unknown> };

function formatToolCall(t: ToolCallInfo): string {
  if (t.name === "query_table") {
    const i = t.input as { table?: string; date_start?: string; date_end?: string };
    const parts = [i.table ?? "tabla"];
    if (i.date_start) parts.push(`${i.date_start}→${i.date_end ?? i.date_start}`);
    return parts.join(" ");
  }
  if (t.name === "query_lookup_catalogs") return "catálogos";
  return t.name;
}

const STORAGE_KEY = "planner:ai-chat-v3";
type Persisted = { v: 3; model: string; messages: ChatMsg[]; draft: string };

function msgId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function historyLabel(a: AnalysisRecord): string {
  const text = a.prompt_text?.trim();
  if (!text) return "Análisis de datos";
  const first = text.split("\n")[0]?.replace(/^#+\s*/, "") ?? text;
  return first.length > 52 ? first.slice(0, 50) + "…" : first;
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

/* ------------------------------------------------------------------ */

export function AnalysisPage() {
  const [claudeModel, setClaudeModel] = useState(DEFAULT_CLAUDE_MODEL_ID);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallInfo[]>([]);
  const [current, setCurrent] = useState<AnalysisRecord | null>(null);
  const [history, setHistory] = useState<AnalysisRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>([]);
  const [newPromptLabel, setNewPromptLabel] = useState("");
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isBusy = streaming;
  const canSend = !!chatDraft.trim() && !isBusy;

  /* ------ localStorage ------ */
  useLayoutEffect(() => {
    if (hydrated) return;
    setHydrated(true);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Persisted;
      if (d.v !== 3) return;
      if (isAllowedClaudeModelId(d.model)) setClaudeModel(d.model);
      setChatMessages(d.messages ?? []);
      setChatDraft(d.draft ?? "");
    } catch { /* ignore */ }
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const p: Persisted = { v: 3, model: claudeModel, messages: chatMessages, draft: chatDraft };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
    } catch { /* ignore */ }
  }, [hydrated, claudeModel, chatMessages, chatDraft]);

  /* ------ Auto-scroll ------ */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, streamingText, streaming]);

  /* ------ Data loading ------ */
  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/planner/ai-analysis?limit=40");
      const json = await res.json();
      if (res.ok) setHistory(json.analyses ?? []);
    } catch { /* ignore */ } finally { setHistoryLoading(false); }
  }, []);

  const loadPrompts = useCallback(async () => {
    try {
      const res = await fetch("/api/planner/ai-prompts");
      const json = await res.json();
      if (res.ok) setSavedPrompts(json.prompts ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);
  useEffect(() => { loadPrompts(); }, [loadPrompts]);

  /* ------ Actions ------ */
  function startNewChat() {
    setCurrent(null);
    setChatMessages([]);
    setChatDraft("");
    setStreamingText("");
    setActiveToolCalls([]);
    setError(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    textareaRef.current?.focus();
  }

  function selectHistory(a: AnalysisRecord) {
    setCurrent(a);
    setError(null);
    setStreamingText("");
    setActiveToolCalls([]);
    if (a.status !== "completed" || !a.response_text) {
      setChatMessages([]);
      return;
    }
    const userLine = a.prompt_text?.trim() || "Analiza estos datos.";
    setChatMessages([
      { id: msgId(), role: "user", content: userLine },
      { id: msgId(), role: "assistant", content: a.response_text },
    ]);
  }

  const TOOL_EVENT_RE = /\x01TOOL:([^\n]*)\n/g;

  async function streamResponse(
    url: string,
    body: object,
    baseMessages: ChatMsg[],
  ) {
    setStreaming(true);
    setStreamingText("");
    setActiveToolCalls([]);
    setError(null);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("Sin respuesta");
      const dec = new TextDecoder();
      let rawAcc = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawAcc += dec.decode(value, { stream: true });

        // Extract tool call events
        const tools: ToolCallInfo[] = [];
        let m: RegExpExecArray | null;
        TOOL_EVENT_RE.lastIndex = 0;
        while ((m = TOOL_EVENT_RE.exec(rawAcc)) !== null) {
          try { tools.push(JSON.parse(m[1]) as ToolCallInfo); } catch { /* skip */ }
        }
        if (tools.length > 0) flushSync(() => setActiveToolCalls(tools));

        const display = rawAcc.replace(TOOL_EVENT_RE, "");
        flushSync(() => setStreamingText(display));
      }
      rawAcc += dec.decode();
      const finalText = rawAcc.replace(TOOL_EVENT_RE, "").trim();

      setChatMessages([...baseMessages, { id: msgId(), role: "assistant", content: finalText }]);
      setStreamingText("");
      setActiveToolCalls([]);

      // Refresh history (DB save may have just completed in background)
      if (url.includes("/api/planner/ai-analysis") && !url.includes("/chat")) {
        void loadHistory();
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Error";
      setChatMessages([...baseMessages, { id: msgId(), role: "assistant", content: `**Error:** ${errMsg}` }]);
      setStreamingText("");
      setActiveToolCalls([]);
    } finally {
      setStreaming(false);
    }
  }

  async function handleSend() {
    const text = chatDraft.trim();
    if (!text || isBusy) return;

    const userMsg: ChatMsg = { id: msgId(), role: "user", content: text };
    setChatDraft("");

    if (chatMessages.length === 0) {
      setChatMessages([userMsg]);
      await streamResponse(
        "/api/planner/ai-analysis",
        { customPrompt: text, model: claudeModel },
        [userMsg],
      );
    } else {
      const outbound = [...chatMessages, userMsg];
      setChatMessages(outbound);
      await streamResponse(
        "/api/planner/ai-analysis/chat",
        { messages: outbound.map(({ role, content }) => ({ role, content })), model: claudeModel },
        outbound,
      );
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); }
  }

  async function deleteHistoryItem(id: string, e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (deletingId) return;
    setDeletingId(id);
    try {
      await fetch(`/api/planner/ai-analysis/${id}`, { method: "DELETE" });
      setHistory((prev) => prev.filter((x) => x.id !== id));
      if (current?.id === id) startNewChat();
    } catch { /* ignore */ } finally { setDeletingId(null); }
  }

  async function handleSavePrompt() {
    const text = chatDraft.trim();
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
      if (!res.ok) throw new Error(json.error);
      setSavedPrompts((prev) => [json.prompt, ...prev]);
      setNewPromptLabel("");
      setShowSaveForm(false);
    } catch { /* ignore */ } finally { setSavingPrompt(false); }
  }

  async function handleDeletePrompt(id: string) {
    await fetch(`/api/planner/ai-prompts/${id}`, { method: "DELETE" });
    setSavedPrompts((prev) => prev.filter((p) => p.id !== id));
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */
  return (
    <div className="flex h-full overflow-hidden bg-white dark:bg-zinc-950">

      {/* ============ SIDEBAR ============ */}
      <aside
        className={`flex flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 transition-all duration-200 ${
          sidebarOpen ? "w-64 min-w-[16rem]" : "w-0 overflow-hidden"
        }`}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between gap-2 p-3 border-b border-zinc-200 dark:border-zinc-800">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Análisis
          </span>
          <button
            type="button"
            onClick={startNewChat}
            title="Nuevo chat"
            className="flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 shadow-sm hover:border-violet-400 hover:text-violet-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-violet-500 dark:hover:text-violet-300"
          >
            <span className="text-sm leading-none">+</span> Nuevo
          </button>
        </div>

        {/* History list */}
        <div className="flex-1 overflow-y-auto py-1">
          {historyLoading && (
            <p className="px-3 py-4 text-center text-xs text-zinc-400">Cargando…</p>
          )}
          {!historyLoading && history.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-zinc-400">Sin análisis previos</p>
          )}
          {history.map((a) => {
            const active = current?.id === a.id;
            const deleting = deletingId === a.id;
            return (
              <div
                key={a.id}
                className={`group relative flex items-start gap-2 rounded-lg mx-1 my-0.5 px-2.5 py-2 cursor-pointer transition-colors ${
                  active
                    ? "bg-violet-100 dark:bg-violet-950/60"
                    : "hover:bg-zinc-200/70 dark:hover:bg-zinc-800/60"
                } ${deleting ? "opacity-40 pointer-events-none" : ""}`}
                onClick={() => selectHistory(a)}
              >
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-xs font-medium leading-snug ${
                    active ? "text-violet-900 dark:text-violet-200" : "text-zinc-700 dark:text-zinc-300"
                  }`}>
                    {historyLabel(a)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                    {timeAgo(a.created_at)}
                    {a.status === "failed" && (
                      <span className="ml-1.5 text-red-500">✕</span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={(e) => void deleteHistoryItem(a.id, e)}
                  className="mt-0.5 shrink-0 rounded p-0.5 text-zinc-400 opacity-0 group-hover:opacity-100 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/40 dark:hover:text-red-400"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      {/* ============ MAIN ============ */}
      <div className="flex flex-1 flex-col overflow-hidden">

        {/* Top bar */}
        <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            title="Alternar historial"
            className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
          </button>
          <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 flex-1">
            {current ? historyLabel(current) : "Nuevo análisis"}
          </span>
          <select
            value={claudeModel}
            onChange={(e) => setClaudeModel(e.target.value)}
            className="rounded-lg border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          >
            {CLAUDE_MODEL_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </header>

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-5 px-4 py-6">

            {/* Empty state */}
            {chatMessages.length === 0 && !streaming && !error && (
              <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-100 text-2xl dark:bg-violet-950/60">
                  🧠
                </div>
                <h2 className="text-base font-semibold text-zinc-700 dark:text-zinc-300">
                  ¿En qué puedo ayudarte hoy?
                </h2>
                <p className="max-w-xs text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
                  Escribe lo que quieres analizar. Claude consultará tu base de datos según lo necesite.
                </p>
              </div>
            )}

            {/* Error banner */}
            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
                {error}
              </div>
            )}

            {/* Messages */}
            {chatMessages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-violet-600 px-4 py-2.5 text-sm text-white shadow-sm dark:bg-violet-700">
                    <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex gap-3">
                  <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-xs font-bold text-white shadow">
                    C
                  </div>
                  <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-zinc-200 bg-white px-4 py-3 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
                    <article className="prose prose-sm prose-zinc max-w-none dark:prose-invert">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </article>
                  </div>
                </div>
              )
            )}

            {/* Streaming + tool call bubble */}
            {streaming && (
              <div className="flex gap-3">
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-xs font-bold text-white shadow">
                  C
                </div>
                <div className="max-w-[85%] space-y-2">
                  {/* Tool call chips */}
                  {activeToolCalls.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {activeToolCalls.map((t, i) => (
                        <span
                          key={i}
                          className="flex items-center gap-1 rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950/60 dark:text-violet-300"
                        >
                          <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm1 10H7V7h2v4zm0-6H7V3h2v2z" />
                          </svg>
                          {formatToolCall(t)}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Text streaming or thinking dots */}
                  {streamingText ? (
                    <div className="rounded-2xl rounded-tl-sm border border-zinc-200 bg-white px-4 py-3 text-sm shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
                      <article className="prose prose-sm prose-zinc max-w-none dark:prose-invert">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
                      </article>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-sm border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" />
                    </div>
                  )}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input area */}
        <div className="border-t border-zinc-200 bg-white px-4 pb-4 pt-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="mx-auto max-w-2xl">

            {/* Templates */}
            {savedPrompts.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {savedPrompts.map((p) => (
                  <span key={p.id} className="group relative inline-flex items-center">
                    <button
                      type="button"
                      onClick={() => { setChatDraft(p.prompt_text); textareaRef.current?.focus(); }}
                      title={p.prompt_text}
                      className="rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-0.5 pr-5 text-[10px] font-medium text-zinc-600 hover:border-violet-400 hover:bg-violet-50 hover:text-violet-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:border-violet-600 dark:hover:text-violet-300"
                    >
                      {p.label}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeletePrompt(p.id)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 rounded text-[9px] text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-600"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Textarea + send */}
            <div className="relative flex items-end gap-2 rounded-2xl border border-zinc-300 bg-zinc-50 px-3 py-2 shadow-sm focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-400/20 dark:border-zinc-700 dark:bg-zinc-900">
              <textarea
                ref={textareaRef}
                rows={1}
                value={chatDraft}
                onChange={(e) => {
                  setChatDraft(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={handleKeyDown}
                disabled={isBusy}
                placeholder={chatMessages.length === 0 ? "Escribe tu análisis… (Enter para enviar)" : "Continúa la conversación… (Enter para enviar)"}
                className="max-h-40 flex-1 resize-none bg-transparent text-sm text-zinc-800 placeholder:text-zinc-400 focus:outline-none disabled:opacity-50 dark:text-zinc-200 dark:placeholder:text-zinc-500"
                style={{ height: "36px" }}
              />
              <div className="flex shrink-0 items-center gap-1.5 pb-0.5">
                {chatDraft.trim() && !showSaveForm && (
                  <button
                    type="button"
                    onClick={() => setShowSaveForm(true)}
                    title="Guardar como plantilla"
                    className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canSend}
                  onClick={() => void handleSend()}
                  className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-600 text-white shadow-sm transition-colors hover:bg-violet-700 disabled:opacity-30 dark:bg-violet-600 dark:hover:bg-violet-500"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg>
                </button>
              </div>
            </div>

            {/* Save form */}
            {showSaveForm && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  autoFocus
                  value={newPromptLabel}
                  onChange={(e) => setNewPromptLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); void handleSavePrompt(); }
                    if (e.key === "Escape") { setShowSaveForm(false); setNewPromptLabel(""); }
                  }}
                  placeholder="Nombre de la plantilla"
                  maxLength={40}
                  className="flex-1 rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs shadow-sm focus:border-violet-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                />
                <button
                  type="button"
                  disabled={!newPromptLabel.trim() || savingPrompt}
                  onClick={() => void handleSavePrompt()}
                  className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  {savingPrompt ? "…" : "Guardar"}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowSaveForm(false); setNewPromptLabel(""); }}
                  className="rounded-lg border border-zinc-300 px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
