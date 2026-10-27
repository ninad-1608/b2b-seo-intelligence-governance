"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MODULE_GROUPS, type ModuleKey } from "./modules";

type Props = {
  active: ModuleKey | null;
  onSelect: (key: ModuleKey) => void;
  trailing?: ReactNode; // right-hand slot, used for the alerts bell
};

/**
 * Slim sticky "Toolbox" bar: one dropdown per tool group. Picking a tool opens its workspace drawer.
 * Replaces the large category cards so the data table stays the focus of the page.
 */
export default function ModuleToolbar({ active, onSelect, trailing }: Props) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const barRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!openGroup) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenGroup(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // move focus into the menu so it is keyboard-operable
    barRef.current?.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openGroup]);

  function onMenuKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <nav
      ref={barRef}
      aria-label="Toolbox"
      className="sticky top-2 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 shadow-sm backdrop-blur"
    >
      <span className="mr-1 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
        <span aria-hidden="true">🧰</span> Toolbox
      </span>

      {MODULE_GROUPS.map((g) => {
        const isOpen = openGroup === g.id;
        const hasActive = g.modules.some((m) => m.key === active);
        return (
          <div key={g.id} className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onClick={() => setOpenGroup(isOpen ? null : g.id)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                isOpen || hasActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              {g.label}
              <span aria-hidden="true" className={`text-[10px] transition-transform ${isOpen ? "rotate-180" : ""}`}>
                ▼
              </span>
            </button>

            {isOpen && (
              <div
                role="menu"
                aria-label={g.label}
                onKeyDown={onMenuKey}
                className="absolute left-0 top-full z-40 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl"
              >
                <p className="px-2.5 pb-1 pt-1.5 text-xs text-slate-400">{g.blurb}</p>
                {g.modules.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpenGroup(null);
                      onSelect(m.key);
                    }}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-indigo-50 focus:bg-indigo-50 focus:outline-none"
                  >
                    <span className="mt-0.5 text-base" aria-hidden="true">
                      {m.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-900">{m.label}</span>
                      <span className="block text-xs text-slate-500">{m.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="ml-auto flex items-center gap-3">
        <span className="hidden text-xs text-slate-400 md:inline">Pick a tool to open its workspace</span>
        {trailing}
      </div>
    </nav>
  );
}
