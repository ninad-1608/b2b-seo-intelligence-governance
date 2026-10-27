"use client";

import { FreshnessChip, useEvidence } from "./evidence";

/** The one wording used everywhere a score or projection is shown. */
export const DISCLAIMER_TEXT = "Scores and projections are ranking aids to prioritize investigation and risk. They do not predict traffic, leads, or revenue.";

/** Banner shown on every forecasting, scoring and analysis view. */
export function ScoreDisclaimer({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  return (
    <p role="note" className={`flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 ${compact ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm"} ${className}`}>
      <span aria-hidden="true">ⓘ</span>
      <span>{DISCLAIMER_TEXT}</span>
    </p>
  );
}

/** A small "i" that explains a number. Works on hover, keyboard focus and tap. */
export function InfoTip({ text, label = "More information" }: { text: string; label?: string }) {
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`${label}: ${text}`}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600 hover:bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden w-64 -translate-x-1/2 rounded-md bg-slate-900 px-3 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal text-white shadow-lg group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}

/** Marks a number that did NOT come from the user's own Search Console / GA4 data. */
export function ThirdPartyBadge({ children = "Estimated · Third-party", title }: { children?: string; title?: string }) {
  return (
    <span
      title={title ?? "Not from your Search Console or GA4. Treat as an estimate."}
      className="inline-flex items-center rounded border border-dashed border-orange-400 bg-orange-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-800"
    >
      {children}
    </span>
  );
}

/** Marks a number measured in the user's own Search Console / GA4 property. */
export function FirstPartyBadge({ children = "First-party · GSC" }: { children?: string }) {
  return (
    <span className="inline-flex items-center rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 ring-1 ring-inset ring-emerald-600/20">
      {children}
    </span>
  );
}

/** Marks the built-in demonstration numbers so they are never read as real measurements. */
export function SandboxBadge() {
  return (
    <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 ring-1 ring-inset ring-slate-500/20">
      Sample data
    </span>
  );
}

/**
 * Where the Search Console numbers came from and how old they are, from the shared evidence audit.
 * live=false means the module is showing sandbox or uploaded data, which is said plainly instead of showing a time.
 */
export function SyncStamp({ live, className = "" }: { live: boolean; className?: string }) {
  const ev = useEvidence();
  if (!live) {
    return (
      <p className={`flex flex-wrap items-center gap-2 text-xs text-slate-500 ${className}`}>
        <SandboxBadge /> Not Search Console data: sample or uploaded figures, with no sync time.
      </p>
    );
  }
  const gscSource = ev?.audit?.sources.find((x) => x.key === "gsc");
  return (
    <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 ${className}`}>
      <FirstPartyBadge />
      <FreshnessChip source="gsc" />
      {gscSource?.site_url && (
        <span className="text-slate-400">
          · {gscSource.site_url}, data {gscSource.window}
        </span>
      )}
    </p>
  );
}
