"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function ScratchpadPage() {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  const save = useCallback(async (text: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/planner/scratchpad", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/planner/scratchpad");
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          throw new Error(data.error ?? "Error al cargar");
        }
        const data = (await res.json()) as { content?: string };
        if (!cancelled) setContent(typeof data.content === "string" ? data.content : "");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Error al cargar");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          {loading ? "Cargando…" : saving ? "Guardando…" : "Guardado"}
        </span>
        {error && (
          <span className="text-sm text-red-600 dark:text-red-400">{error}</span>
        )}
      </div>
      <textarea
        value={content}
        disabled={loading}
        onChange={(e) => {
          const v = e.target.value;
          setContent(v);
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => {
            void save(v);
          }, 600);
        }}
        onBlur={() => {
          if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
          }
          void save(contentRef.current);
        }}
        placeholder="Escribe lo que quieras — markdown, listas, saltos de línea…"
        spellCheck={false}
        className="min-h-0 flex-1 resize-none border-0 bg-transparent px-4 py-3 font-mono text-sm leading-relaxed text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-50 dark:text-zinc-100 dark:placeholder:text-zinc-600"
      />
    </div>
  );
}
