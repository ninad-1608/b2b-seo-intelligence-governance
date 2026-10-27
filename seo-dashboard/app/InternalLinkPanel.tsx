"use client";

import { useEffect, useState } from "react";
import { ScoreDisclaimer } from "./Guardrails";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

type TargetStatus = "orphan" | "under-linked" | "ok" | "unknown";

type Opportunity = {
  source_url: string;
  source_title: string;
  target_url: string;
  target_title: string;
  anchor_text: string;
  anchor_in_source: boolean;
  context_snippet: string;
  relevance_score: number;
  priority_score: number;
  target_inbound_links: number | null;
  target_status: TargetStatus;
  shared_topics: string[];
  reason: string;
};

type PageBrief = { url: string; title: string; inbound_links: number };

type Result = {
  source: "sandbox" | "upload";
  filename: string | null;
  summary: {
    pages_analyzed: number;
    opportunities: number;
    link_data_available: boolean;
    orphan_pages: PageBrief[];
    under_linked_pages: PageBrief[];
  };
  opportunities: Opportunity[];
};

type CopyKind = "md" | "html";

async function errorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
  return typeof detail === "string" ? detail : `Request failed (${res.status})`;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function markdownLink(o: Opportunity): string {
  const text = o.anchor_text.replace(/([[\]\\])/g, "\\$1");
  const href = o.target_url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${text}](${href})`;
}

function htmlLink(o: Opportunity): string {
  return `<a href="${escapeHtml(o.target_url)}">${escapeHtml(o.anchor_text)}</a>`;
}

const statusStyles: Record<TargetStatus, string | null> = {
  orphan: "bg-rose-50 text-rose-700 ring-rose-600/20",
  "under-linked": "bg-amber-50 text-amber-700 ring-amber-600/20",
  ok: null,
  unknown: null,
};

function priorityTone(score: number) {
  if (score >= 70) return "bg-emerald-500";
  if (score >= 50) return "bg-indigo-500";
  return "bg-slate-400";
}

/** Context sentence with the anchor phrase emphasised. */
function Context({ snippet, anchor }: { snippet: string; anchor: string }) {
  const i = snippet.toLowerCase().indexOf(anchor.toLowerCase());
  if (i === -1) return <>{snippet}</>;
  return (
    <>
      {snippet.slice(0, i)}
      <mark className="rounded bg-yellow-100 px-0.5 text-slate-800">{snippet.slice(i, i + anchor.length)}</mark>
      {snippet.slice(i + anchor.length)}
    </>
  );
}

export default function InternalLinkPanel() {
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [resetCount, setResetCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/internal-link-opportunities`, { signal: controller.signal });
        if (!res.ok) throw new Error(await errorMessage(res));
        setResult(await res.json());
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not reach the analysis API. Is the FastAPI server running?");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [resetCount]);

  function resetToSandbox() {
    setLoading(true);
    setError(null);
    setUploadError(null);
    setFile(null);
    setResetCount((n) => n + 1);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setUploadError("Please choose a page inventory CSV.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    const form = new FormData();
    form.append("inventory", file);
    try {
      const res = await fetch(`${API_URL}/api/v1/internal-link-opportunities`, { method: "POST", body: form });
      if (!res.ok) throw new Error(await errorMessage(res));
      setResult(await res.json());
      setError(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "An error occurred while uploading.");
    } finally {
      setUploading(false);
    }
  }

  async function copy(o: Opportunity, rowKey: string, kind: CopyKind) {
    try {
      await navigator.clipboard.writeText(kind === "md" ? markdownLink(o) : htmlLink(o));
      const id = `${rowKey}:${kind}`;
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      setCopied(null);
    }
  }

  return (
    <section aria-labelledby="links-heading" className="space-y-4">
      <ScoreDisclaimer />
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h2 id="links-heading" className="text-lg font-semibold text-slate-900">
              Internal Link Opportunities
            </h2>
            <p className="text-sm text-slate-500">
              Find relevant pages that should link to each other, and rescue orphaned or under-linked pages. Upload a page inventory CSV
              (<span className="font-mono text-xs">url</span>, <span className="font-mono text-xs">title</span>,{" "}
              <span className="font-mono text-xs">keywords</span>, <span className="font-mono text-xs">content</span>, optional{" "}
              <span className="font-mono text-xs">outlinks</span>) or use the sandbox site.
            </p>
          </div>
          <button
            type="button"
            onClick={resetToSandbox}
            className="shrink-0 rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200"
          >
            Reset to Sandbox Data
          </button>
        </div>

        <form onSubmit={handleUpload} className="mt-4 flex flex-col items-center gap-3 md:flex-row">
          <input
            type="file"
            accept=".csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setUploadError(null);
            }}
            className="block w-full cursor-pointer text-sm text-gray-500 file:mr-4 file:rounded-lg file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
          />
          <button
            type="submit"
            disabled={uploading || !file}
            className="w-full shrink-0 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50 md:w-auto"
          >
            {uploading ? "Analyzing..." : "Upload & Find Links"}
          </button>
        </form>
        {uploadError && (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            ⚠️ {uploadError}
          </p>
        )}
      </div>

      {loading && <p className="p-4 text-sm text-slate-500">Analyzing internal linking…</p>}
      {error && (
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </p>
      )}

      {result && !loading && (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            {[
              { label: "Pages analyzed", value: result.summary.pages_analyzed, accent: "text-slate-900" },
              { label: "Link opportunities", value: result.summary.opportunities, accent: "text-indigo-600" },
              {
                label: "Orphan pages",
                value: result.summary.link_data_available ? result.summary.orphan_pages.length : "—",
                accent: "text-rose-600",
              },
              {
                label: "Under-linked pages",
                value: result.summary.link_data_available ? result.summary.under_linked_pages.length : "—",
                accent: "text-amber-600",
              },
            ].map((m) => (
              <div key={m.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-sm font-medium text-slate-500">{m.label}</p>
                <p className={`mt-1 text-2xl font-semibold tracking-tight ${m.accent}`}>{m.value}</p>
              </div>
            ))}
          </div>

          <p className="text-xs text-slate-400">
            {result.source === "upload" ? `Your inventory: ${result.filename}. ` : "Sandbox site data. "}
            {result.summary.link_data_available
              ? "Orphan = 0 internal links in; under-linked = 1."
              : "No existing-link (outlinks) data was provided, so orphan detection is off and already-linked pairs may be suggested."}
          </p>

          {result.summary.orphan_pages.length > 0 && (
            <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-4">
              <p className="text-sm font-semibold text-rose-800">Orphaned pages (no internal links pointing to them)</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {result.summary.orphan_pages.map((p) => (
                  <li key={p.url} title={p.title} className="rounded-full bg-white px-2.5 py-1 font-mono text-xs text-rose-700 ring-1 ring-inset ring-rose-200">
                    {p.url}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.opportunities.length === 0 ? (
            <p className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
              No link opportunities found. Try adding more page content or keywords to the inventory.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Source page</th>
                    <th className="px-4 py-3">Target page</th>
                    <th className="px-4 py-3">Suggested anchor</th>
                    <th className="px-4 py-3 text-right">Relevance</th>
                    <th className="px-4 py-3">Priority</th>
                    <th className="px-4 py-3 text-right">Copy link</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 align-top">
                  {result.opportunities.map((o) => {
                    const rowKey = `${o.source_url}→${o.target_url}`;
                    const badge = statusStyles[o.target_status];
                    return (
                      <tr key={rowKey} className="hover:bg-slate-50/60">
                        <td className="max-w-[14rem] px-4 py-4">
                          <p className="truncate font-medium text-slate-900" title={o.source_title}>
                            {o.source_title}
                          </p>
                          <p className="truncate font-mono text-xs text-slate-500" title={o.source_url}>
                            {o.source_url}
                          </p>
                        </td>
                        <td className="max-w-[14rem] px-4 py-4">
                          <p className="truncate font-medium text-slate-900" title={o.target_title}>
                            {o.target_title}
                          </p>
                          <p className="truncate font-mono text-xs text-slate-500" title={o.target_url}>
                            {o.target_url}
                          </p>
                          {badge && (
                            <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${badge}`}>
                              {o.target_status}
                            </span>
                          )}
                        </td>
                        <td className="min-w-[16rem] px-4 py-4">
                          <p className="font-medium text-indigo-700">“{o.anchor_text}”</p>
                          {o.anchor_in_source ? (
                            <p className="mt-1 text-xs leading-relaxed text-slate-500">
                              <Context snippet={o.context_snippet} anchor={o.anchor_text} />
                            </p>
                          ) : (
                            <p className="mt-1 text-xs text-amber-700">Not in the source copy yet: add a sentence that uses this phrase.</p>
                          )}
                          <p className="mt-1 text-xs text-slate-400">{o.reason}</p>
                        </td>
                        <td className="px-4 py-4 text-right tabular-nums text-slate-700">{o.relevance_score}</td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-2">
                            <div
                              className="h-2 w-16 overflow-hidden rounded-full bg-slate-100"
                              role="progressbar"
                              aria-valuenow={o.priority_score}
                              aria-valuemin={0}
                              aria-valuemax={100}
                            >
                              <div className={`h-full rounded-full ${priorityTone(o.priority_score)}`} style={{ width: `${o.priority_score}%` }} />
                            </div>
                            <span className="w-7 font-semibold tabular-nums text-slate-900">{o.priority_score}</span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-4 text-right">
                          <div className="flex flex-col items-end gap-1.5">
                            {(["md", "html"] as const).map((kind) => (
                              <button
                                key={kind}
                                type="button"
                                onClick={() => copy(o, rowKey, kind)}
                                className="rounded bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
                              >
                                {copied === `${rowKey}:${kind}` ? "Copied ✓" : kind === "md" ? "Copy Markdown Link" : "Copy HTML Link"}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
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
