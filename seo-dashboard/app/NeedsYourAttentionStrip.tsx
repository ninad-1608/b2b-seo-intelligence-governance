"use client";

import { useEffect, useState } from "react";

const TRIAGE_URL = `${process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010"}/api/v1/triage/attention-items`;
const REFRESH_MS = 5 * 60 * 1000;

export type AttentionTarget =
  | { kind: "tool"; tool: "sync" | "cannibalization" }
  | { kind: "tool"; tool: "crawler"; url?: string | null }
  | { kind: "module"; module: "alerts" | "evidence" }
  | { kind: "opportunity"; opportunity_id: number };

type Severity = "critical" | "warning" | "action";

export type AttentionItem = {
  id: string;
  trigger: string;
  severity: Severity;
  severity_label: "Critical" | "Warning" | "Action needed";
  title: string;
  summary: string;
  action: { label: string; target: AttentionTarget };
};

type Attention = {
  status: "clear" | "attention" | "degraded";
  message: string;
  total: number;
  hidden: number;
  items: AttentionItem[];
  check_errors: string[];
};

const BADGE: Record<Severity, string> = {
  critical: "bg-rose-600 text-white",
  warning: "bg-amber-500 text-white",
  action: "bg-indigo-600 text-white",
};
const ROW_ACCENT: Record<Severity, string> = {
  critical: "border-l-rose-500",
  warning: "border-l-amber-500",
  action: "border-l-indigo-500",
};

/** Is this a response we can trust to render? Anything else is treated as "could not check", never as "all clear". */
function isAttention(x: unknown): x is Attention {
  const a = x as Attention;
  return Boolean(a) && typeof a.message === "string" && Array.isArray(a.items) && ["clear", "attention", "degraded"].includes(a.status);
}

/**
 * The first thing on the dashboard: at most five things that need a person, most urgent first, each with one button that goes
 * straight to where it is handled. Reloads when `version` changes (after a sync, an alert check or a review), when the tab
 * regains focus, and every five minutes.
 */
export default function NeedsYourAttentionStrip({ version = 0, onAction }: { version?: number; onAction: (target: AttentionTarget) => void }) {
  const [data, setData] = useState<Attention | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0); // bumped by focus, the timer and "Try again" to force a reload

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(TRIAGE_URL, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body: unknown = await res.json();
        if (!isAttention(body)) throw new Error("unexpected response");
        setData(body);
        setFailed(false);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [version, tick]);

  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const timer = window.setInterval(bump, REFRESH_MS);
    window.addEventListener("focus", bump);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", bump);
    };
  }, []);

  if (!data && !failed) {
    return (
      <section aria-label="Needs your attention" aria-busy="true" className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-sm">
        Checking what needs your attention…
      </section>
    );
  }

  if (failed && !data) {
    return (
      <section aria-label="Needs your attention" role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span>Could not check what needs your attention. The analysis API may be down, so do not read this as “all clear”.</span>
        <button type="button" onClick={() => setTick((t) => t + 1)} className="rounded-md bg-white px-3 py-1 font-medium ring-1 ring-inset ring-amber-300 hover:bg-amber-100">
          Try again
        </button>
      </section>
    );
  }

  if (!data) return null;

  if (data.status === "clear") {
    return (
      <section aria-label="Needs your attention" className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
        <span aria-hidden="true">✓</span>
        {data.message}
        {failed && <span className="ml-auto text-xs font-normal text-amber-700">Could not refresh just now; showing the last result.</span>}
      </section>
    );
  }

  return (
    <section aria-label="Needs your attention" className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
        <h2 className="text-sm font-semibold text-slate-900">Needs your attention</h2>
        <p className="text-xs text-slate-500">
          {data.message}
          {data.hidden > 0 && ` · showing the ${data.items.length} most urgent`}
          {failed && " · could not refresh just now"}
        </p>
      </div>
      {data.status === "degraded" && data.items.length === 0 && (
        <p role="status" className="px-4 py-3 text-sm text-amber-800">
          Some checks could not run ({data.check_errors.join(", ")}), so this list may be incomplete.
        </p>
      )}
      <ul className="divide-y divide-slate-100">
        {data.items.map((it) => (
          <li key={it.id} className={`flex flex-col gap-2 border-l-4 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3 ${ROW_ACCENT[it.severity]}`}>
            <span className={`inline-flex shrink-0 items-center self-start rounded-full px-2.5 py-0.5 text-xs font-semibold sm:self-center ${BADGE[it.severity]}`}>{it.severity_label}</span>
            <p className="min-w-0 flex-1 text-sm leading-5 text-slate-700" title={`${it.title}. ${it.summary}`}>
              <span className="font-semibold text-slate-900">{it.title}.</span> {it.summary}
            </p>
            <button
              type="button"
              onClick={() => onAction(it.action.target)}
              className="shrink-0 self-start rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 sm:self-center"
            >
              {it.action.label} →
            </button>
          </li>
        ))}
      </ul>
      {data.status === "degraded" && data.items.length > 0 && (
        <p role="status" className="border-t border-slate-100 px-4 py-2 text-xs text-amber-700">
          Some checks could not run ({data.check_errors.join(", ")}), so this list may be incomplete.
        </p>
      )}
    </section>
  );
}
