"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type DocId = "singleton" | "ai_context";

const DOC_META: Record<DocId, { label: string; placeholder: string }> = {
  singleton: {
    label: "Notas",
    placeholder: "Escribe lo que quieras — markdown, listas, saltos de línea…",
  },
  ai_context: {
    label: "Contexto IA",
    placeholder:
      "Escribe contexto personal para el Planificador IA — preferencias, rutinas, objetivos…\n\n" +
      "Claude puede reescribir este documento automáticamente cuando detecte información nueva relevante.",
  },
};

export function ScratchpadPage() {
  const [activeDoc, setActiveDoc] = useState<DocId>("singleton");
  const [contents, setContents] = useState<Record<DocId, string>>({
    singleton: "",
    ai_context: "",
  });
  const [loading, setLoading] = useState<Record<DocId, boolean>>({
    singleton: true,
    ai_context: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentsRef = useRef(contents);
  contentsRef.current = contents;

  const loadDoc = useCallback(async (id: DocId) => {
    setLoading((prev) => ({ ...prev, [id]: true }));
    setError(null);
    try {
      const res = await fetch(`/api/planner/scratchpad?id=${id}`);
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Error al cargar");
      }
      const data = (await res.json()) as { content?: string };
      setContents((prev) => ({
        ...prev,
        [id]: typeof data.content === "string" ? data.content : "",
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }));
    }
  }, []);

  const save = useCallback(async (id: DocId, text: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/planner/scratchpad", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, content: text }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Error al guardar");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setSaving(false);
    }
  }, []);

  // Load singleton on mount
  useEffect(() => {
    void loadDoc("singleton");
  }, [loadDoc]);

  // Load doc when switching
  useEffect(() => {
    if (loading[activeDoc] || contentsRef.current[activeDoc]) return;
    void loadDoc(activeDoc);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDoc]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const isLoading = loading[activeDoc];
  const currentContent = contents[activeDoc];
  const meta = DOC_META[activeDoc];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        {/* Doc toggle */}
        <div className="flex rounded-lg border border-zinc-200 p-0.5 text-xs dark:border-zinc-700">
          {(["singleton", "ai_context"] as DocId[]).map((id) => (
            <button
              key={id}
              onClick={() => setActiveDoc(id)}
              className={`rounded-md px-3 py-1 font-medium transition-colors ${
                activeDoc === id
                  ? "bg-violet-600 text-white"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {id === "singleton" ? "📝 Notas" : "🧠 Contexto IA"}
            </button>
          ))}
        </div>

        <span className="flex-1 text-sm text-zinc-500 dark:text-zinc-400">
          {isLoading ? "Cargando…" : saving ? "Guardando…" : "Guardado"}
        </span>

        {error && (
          <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>

      {/* Context IA hint */}
      {activeDoc === "ai_context" && (
        <div className="shrink-0 border-b border-violet-100 bg-violet-50 px-4 py-2 text-xs text-violet-700 dark:border-violet-900/40 dark:bg-violet-950/30 dark:text-violet-300">
          Este documento se inyecta como contexto en el Planificador IA. Claude puede reescribirlo automáticamente cuando detecte información relevante nueva.
          <br />
          <span className="text-violet-400 dark:text-violet-500">Tabla DB: <code>scratchpad</code> · id: <code>ai_context</code></span>
        </div>
      )}

      <textarea
        key={activeDoc}
        value={currentContent}
        disabled={isLoading}
        onChange={(e) => {
          const v = e.target.value;
          setContents((prev) => ({ ...prev, [activeDoc]: v }));
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            void save(activeDoc, v);
          }, 600);
        }}
        onBlur={() => {
          if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
          }
          void save(activeDoc, contentsRef.current[activeDoc]);
        }}
        placeholder={meta.placeholder}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none border-0 bg-transparent px-4 py-3 font-mono text-sm leading-relaxed text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:text-zinc-100 dark:placeholder:text-zinc-600"
      />
    </div>
  );
}
