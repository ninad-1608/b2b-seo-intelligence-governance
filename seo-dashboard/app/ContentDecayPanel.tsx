"use client";

import { Fragment, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { markdownComponents } from "./markdownComponents";
import { currentWindow, previousWindow } from "./lib/decaySample";
import { ScoreDisclaimer, SyncStamp } from "./Guardrails";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";
const fmt = new Intl.NumberFormat("en-US");

type Severity = "High" | "Medium" | "Low";
type Mode = "sandbox" | "custom" | "live";

type QueryDecay = {
  query: string;
  prior_impressions: number;
  current_impressions: number;
  impressions_drop_pct: number;
  position_change: number | null;
};

type DecayedUrl = {
  url: string;
  prior_impressions: number;
  current_impressions: number;
  impressions_drop_pct: number;
  prior_clicks: number;
  current_clicks: number;
  clicks_drop_pct: number;
  prior_position: number | null;
  current_position: number | null;
  position_change: number | null;
  severity: Severity;
  top_queries: QueryDecay[];
};

type SourceInfo = { filename: string; rows: number; skipped: number };

type Analysis = {
  summary: { urls_analyzed: number; decayed_count: number; impressions_lost: number };
  decayed: DecayedUrl[];
  source?: { previous: SourceInfo; current: SourceInfo };
};

type BriefState = { loading: boolean; brief?: string; error?: string; open: boolean };

const severityStyles: Record<Severity, string> = {
  High: "bg-rose-50 text-rose-700 ring-rose-600/20",
  Medium: "bg-amber-50 text-amber-700 ring-amber-600/20",
  Low: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail : `Request failed (${res.status})`;
}

function PositionDrift({ change }: { change: number | null }) {
  if (change === null) return <span className="text-slate-400">—</span>;
  const worse = change > 0;
  return (
    <span className={worse ? "font-medium text-rose-600" : change < 0 ? "font-medium text-emerald-600" : "text-slate-500"}>
      {worse ? "▼" : change < 0 ? "▲" : "•"} {change > 0 ? "+" : ""}
      {change.toFixed(1)}
    </span>
  );
}

function FileDrop({
  id,
  label,
  file,
  onFile,
  onReject,
}: {
  id: string;
  label: string;
  file: File | null;
  onFile: (f: File) => void;
  onReject: (message: string) => void;
}) {
  const [dragging, setDragging] = useState(false);

  function accept(f: File | undefined) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".csv")) {
      onReject(`"${f.name}" is not a .csv file.`);
      return;
    }
    onFile(f);
  }

  return (
    <label
      htmlFor={id}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        accept(e.dataTransfer.files[0]);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-5 text-center transition ${
        dragging
          ? "border-indigo-500 bg-indigo-50"
          : file
            ? "border-emerald-300 bg-emerald-50/50"
            : "border-slate-300 bg-slate-50 hover:border-slate-400"
      }`}
    >
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <span className="max-w-full truncate text-xs text-slate-500">
        {file ? `✓ ${file.name}` : "Drag & drop a .csv here, or click to browse"}
      </span>
      <input
        id={id}
        type="file"
        accept=".csv"
        className="sr-only"
        onChange={(e) => {
          accept(e.target.files?.[0]);
          e.target.value = ""; // allow re-selecting the same file
        }}
      />
    </label>
  );
}

export default function ContentDecayPanel({ liveLabel }: { liveLabel?: string }) {
  const [mode, setMode] = useState<Mode>(liveLabel ? "live" : "sandbox");
  const [live, setLive] = useState<Analysis | null>(null);
  const [liveLoading, setLiveLoading] = useState(Boolean(liveLabel));
  const [liveError, setLiveError] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState<Analysis | null>(null);
  const [sandboxLoading, setSandboxLoading] = useState(true);
  const [sandboxError, setSandboxError] = useState<string | null>(null);

  const [custom, setCustom] = useState<Analysis | null>(null);
  const [prevFile, setPrevFile] = useState<File | null>(null);
  const [curFile, setCurFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [briefs, setBriefs] = useState<Record<string, BriefState>>({});

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/analyze-decay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ previous: previousWindow, current: currentWindow }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(await errorMessage(res));
        setSandbox(await res.json());
      } catch (err) {
        if (controller.signal.aborted) return;
        setSandboxError(err instanceof Error ? err.message : "Could not reach the analysis API. Is the FastAPI server running?");
      } finally {
        if (!controller.signal.aborted) setSandboxLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (mode !== "live" || live || !liveLabel) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/gsc/decay`, { signal: controller.signal });
        if (!res.ok) throw new Error(await errorMessage(res));
        setLive(await res.json());
        setLiveError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setLiveError(err instanceof Error ? err.message : "Could not reach the analysis API. Is the FastAPI server running?");
      } finally {
        if (!controller.signal.aborted) setLiveLoading(false);
      }
    })();
    return () => controller.abort();
  }, [mode, live, liveLabel]);

  function switchMode(next: Mode) {
    if (next === mode) return;
    if (next === "live" && !live) {
      setLiveLoading(true);
      setLiveError(null);
    }
    setMode(next);
    setBriefs({}); // briefs belong to the dataset they were generated from
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!prevFile || !curFile) {
      setUploadError("Please choose both the prior-window and current-window CSV files.");
      return;
    }
    setUploading(true);
    setUploadError(null);

    const form = new FormData();
    form.append("previous_period", prevFile);
    form.append("current_period", curFile);

    try {
      // No Content-Type header: the browser sets the multipart boundary.
      const res = await fetch(`${API_URL}/api/v1/analyze-decay`, { method: "POST", body: form });
      if (!res.ok) throw new Error(await errorMessage(res));
      setCustom(await res.json());
      setBriefs({});
      setMode("custom");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "An error occurred while uploading.");
    } finally {
      setUploading(false);
    }
  }

  async function generateBrief(row: DecayedUrl) {
    setBriefs((b) => ({ ...b, [row.url]: { loading: true, open: true, brief: b[row.url]?.brief } }));
    try {
      const res = await fetch(`${API_URL}/api/v1/generate-refresh-brief`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: row.url,
          prior_impressions: row.prior_impressions,
          current_impressions: row.current_impressions,
          impressions_drop_pct: row.impressions_drop_pct,
          clicks_drop_pct: row.clicks_drop_pct,
          position_change: row.position_change,
          top_queries: row.top_queries,
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json();
      setBriefs((b) => ({ ...b, [row.url]: { loading: false, open: true, brief: data.brief } }));
    } catch (err) {
      setBriefs((b) => ({
        ...b,
        [row.url]: {
          loading: false,
          open: true,
          brief: b[row.url]?.brief,
          error: err instanceof Error ? err.message : "Could not generate the refresh brief.",
        },
      }));
    }
  }

  function toggle(url: string) {
    setBriefs((b) => ({ ...b, [url]: { ...b[url], open: !b[url]?.open } }));
  }

  const analysis = mode === "custom" ? custom : mode === "live" ? live : sandbox;
  const modes: [Mode, string][] = [
    ["sandbox", "Sandbox Demo Data"],
    ["custom", "Custom Upload"],
    ...(liveLabel ? ([["live", "Live GSC"]] as [Mode, string][]) : []),
  ];

  return (
    <section aria-labelledby="decay-heading" className="space-y-4">
      <ScoreDisclaimer />
      <SyncStamp live={mode === "live" && Boolean(liveLabel)} />
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Decay Data Source</h3>
            <p className="text-sm text-slate-500">
              Upload two Search Console exports (Page, Impressions, Clicks, Position; Query optional) or explore the sandbox demo.
            </p>
          </div>
          <div role="group" aria-label="Data source" className="inline-flex shrink-0 rounded-lg bg-slate-100 p-1 text-sm font-medium">
            {modes.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={mode === key}
                onClick={() => switchMode(key)}
                className={`rounded-md px-3 py-1.5 transition ${
                  mode === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleUpload} className="mt-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <FileDrop
              id="decay-prev-csv"
              label="Prior Window CSV (e.g., Previous 30 Days)"
              file={prevFile}
              onFile={(f) => {
                setPrevFile(f);
                setUploadError(null);
              }}
              onReject={setUploadError}
            />
            <FileDrop
              id="decay-cur-csv"
              label="Current Window CSV (e.g., Last 30 Days)"
              file={curFile}
              onFile={(f) => {
                setCurFile(f);
                setUploadError(null);
              }}
              onReject={setUploadError}
            />
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={uploading || !prevFile || !curFile}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {uploading ? "Analyzing..." : "Upload & Analyze Decay"}
            </button>
          </div>
        </form>

        {uploadError && (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            ⚠️ {uploadError}
          </p>
        )}
      </div>

      {mode === "sandbox" && sandboxLoading && <p className="p-4 text-sm text-slate-500">Analyzing content decay…</p>}
      {mode === "sandbox" && sandboxError && (
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {sandboxError}
        </p>
      )}
      {mode === "live" && liveLoading && <p className="p-4 text-sm text-slate-500">Analyzing your synced Search Console data…</p>}
      {mode === "live" && liveError && (
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {liveError}
        </p>
      )}
      {mode === "custom" && !custom && (
        <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
          No custom data yet. Choose both CSV files above and click “Upload &amp; Analyze Decay”.
        </p>
      )}

      {analysis && (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="decay-heading" className="text-base font-semibold text-slate-900">
              Content decay
            </h2>
            <span className="text-sm text-slate-500">
              {analysis.summary.decayed_count} of {analysis.summary.urls_analyzed} pages decayed ·{" "}
              {fmt.format(analysis.summary.impressions_lost)} impressions lost
            </span>
          </div>
          <p className="text-xs text-slate-400">
            {mode !== "sandbox" && analysis.source
              ? `${mode === "live" ? `Live Search Console (${liveLabel}): ` : "Your upload: "}${analysis.source.previous.filename} (${fmt.format(analysis.source.previous.rows)} rows) vs. ${analysis.source.current.filename} (${fmt.format(analysis.source.current.rows)} rows)${
                  analysis.source.previous.skipped + analysis.source.current.skipped > 0
                    ? `; ${analysis.source.previous.skipped + analysis.source.current.skipped} invalid rows skipped`
                    : ""
                }. `
              : "Sandbox data: previous 30 days vs. current 30 days. "}
            Flags pages with a &gt;20% impression or click loss and 500+ prior impressions.
          </p>

          {analysis.decayed.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
              No decayed pages detected.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-3">URL</th>
                    <th className="px-5 py-3 text-right">Impressions (prior → now)</th>
                    <th className="px-5 py-3 text-right">Click loss</th>
                    <th className="px-5 py-3 text-right">Position drift</th>
                    <th className="px-5 py-3">Severity</th>
                    <th className="px-5 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {analysis.decayed.map((row) => {
                    const state = briefs[row.url];
                    return (
                      <Fragment key={row.url}>
                        <tr>
                          <td className="max-w-xs truncate px-5 py-4 font-mono text-xs text-slate-800" title={row.url}>
                            {row.url}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 text-right tabular-nums text-slate-700">
                            {fmt.format(row.prior_impressions)} → {fmt.format(row.current_impressions)}{" "}
                            <span className="text-xs text-rose-600">(−{row.impressions_drop_pct}%)</span>
                          </td>
                          <td className="px-5 py-4 text-right tabular-nums text-rose-600">−{row.clicks_drop_pct}%</td>
                          <td className="px-5 py-4 text-right tabular-nums">
                            <PositionDrift change={row.position_change} />
                          </td>
                          <td className="px-5 py-4">
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${severityStyles[row.severity]}`}
                            >
                              {row.severity}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 text-right">
                            {state?.brief && (
                              <button
                                type="button"
                                onClick={() => toggle(row.url)}
                                className="mr-2 text-sm font-medium text-slate-600 hover:text-slate-900"
                              >
                                {state.open ? "Hide" : "Show"}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => generateBrief(row)}
                              disabled={state?.loading}
                              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60"
                            >
                              {state?.loading ? "Generating…" : state?.brief ? "🔄 Regenerate" : "🔄 Generate Refresh Brief"}
                            </button>
                          </td>
                        </tr>
                        {state && state.open && (state.brief || state.error || state.loading) && (
                          <tr className="bg-slate-50">
                            <td colSpan={6} className="px-5 py-4">
                              {state.error && (
                                <p role="alert" className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                                  {state.error}
                                </p>
                              )}
                              {state.loading && !state.brief && <p className="text-sm text-slate-500">Generating refresh brief…</p>}
                              {state.brief && (
                                <div className="max-h-[28rem] overflow-y-auto rounded-md border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-800">
                                  <ReactMarkdown components={markdownComponents}>{state.brief}</ReactMarkdown>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
