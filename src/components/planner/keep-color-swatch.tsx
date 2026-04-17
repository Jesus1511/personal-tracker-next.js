"use client";

import { useEffect, useRef, useState } from "react";

import { plannerTintBackground } from "@/lib/planner/color-tint";

/**
 * Paleta en tonos ~600 (menos pastel); en UI los tintes se muestran al 80% vía `plannerTintBackground`.
 * Se guarda el hex opaco en Supabase `color` en task_types / habit_types.
 */
export const KEEP_LIKE_SWATCHES: { value: string | null; label: string }[] = [
  { value: null, label: "Sin color" },
  { value: "#dc2626", label: "Rojo" },
  { value: "#ea580c", label: "Naranja" },
  { value: "#ca8a04", label: "Amarillo" },
  { value: "#16a34a", label: "Verde" },
  { value: "#0d9488", label: "Teal" },
  { value: "#2563eb", label: "Azul" },
  { value: "#4f46e5", label: "Indigo" },
  { value: "#9333ea", label: "Purpura" },
  { value: "#db2777", label: "Rosa" },
  { value: "#475569", label: "Gris" },
];

type Props = {
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  /** Compact row for list items inside modals. */
  size?: "sm" | "md";
};

/**
 * Horizontal circular swatches with clear selection (ring + check) like Keep.
 * **Why:** single place for palette + a11y labels; **Risk:** only preset strings round-trip cleanly from DB;
 * **Alternative:** free-form color input (noisier UX).
 */
export function KeepColorSwatchPicker({ value, onChange, disabled, size = "md" }: Props) {
  const dim = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const gap = size === "sm" ? "gap-1" : "gap-1.5";
  const checkScale = size === "sm" ? "scale-75" : "";

  return (
    <div
      className={`flex flex-wrap items-center ${gap}`}
      role="listbox"
      aria-label="Color de fondo"
    >
      {KEEP_LIKE_SWATCHES.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value ?? "none"}
            type="button"
            role="option"
            aria-selected={selected}
            title={opt.label}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`relative shrink-0 rounded-full border-2 transition-[box-shadow,transform] focus-visible:ring-violet-400 disabled:opacity-50 ${dim} ${
              selected
                ? "border-violet-500 shadow-[0_0_0_1px_rgba(139,92,246,0.35)] dark:border-violet-400"
                : "border-zinc-200 dark:border-zinc-600"
            } ${!opt.value ? "bg-zinc-200/70 dark:bg-zinc-700/80" : ""}`}
            style={opt.value ? { backgroundColor: plannerTintBackground(opt.value) } : undefined}
          >
            {!opt.value ? (
              <span
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
                aria-hidden
              >
                <span className="h-px w-[60%] rotate-45 rounded bg-zinc-500 dark:bg-zinc-400" />
              </span>
            ) : null}
            {selected ? (
              <span
                className={`pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-violet-600 text-[9px] font-bold leading-none text-white shadow dark:bg-violet-500 ${checkScale}`}
                aria-hidden
              >
                {"\u2713"}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

type DropdownProps = {
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  /** Panel position (evitar que se salga del modal). */
  align?: "left" | "right";
};

/**
 * Boton con muestra del color actual; al pulsar abre la paleta. Cierra al elegir color, Escape o clic fuera.
 */
export function KeepColorPickerDropdown({
  value,
  onChange,
  disabled,
  size = "md",
  align = "left",
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const swatch = size === "sm" ? "h-6 w-6" : "h-8 w-8";

  return (
    <div className="relative inline-flex" ref={wrapRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-50"
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Elegir color"
      >
        <span
          className={`shrink-0 rounded-full border-2 border-zinc-200 dark:border-zinc-600 ${swatch} ${!value ? "bg-zinc-200/70 dark:bg-zinc-700/80" : ""}`}
          style={value ? { backgroundColor: plannerTintBackground(value) } : undefined}
        />
        <span className="max-sm:hidden">Color</span>
      </button>
      {open ? (
        <div
          className={`absolute top-full z-[60] mt-1 max-w-[min(100vw-2rem,20rem)] rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-950 ${
            align === "right" ? "right-0" : "left-0"
          }`}
          role="presentation"
        >
          <KeepColorSwatchPicker
            value={value}
            onChange={(c) => {
              onChange(c);
              setOpen(false);
            }}
            disabled={disabled}
            size={size}
          />
        </div>
      ) : null}
    </div>
  );
}
