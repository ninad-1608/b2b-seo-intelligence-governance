"use client";

export type GscSummary = { connected: boolean; configured: boolean; hasSync: boolean };

type Props = {
  summary: GscSummary | null;
  live: boolean;
  liveLabel: string;
  onOpen: () => void;
  onUseSandbox: () => void;
};

/** High-visibility Google connection card. Three states: not connected (call to action), connected (finish syncing), live. */
export default function GscCallout({ summary, live, liveLabel, onOpen, onUseSandbox }: Props) {
  if (live) {
    return (
      <section aria-label="Google Search Console connection" className="mt-3! flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-emerald-300 bg-emerald-50 px-5 py-3">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-emerald-900">
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
          <span className="truncate">Live Google data: {liveLabel}</span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-emerald-800 shadow-sm ring-1 ring-inset ring-emerald-300 hover:bg-emerald-100"
          >
            Manage connection
          </button>
          <button type="button" onClick={onUseSandbox} className="rounded-lg px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100">
            Switch to demo data
          </button>
        </div>
      </section>
    );
  }

  if (summary?.connected) {
    return (
      <section aria-label="Google Search Console connection" className="mt-3! flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-indigo-300 bg-indigo-50 px-5 py-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-indigo-950">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden="true" /> Google account connected
          </p>
          <p className="text-sm text-indigo-900/80">{summary.hasSync ? "Your synced data is ready: switch the dashboard to live data." : "Choose a property and sync to replace the demo data with your real numbers."}</p>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
        >
          {summary.hasSync ? "Go live" : "🔄 Sync your data"}
        </button>
      </section>
    );
  }

  return (
    <section
      aria-label="Connect Google Search Console and GA4"
      className="mt-3! flex flex-col gap-4 rounded-2xl border-2 border-indigo-400 bg-gradient-to-r from-indigo-600 to-blue-600 p-5 text-white shadow-lg shadow-indigo-600/20 sm:flex-row sm:items-center sm:justify-between sm:p-6"
    >
      <div className="flex min-w-0 items-start gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/15 text-2xl" aria-hidden="true">
          🔌
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Connect your live Google data</h2>
          <p className="mt-0.5 text-sm text-indigo-100">
            You’re looking at demo data. Connect Search Console and GA4 (read-only) to see your real clicks, impressions, cannibalization and content decay.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="shrink-0 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-indigo-700 shadow-md transition hover:bg-indigo-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-indigo-600"
      >
        🔌 Connect Google Search Console / GA4
      </button>
    </section>
  );
}
