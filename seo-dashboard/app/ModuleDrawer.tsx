"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { findModule, MODULE_GROUPS, type ModuleKey } from "./modules";

type Props = {
  open: boolean;
  moduleKey: ModuleKey | null;
  onSelect: (key: ModuleKey) => void;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Slide-over drawer for the active module. It stays mounted (just hidden) while closed so a module that keeps its own
 * state, like Topic Clusters, is not thrown away. The open animation ends with no transform on purpose: a lingering
 * transform would make `position: fixed` dialogs inside a module (Quick Fix) position relative to the drawer.
 */
export default function ModuleDrawer({ open, moduleKey, onSelect, onClose, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose; // always call the latest handler without re-running the effect below
  });

  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A dialog inside the module (Quick Fix, etc.) closes first; only a bare drawer closes on Escape.
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-module-drawer])')) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      trigger?.focus?.();
    };
  }, [open]);

  const info = findModule(moduleKey);

  return (
    <div hidden={!open} className="fixed inset-0 z-40">
      <div className="drawer-backdrop absolute inset-0 bg-slate-900/50" aria-hidden="true" onMouseDown={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="module-drawer-title"
        data-module-drawer
        tabIndex={-1}
        className="drawer-panel absolute inset-y-0 right-0 flex w-full max-w-[min(72rem,96vw)] flex-col bg-slate-50 shadow-2xl focus:outline-none"
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
          >
            <span aria-hidden="true">←</span> Back to Dashboard
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold uppercase tracking-wide text-slate-400">{info?.group ?? ""}</p>
            <h2 id="module-drawer-title" className="truncate text-lg font-semibold tracking-tight text-slate-900">
              {info ? `${info.icon} ${info.label}` : ""}
            </h2>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-slate-500">
            <span className="sr-only sm:not-sr-only">Module</span>
            <select
              value={moduleKey ?? ""}
              onChange={(e) => onSelect(e.target.value as ModuleKey)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-normal text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              {MODULE_GROUPS.map((g) => (
                <optgroup key={g.id} label={g.label}>
                  {g.modules.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">{children}</div>
      </div>
    </div>
  );
}
