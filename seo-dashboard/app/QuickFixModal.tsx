"use client";

import { useEffect, useRef, useState } from "react";
import type { CannibalizationAlert } from "./CannibalizationPanel";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";
const numberFormat = new Intl.NumberFormat("en-US");

type RankedUrl = { url: string; impressions: number; position: number; score: number };

type FixResult = {
  winning_url: string;
  losing_urls: string[];
  ranking: RankedUrl[];
  rationale: string;
  rationale_source: "ai" | "rules";
  snippets: { nextjs: string; nginx: string; cloudflare: string; canonical: string };
  canonical_note: string;
};

const tabs = [
  { key: "nextjs", label: "Next.js Redirect" },
  { key: "nginx", label: "Nginx Rule" },
  { key: "cloudflare", label: "Cloudflare Rule" },
  { key: "canonical", label: "Canonical Tag" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail : `Request failed (${res.status})`;
}

export default function QuickFixModal({ alert, onClose }: { alert: CannibalizationAlert; onClose: () => void }) {
  const [result, setResult] = useState<FixResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [active, setActive] = useState<TabKey>("nextjs");
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/generate-cannibalization-fix`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: alert.query,
            competing_urls: alert.url_stats.map((u) => ({ url: u.url, impressions: u.impressions, position: u.position })),
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(await errorMessage(res));
        setResult(await res.json());
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not generate the fix.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [alert, attempt]);

  function retry() {
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  }

  // Escape closes; the page behind does not scroll while the dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.snippets[active]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const stat = (url: string) => result?.ranking.find((r) => r.url === url);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="quickfix-title"
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl focus:outline-none sm:rounded-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="quickfix-title" className="text-base font-semibold text-slate-900">
              Resolve conflict: merge &amp; redirect
            </h2>
            <p className="truncate text-sm text-slate-500" title={alert.query}>
              Query: “{alert.query}”
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            ✕
          </button>
        </header>

        <div className="space-y-5 overflow-y-auto px-5 py-5">
          {loading && <p className="text-sm text-slate-500">Analyzing competing URLs…</p>}

          {error && (
            <div role="alert" className="space-y-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              <p>{error}</p>
              <button
                type="button"
                onClick={retry}
                className="rounded bg-white px-2.5 py-1 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-300 hover:bg-rose-50"
              >
                Try again
              </button>
            </div>
          )}

          {result && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Winning URL (keep)</p>
                  <p className="mt-1 break-all font-mono text-sm text-slate-900">{result.winning_url}</p>
                  {stat(result.winning_url) && (
                    <p className="mt-1 text-xs text-slate-500">
                      {numberFormat.format(stat(result.winning_url)!.impressions)} impressions · position{" "}
                      {stat(result.winning_url)!.position.toFixed(1)}
                    </p>
                  )}
                </div>
                <div className="rounded-lg border border-rose-200 bg-rose-50/60 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">
                    Losing URL{result.losing_urls.length === 1 ? "" : "s"} (redirect)
                  </p>
                  <ul className="mt-1 space-y-1.5">
                    {result.losing_urls.map((u) => (
                      <li key={u}>
                        <p className="break-all font-mono text-sm text-slate-900">{u}</p>
                        {stat(u) && (
                          <p className="text-xs text-slate-500">
                            {numberFormat.format(stat(u)!.impressions)} impressions · position {stat(u)!.position.toFixed(1)}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">Rationale</h3>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                    {result.rationale_source === "ai" ? "AI-generated" : "Rule-based"}
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-slate-700">{result.rationale}</p>
                <p className="mt-1 text-xs text-slate-400">
                  Winner chosen by impressions (50%) and ranking position (35%); page content was not evaluated.
                </p>
              </div>

              <div className="overflow-hidden rounded-md border border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-1 bg-slate-100 pr-2">
                  <div role="tablist" className="flex flex-wrap">
                    {tabs.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        role="tab"
                        aria-selected={active === t.key}
                        onClick={() => {
                          setActive(t.key);
                          setCopied(false);
                        }}
                        className={`px-3 py-2 text-xs font-medium transition ${
                          active === t.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-200 hover:text-slate-900"
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={copy}
                    className="rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                  >
                    {copied ? "Copied ✓" : "Copy Snippet"}
                  </button>
                </div>
                <pre className="max-h-72 overflow-auto bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
                  <code className="font-mono">{result.snippets[active]}</code>
                </pre>
              </div>
              {active === "canonical" && <p className="text-xs text-slate-500">{result.canonical_note}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
