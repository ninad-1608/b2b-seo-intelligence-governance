"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE, type AlertSummary } from "./lib/alerts";

const POLL_MS = 60_000;

async function fetchSummary(): Promise<AlertSummary | null> {
  try {
    const res = await fetch(`${API_BASE}/summary`);
    return res.ok ? await res.json() : null;
  } catch {
    return null; // API offline: keep showing the last known count
  }
}

type Props = {
  onOpen: () => void;
  /** Bump to refresh the count right away (e.g. after the alerts panel marked something read). */
  version: number;
  /** Called after the bell ran an automatic check, so an open alerts panel can reload. */
  onAutoCheck: () => void;
};

/** Live notification bell: unread alert count, polled every minute, and the trigger for scheduled checks. */
export default function AlertBell({ onOpen, version, onAutoCheck }: Props) {
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const autoCheckRef = useRef(onAutoCheck);
  useEffect(() => {
    autoCheckRef.current = onAutoCheck; // latest callback without restarting the polling effect below
  });

  useEffect(() => {
    let cancelled = false;
    let running = false;

    async function tick() {
      if (document.visibilityState === "hidden") return; // no polling from background tabs
      let s = await fetchSummary();
      if (s?.due && !running) {
        // An automatic check is overdue: the engine only runs while the dashboard is open.
        running = true;
        try {
          await fetch(`${API_BASE}/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notify: true }) });
          s = await fetchSummary();
          if (!cancelled) autoCheckRef.current();
        } catch {
          /* the next tick retries */
        } finally {
          running = false;
        }
      }
      if (!cancelled && s) setSummary(s);
    }

    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [version]);

  const unread = summary?.unread_total ?? 0;
  const critical = summary?.unread_critical ?? 0;
  const label =
    unread === 0 ? "Alerts: nothing unread" : `Alerts: ${unread} unread${critical ? `, ${critical} critical` : ""}`;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className="relative rounded-lg p-2 text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
        <path d="M10.3 20a2 2 0 0 0 3.4 0" />
      </svg>
      {unread > 0 && (
        <span
          className={`absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white ${
            critical > 0 ? "bg-rose-600" : "bg-amber-500"
          }`}
          aria-hidden="true"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}
